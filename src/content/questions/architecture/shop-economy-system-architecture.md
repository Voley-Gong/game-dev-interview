---
title: "游戏商店与经济系统架构怎么设计？怎么保证交易安全和经济平衡？"
category: "architecture"
level: 4
tags: ["商店系统", "经济系统", "架构设计", "事务安全", "货币体系", "定价模型", "防作弊"]
related: ["architecture/save-system-architecture", "architecture/network-sync-architecture", "architecture/config-driven-architecture"]
hint: "不是「写一个购买函数扣金币加道具」——是「把交易建模成事务（预扣款→校验→发放→确认/回滚），用配置驱动定价/折扣/限购，服务器权威保证经济不崩溃」。"
---

## 参考答案

### ✅ 核心要点

1. **交易必须建模为事务而非单步操作**：购买不是「扣钱 + 给道具」两行代码，而是一个事务：预扣款 → 校验库存/限购 → 发放奖励 → 确认提交（任一步失败则全部回滚）。不做事务，网络中断或并发购买会导致「钱扣了道具没发」或「道具发了钱没扣」，直接引发客诉和资损。
2. **服务器权威是经济安全的底线**：客户端永远不能直接修改货币余额和库存数据，所有交易必须由服务器校验并原子提交。客户端作弊修改本地金币是无效的——服务器才是唯一的真理之源（source of truth），客户端只负责展示服务器下发的结果。
3. **货币要多层级管理**：免费货币（金币，游戏内产出）、付费货币（钻石，充值获得）、绑定货币（活动代币，限时获取）。不同货币有不同的产出/消耗/兑换规则和防作弊等级，架构上用 CurrencyType 枚举区分 + 独立账户隔离，严禁不同货币余额混算。
4. **定价与促销要配置驱动**：商品价格、折扣力度、限购次数、捆绑礼包、限时活动都不能硬编码在代码里。用 ShopItem 配置表定义 basePrice/currencyType/discount/buyLimit/refreshPeriod，运营在后台改价格即时生效无需发版——硬编码意味着每次促销活动都要程序排期发版。
5. **商品类目要支持多种交易模型**：直购（一口价买道具）、兑换（碎片换整装）、抽奖（概率产出）、礼包（捆绑优惠）、订阅（月卡每日领取）。不同模型有不同的结算流程，用策略模式抽象 TransactionHandler，新增交易模型不修改核心结算代码（开闭原则）。
6. **经济监控与防作弊是架构的一部分**：要实时监控全服货币产出/消耗流水、异常交易（短时间内大量购买、价格异常偏低）、通货膨胀指标（金币总量增速 vs 消耗速率）。日志 + 风控规则引擎自动告警，发现异常自动冻结账号，不是事后人工排查。

### 📖 深度展开

#### 1. 交易事务流程

购买是事务而非单步操作。核心思路是「先冻结货币（预扣款），再校验与发放，最后确认提交或回滚」，保证任一步失败都不会产生脏数据。

```
Client                Server
  | --- 购买请求 -----> |
  |                     |--> freezeCurrency(预扣款, 写入冻结金额)
  |                     |--> checkStock(校验库存+限购)
  |                     |       |-- 失败? --> unfreeze(回滚) --> 返回错误 --+
  |                     |--> grantItems(发放道具到背包)                      |
  |                     |       |-- 失败? --> unfreeze(回滚) --> 返回错误 --+
  |                     |--> commit(deduct frozen, 扣减正式余额)            |
  | <--- 结果/道具 ----- |
```

```typescript
async function purchaseTransaction(playerId: string, itemId: string): Promise<Receipt> {
  const tx = await txStore.begin(playerId);
  try {
    await account.freezeCurrency(playerId, currency, price); // 预扣款
    await inventory.checkStock(playerId, itemId);            // 校验库存/限购
    await inventory.grantItems(playerId, rewards);           // 发放奖励
    await account.commitDeduct(playerId, tx.id);             // 确认: 冻结->扣减
    await txStore.commit(tx.id);
    return { ok: true, rewards };
  } catch (err) {
    await txStore.rollback(tx.id);                           // 全量回滚
    await account.unfreeze(playerId, tx.id);                 // 解冻返还
    return { ok: false, error: err };
  }
}
```

