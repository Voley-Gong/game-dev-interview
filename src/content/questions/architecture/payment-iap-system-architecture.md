---
title: "游戏的充值/IAP/支付系统架构怎么设计？如何保证支付安全、订单幂等和对账正确？"
category: "architecture"
level: 4
tags: ["支付系统", "IAP", "充值", "订单管理", "安全架构"]
related: ["architecture/shop-economy-system-architecture", "architecture/anti-cheat-architecture"]
hint: '不是"调一下平台支付 API 就完事"——是"订单生命周期 + 收据校验 + 发货幂等 + 对账兜底的完整闭环"'
---

## 参考答案

### ✅ 核心要点

1. **订单生命周期管理**：支付不是一步操作，而是一个完整的状态机：创建订单(Created) → 平台支付中(Pending) → 支付成功(Paid) → 发货中(Delivering) → 发货完成(Delivered) → 已关闭(Closed/Completed)，以及退款分支(Refunded)。每个状态转换必须持久化到数据库，任何一步崩溃（服务器宕机、网络中断）后都能从上次状态恢复，不会出现"付了钱没发货"或"发了货没收到钱"。

2. **收据验证(Receipt Validation)**：Apple App Store 和 Google Play 支付成功后返回的收据（receipt / purchase token）必须由**游戏服务端**向平台服务器发起验证，绝不能信任客户端上报的支付结果。伪造收据（本地破解后发送假的支付成功回调）是经典作弊手段，直接伪造可造成无限免费充值。

3. **发货幂等机制**：支付成功后的虚拟物品发放必须幂等——用 `orderId` 作为幂等键，无论发货流程被触发多少次（网络重试、崩溃恢复、玩家重复点击），同一笔订单只发放一次奖励。实现上用订单表的 `deliverStatus` 字段 + 数据库唯一约束保证，发货前先检查状态，发货后原子更新。

4. **服务端通知(S2S Notification)**：Apple/Google 提供 Server-to-Server 通知（Apple 的 App Store Server Notifications V2、Google 的 Real-time Developer Notifications），支付状态变更（退款、续订、家庭共享、撤销）会主动推送到游戏服务器 webhook。不能只依赖客户端轮询——玩家退款后可能不会再打开游戏，只有 S2S 通知能实时感知退款并回收已发放的道具。

5. **对账兜底与异常发现**：每日/每周将游戏订单库与平台结算报表（Apple Sales and Trends / Google Play Earnings Report）交叉对账，发现差异自动告警：平台有收入但游戏无对应订单（漏发货）、游戏有发货但平台无收入（多发货/被退款）、金额不一致。对账是支付系统的最后一道防线，能发现所有上游逻辑遗漏的问题。

### 📖 深度展开

#### 订单状态机与生命周期

订单是支付系统的核心实体，状态机定义了它的完整生命周期：

```typescript
enum OrderState {
  Created     = 1,  // 游戏服务端创建订单，等待客户端发起平台支付
  Pending     = 2,  // 客户端已调起平台支付，等待用户完成
  Paid        = 3,  // 平台返回支付成功，收据待验证
  Delivering  = 4,  // 收据验证通过，正在发放虚拟物品
  Delivered   = 5,  // 发货完成，订单正常关闭
  Failed      = 6,  // 支付失败或收据验证失败
  Refunded    = 7,  // 平台退款（S2S通知触发），需回收道具
  Cancelled   = 8,  // 用户主动取消支付
}

interface IAPOrder {
  orderId: string;          // 游戏内部订单号（幂等键）
  playerId: number;
  productId: string;        // 商品配置ID（如"gem_60"）
  platform: 'apple' | 'google' | 'huawei' | 'other';
  platformOrderId?: string; // 平台交易号（Apple transactionId / Google purchaseToken）
  state: OrderState;
  amount: number;           // 实付金额（分）
  currency: string;         // 货币代码 CNY/USD
  receipt?: string;         // 平台收据（base64编码）
  createdAt: number;
  paidAt?: number;
  deliveredAt?: number;
  retryCount: number;       // 发货重试次数
}
```

订单状态流转图：

```
[Created] ──客户端调起支付──> [Pending]
                                │
                    ┌──── 用户取消 ──> [Cancelled]
                    │
                    └──── 支付成功 ──> [Paid]
                                        │
                              收据验证  │
                    ┌──── 验证失败 ──────┤
                    │                   │
               [Failed]          验证通过│
                                        ↓
                                  [Delivering]
                                        │
                              发放物品  │
                    ┌──── 发货失败 ──────┤
                    │  (重试3次)        │
                    │                   │
                人工处理           发货成功│
                                        ↓
                                  [Delivered]
                                        │
                          S2S退款通知    │
                                        ↓
                                  [Refunded] ──> 回收道具/补偿
```

#### 收据验证与防伪架构

收据验证是支付安全的基石，必须在服务端完成：