| 事务步骤 | 操作 | 失败后果 | 回滚动作 |
| --- | --- | --- | --- |
| 预扣款(freeze) | 余额移入冻结区 | 余额被锁死，无法购买 | 解冻返还 available |
| 校验库存 | 查库存 + 限购计数 | 卖出超限/缺货道具 | 仅解冻，无需撤销发放 |
| 发放道具 | 写入背包/邮件 | 道具丢失引发客诉 | 解冻 + 撤销已写背包条目 |
| 确认提交 | 冻结额转为正式扣减 | 双花 / 余额不准 | 整笔事务回滚到初始态 |
| 回滚 | 撤销本事务所有写操作 | 未回滚则脏数据残留 | 幂等执行，可重复安全调用 |

#### 2. 货币账户架构

多种货币必须隔离账户，且要把「可用余额（available）」与「冻结余额（frozen）」分开，预扣款只动 frozen，提交时才落正式扣减。

```typescript
enum CurrencyType { Gold, Diamond, Bond, EventToken }

class CurrencyAccount {
  private available: Record<CurrencyType, bigint> = {} as any;
  private frozen: Record<CurrencyType, bigint> = {} as any;

  freeze(type: CurrencyType, amount: bigint): void {
    if (this.available[type] < amount) throw new InsufficientError(type);
    this.available[type] -= amount;
    this.frozen[type] += amount;            // 冻结区独立记账
  }

  commitDeduct(type: CurrencyType, amount: bigint): void {
    this.frozen[type] -= amount;            // 冻结->正式扣减
  }

  refund(type: CurrencyType, amount: bigint): void {
    this.frozen[type] -= amount;
    this.available[type] += amount;         // 解冻退回可用
  }
}
```

| 货币类型 | 来源 | 防作弊等级 | 可否交易 | 是否参与对账 |
| --- | --- | --- | --- | --- |
| 金币(免费) | 游戏内打怪/任务 | 中（防自刷产出） | 否 | 是 |
| 钻石(付费) | 充值 | 最高（涉及真实金钱） | 否 | 是，与支付渠道核对 |
| 绑定代币(活动) | 限时活动 | 高 | 否 | 是，活动结算对账 |
| 荣誉点(PvP) | 竞技场奖励 | 中 | 否 | 是 |

#### 3. 配置驱动的商品定义

商品价格、折扣、限购、刷新周期全部进配置表，运营改后台即可热更生效，绝不在代码里写死价格。

```typescript
interface ShopItem {
  id: string;
  name: string;
  price: number;                 // 以最小货币单位(分)存
  currencyType: CurrencyType;
  discount: number;              // 1.0 原价, 0.8 八折
  buyLimit: number;              // 0=不限购
  refreshPeriod: 'daily' | 'weekly' | 'never';
  rewardItems: { itemId: string; count: number }[];
  transactionType: 'direct' | 'exchange' | 'gacha' | 'bundle';
}
```

```json
[
  { "id": "sword_001", "name": "烈焰之剑", "price": 99900, "currencyType": 1,
    "discount": 1.0, "buyLimit": 0, "refreshPeriod": "never",
    "rewardItems": [{ "itemId": "sword_001", "count": 1 }], "transactionType": "direct" },
  { "id": "bundle_summer", "name": "夏日礼包", "price": 48000, "currencyType": 1,
    "discount": 0.8, "buyLimit": 3, "refreshPeriod": "daily",
    "rewardItems": [{ "itemId": "gem_pack", "count": 5 }, { "itemId": "potion_l", "count": 10 }],
    "transactionType": "bundle" }
]
```

| 促销规则类型 | 配置字段 | 生效方式 | 运营成本 |
| --- | --- | --- | --- |
| 固定折扣 | discount | 改配置即时生效 | 极低 |
| 阶梯满减 | tierRules[] | 后台改规则即时生效 | 低 |
| 限时秒杀 | startTime/endTime | 定时器到点切换 | 中（需排期） |
| 限购次数 | buyLimit/refreshPeriod | 原子计数即时生效 | 低 |
| 捆绑礼包 | rewardItems[]/bundlePrice | 改配置即时生效 | 低 |

#### 4. 交易模型策略模式