```typescript
async function verifyAndDeliver(order: IAPOrder): Promise<DeliverResult> {
  // 1. 向平台服务器验证收据真伪（关键步骤！）
  const verification = await verifyReceiptWithPlatform(order);
  if (!verification.valid) {
    await updateOrderState(order.orderId, OrderState.Failed);
    return { success: false, reason: 'INVALID_RECEIPT' };
  }

  // 2. 校验金额和商品一致性（防篡改）
  if (verification.productId !== order.productId ||
      verification.amount !== order.amount) {
    await flagSuspiciousOrder(order);  // 标记可疑，人工审核
    return { success: false, reason: 'MISMATCH' };
  }

  // 3. 更新订单状态为 Paid → Delivering
  const updated = await casUpdateOrder(order.orderId, 
    { from: OrderState.Paid, to: OrderState.Delivering });
  if (!updated) {
    // CAS 失败说明订单状态已被其他线程/进程处理（幂等保护）
    return { success: true, reason: 'ALREADY_PROCESSING' };
  }

  // 4. 发放虚拟物品（幂等：用 orderId 防重复发放）
  await deliverItems(order, verification);

  // 5. 标记发货完成
  await updateOrderState(order.orderId, OrderState.Delivered);
  return { success: true };
}
```

各平台收据验证机制对比：

| 平台 | 收据格式 | 验证方式 | S2S通知 | 特殊处理 |
|------|----------|----------|---------|----------|
| Apple StoreKit 2 | JWS 签名 token | 服务端解析 JWT 验签 | App Store Server Notifications V2 | 订阅续订/家庭共享/退款 |
| Google Play Billing | purchaseToken | Google Play Developer API 验证 | RTDN (Pub/Sub) | 消耗型/非消耗型/订阅区分 |
| 华为 IAP | 签名数据 | 华为 PALM 服务端校验 | 通知服务 | 国内合规要求 |
| 微信/支付宝直充 | 支付回调签名 | 服务端验签 | 支付回调 webhook | 小游戏/H5 场景 |

#### 发货幂等与对账兜底

发货环节的幂等设计和对账机制是防止资损的最后两道防线：

```typescript
/** 幂等发货：同一 orderId 无论调用多少次，物品只发一次 */
async function deliverItems(order: IAPOrder, verification: ReceiptData) {
  const lockKey = `deliver:${order.orderId}`;
  
  // 分布式锁防并发（同一订单被多个消费者同时处理）
  const locked = await redis.set(lockKey, '1', 'NX', 'EX', 30);
  if (!locked) return; // 其他实例正在处理

  // 幂等检查：已发货则直接返回
  const existing = await getOrder(order.orderId);
  if (existing.state >= OrderState.Delivered) {
    await redis.del(lockKey);
    return;
  }

  // 发放物品（在同一数据库事务内更新订单状态 + 写入背包）
  await db.transaction(async (tx) => {
    const rewards = getProductRewards(order.productId);
    await grantRewards(tx, order.playerId, rewards, order.orderId); // orderId作为发放来源标识
    await tx.update('orders', { state: OrderState.Delivered, deliveredAt: Date.now() },
      { where: { orderId: order.orderId, state: OrderState.Delivering } }); // CAS条件更新
  });

  await redis.del(lockKey);
}
```

对账系统架构：

```
每日凌晨定时任务
       ↓
  拉取平台结算报表（Apple/Google API 或 TSV 文件）
       ↓
  ┌── 遍历平台交易记录 ──┐
  │                      │
  │  在游戏订单库查找     │
  │  对应的 platformOrderId│
  │                      │
  └──────────────────────┘
       ↓
  ┌─ 平台有 + 游戏有 → 金额一致？→ 不一致则告警
  ├─ 平台有 + 游戏无 → 漏单！玩家付了钱没发货 → 自动补发 + 告警
  ├─ 平台无 + 游戏有 → 多发！可能伪造收据或被退款 → 冻结账号 + 人工审核
  └─ 全部匹配 → 对账通过 ✓
       ↓
  生成对账报告 → 财务确认 → 归档
```

### ⚡ 实战经验

- **伪造收据教训**：某项目初期为了快速上线，客户端支付成功后直接上报结果、服务端直接发奖。上线 2 周后被破解，伪造支付回调无限充值 6480 钻石，月损失超百万。修复后增加服务端收据验证 + 金额一致性校验，伪造攻击归零。**铁律：任何支付结果都必须由服务端向平台二次验证。**
- **发货丢失事故**：玩家支付成功后服务端在写背包时恰好重启，订单卡在 `Delivering` 状态，物品未到账。客服投诉激增。增加补单定时任务：每分钟扫描 `Delivering` 状态超过 5 分钟的订单重新发货，玩家无感恢复。发货重试上限设 3 次，超限转人工处理。
- **退款回收延迟**：依赖客户端轮询检测退款，玩家退款后立即卸载游戏，道具无法回收。接入 Apple S2S Notification V2 后，退款事件在 5 秒内推送到服务端，自动执行道具回收逻辑。单月拦截恶意退款道具回收价值约 12 万元。
- **渠道对账差异**：第三方渠道（华为/小米/Oppo）结算报表延迟 48 小时，导致每日对账出现大量"平台无记录"的误报。调整策略：渠道订单 T+2 对账（等结算数据到位），Apple/Google T+1 对账。误报率从 15% 降到 0.3%。

### 🔗 相关问题

- 苹果 StoreKit 2 相比 StoreKit 1 在架构层面有哪些改进？服务端验证流程有何不同？
- 玩家反馈"充值了但没到账"，从架构层面你会如何排查和自动恢复？
- 订阅制商品（月卡/季卡）的续订、过期、跨设备恢复购买怎么设计？与一次性购买有何架构差异？