直购、兑换、抽奖、礼包、订阅的结算流程差异很大。用策略模式把每种交易抽象成 `TransactionHandler`，新增交易模型只加 handler，不改 `ShopService` 核心（开闭原则）。

```typescript
interface TransactionHandler {
  canHandle(type: string): boolean;
  execute(ctx: TxContext): Promise<Receipt>;
}

class DirectPurchaseHandler implements TransactionHandler {
  canHandle(t: string) { return t === 'direct'; }
  async execute(ctx: TxContext) { return purchaseTransaction(ctx); }
}
class ExchangeHandler implements TransactionHandler {
  canHandle(t: string) { return t === 'exchange'; }
  async execute(ctx: TxContext) { return exchangeByShards(ctx); }
}
class GachaHandler implements TransactionHandler {
  canHandle(t: string) { return t === 'gacha'; }
  async execute(ctx: TxContext) { return rollGachaWithPity(ctx); }
}
class BundleHandler implements TransactionHandler {
  canHandle(t: string) { return t === 'bundle'; }
  async execute(ctx: TxContext) { return grantBundleItems(ctx); }
}

class ShopService {
  constructor(private handlers: TransactionHandler[]) {}
  async processTransaction(ctx: TxContext): Promise<Receipt> {
    const handler = this.handlers.find(h => h.canHandle(ctx.type));
    if (!handler) throw new UnknownTxTypeError(ctx.type);
    return handler.execute(ctx);   // 统一调度，核心逻辑不随交易类型膨胀
  }
}
```

| 交易模型 | 结算流程 | 概率/确定性 | 退款政策 | 典型场景 |
| --- | --- | --- | --- | --- |
| 直购 | 扣款->发道具 | 确定性产出 | 一般不退款 | 商城买装备 |
| 兑换 | 消耗碎片->合成 | 确定性产出 | 不退款 | 碎片换整装 |
| 抽奖(盲盒) | 扣款->概率摇奖 | 概率产出+保底 | 受监管限制 | 抽卡/开箱 |
| 礼包捆绑 | 一次扣款->多道具 | 确定性产出 | 整包退或不退 | 节日礼包 |
| 订阅月卡 | 扣款->每日签到发奖 | 定时确定性 | 按剩余天数 | 月卡/通行证 |

### ⚡ 实战经验

1. **没做事务回滚直接引发资损客诉**：某游戏购买接口先扣款再发道具，网络中断导致「钱扣了道具没发」，上线首月客诉每天 50+ 单。改成「预扣款→发放→确认」事务模型后，异常率从 0.3% 降到 0.001%，客诉归零。
2. **客户端算价格等于送钱给破解者**：某游戏折扣价在客户端本地计算（`finalPrice = basePrice * 0.5`），被逆向破解后改成 0.5 折（即原价 1%），1 钻石买到了原价 999 钻石的礼包。改为服务器权威定价后彻底杜绝。
3. **限购没做原子计数导致突破上限**：某限时商品限购 3 次，计数用「先查 count 再 +1」的非原子操作，高并发下两个请求同时读到 count=2 都通过校验，实际卖出了 4 次。改用 Redis 原子 INCR + 事务后，突破上限率从 0.5% 降到 0。
4. **货币用浮点数存储导致对账不平**：钻石余额用 float 存储，累计大量小额交易后浮点误差积累，月底对账差额几千钻石。改用整数（以「分」为单位存 long）后对账误差为 0。规则：货币金额永远用整数，绝不用 float/double。
5. **促销配置热更没刷缓存玩家看到旧价**：运营在后台把商品从 100 钻石改成 80 钻石，但客户端缓存了 ShopItem 配置没刷新，部分玩家看到旧价 100 点击购买后服务器按新价 80 扣款，引发「价格不一致」投诉。引入配置版本号 + 客户端拉取时校验版本后解决。

### 🔗 相关问题

- 抽奖（盲盒）系统的概率配置怎么做到可审计、可向监管证明合规？（保底机制、概率公示、日志留存）
- 全服经济出现通货膨胀（金币贬值）时，架构上有哪些调控手段？（回收机制、产出上限、动态定价）
- 跨服交易或玩家间交易（拍卖行）引入后，经济系统架构需要做哪些扩展？（分布式事务、一致性、防洗钱）
