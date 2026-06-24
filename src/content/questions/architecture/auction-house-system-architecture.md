---
title: "游戏拍卖行/交易行系统架构怎么设计？如何支撑海量商品检索、撮合交易和价格稳定？"
category: "architecture"
level: 4
tags: ["拍卖行", "交易系统", "撮合引擎", "防超卖", "经济系统"]
related: ["architecture/shop-economy-system-architecture", "architecture/mail-system-architecture", "architecture/inventory-system-architecture"]
hint: "不是简单的「上架-搜索-购买」——是「订单簿撮合 + 分布式锁防超卖 + 倒排索引检索 + 价格历史聚合与反炒作」"
---

## 参考答案

### ✅ 核心要点

1. **订单簿撮合模型**：拍卖行不是即时买卖，而是撮合一买一卖两个订单。买卖盘按「价格优先、时间优先」组成订单簿（Order Book），同一商品标的可同时支持一口价、竞价、限价单三类交易模式；撮合引擎是核心热点路径，必须做到毫秒级。
2. **分布式锁防超卖**：同一商品可能被数十个买家同时点击「购买」，必须用乐观锁（version 字段）或 Redis 原子 Lua 脚本保护「查询余量→扣减余量→发放物品」的事务，否则会出现「一件装备卖给两个人」的复制 Bug，直接摧毁经济系统信任。
3. **分库分表 + 倒排索引的检索架构**：百万级在售商品不能用单表扫描。按品类分库、按属性（等级/品质/职业）建倒排索引（Elasticsearch/Lucene），内存层做热销品 LRU 缓存，将搜索响应从秒级压到 50ms 以内，否则玩家会因「搜索转圈」流失。
4. **价格历史与反炒作监控**：每笔成交记录入库做时间序列聚合，生成 K 线/均价给玩家参考；同时这套数据是反刷监控的金矿——短时大量挂单拉抬、自买自卖洗盘、跨服套利，都能从价格波动 + 账号关联分析中识别。
5. **异步结算与幂等到账**：撮合成功后，金币扣减、物品发放走异步队列 + 幂等键（tradeId），避免同步阻塞玩家操作；失败走补偿事务，超时未到账由对账任务兜底扫描，保证最终一致性。

### 📖 深度展开

#### 一、订单簿撮合引擎

拍卖行的核心是撮合一买一卖两个订单。买卖盘按价格优先、时间优先排队，撮合引擎从对手盘取最优单成交：

```typescript
interface Order {
  orderId: string;
  itemId: number;
  side: 'buy' | 'sell';      // 买盘 / 卖盘
  price: number;              // 限价单价（一口价时=售价）
  quantity: number;           // 剩余数量
  playerId: string;
  timestamp: number;          // 时间优先排序键
  type: 'fixed' | 'bid' | 'limit';  // 一口价/竞价/限价
}

class OrderBook {
  private bids: Order[] = [];  // 买盘：价格降序 + 时间升序
  private asks: Order[] = [];  // 卖盘：价格升序 + 时间升序

  /** 撮合一笔新订单，返回成交记录 */
  match incoming order against opposite side
  match(order: Order): Trade[] {
    const opposite = order.side === 'buy' ? this.asks : this.bids;
    const trades: Trade[] = [];
    while (order.quantity > 0 && opposite.length > 0) {
      const best = opposite[0];
      // 价格优先：买单价 >= 卖单价 才成交（限价单）
      const canMatch = order.type === 'fixed' || order.side === 'buy'
        ? order.price >= best.price : order.price <= best.price;
      if (!canMatch) break;
      const fillQty = Math.min(order.quantity, best.quantity);
      trades.push({ buyOrderId, sellOrderId, price: best.price, quantity: fillQty });
      order.quantity -= fillQty;
      best.quantity -= fillQty;
      if (best.quantity === 0) opposite.shift();
    }
    if (order.quantity > 0) this.insertRemaining(order);
    return trades;
  }
}
```

| 交易模式 | 撮合规则 | 适用场景 | 实现复杂度 |
|---------|---------|---------|-----------|
| 一口价（Fixed） | 买方按卖方挂单价直接全量成交 | 普通道具、消耗品 | 低 |
| 竞价（Bid/Auction） | 到期时最高价中标，或即时超价成交 | 稀有装备、限量坐骑 | 高（需定时结算） |
| 限价单（Limit） | 价格优先 + 时间优先，部分成交 | 高频交易品类、原材料 | 中 |

#### 二、防超卖的三种事务方案

「查询余量→扣减→发放」三步走，在并发下极易超卖。三种主流方案的取舍：

```typescript
// 方案 A：乐观锁（version 字段）——适合低冲突场景
async function buyWithOptimisticLock(orderId: string, qty: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await db.query('SELECT id, quantity, version FROM orders WHERE id = ?', [orderId]);
    if (order.quantity < qty) throw new Error('库存不足');
    const affected = await db.execute(
      'UPDATE orders SET quantity = quantity - ?, version = version + 1 WHERE id = ? AND version = ?',
      [qty, orderId, order.version]
    );
    if (affected === 1) return grantItem(orderId, qty);  // 成功
    // version 不匹配 → 重试
  }
  throw new Error('并发冲突，请重试');
}

// 方案 B：Redis Lua 原子扣减 ——适合高冲突热点
const DEDUCT_LUA = `
  local remain = redis.call('GET', KEYS[1])
  if tonumber(remain) < tonumber(ARGV[1]) then return 0 end
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 1
`;
const ok = await redis.eval(DEDUCT_LUA, ['stock:order:' + orderId], [qty]);
if (ok === 1) await grantItem(orderId, qty);
else throw new Error('库存不足');
```

| 方案 | 一致性 | 性能 | 复杂度 | 适用场景 |
|------|-------|------|-------|---------|
| 乐观锁（version 重试） | 强一致 | 中（冲突时回退重试） | 低 | 普通商品、冲突率<5% |
| 悲观锁（SELECT FOR UPDATE） | 强一致 | 低（行锁阻塞） | 低 | 稀有装备、强冲突 |
| Redis Lua 原子操作 | 强一致 | 极高（0.3ms 级） | 中 | 热销品、秒杀级并发 |

#### 三、检索与价格聚合架构

百万级商品的检索必须分层：分库分表 + 倒排索引 + 内存热缓存。成交价聚合走独立的时序通道：

```
玩家搜索请求
   │
   ▼
┌─────────────────────────────────┐
│  L1: Redis 热销品 LRU 缓存       │  ← Top100 品类，命中率 70%+，<5ms
│  (key: category:keyword)        │
└────────────┬────────────────────┘
             │ miss
             ▼
┌─────────────────────────────────┐
│  L2: Elasticsearch 倒排索引      │  ← 按品质/等级/职业多维过滤，<60ms
│  (按品类分 index)                │
└────────────┬────────────────────┘
             │ miss / 兜底
             ▼
┌─────────────────────────────────┐
│  L3: MySQL 分库分表（按品类分库） │  ← 准确数据源，<300ms
│  (shard by category_id)         │
└─────────────────────────────────┘

成交价聚合（独立异步通道）：
trade_log → Kafka → Flink 窗口聚合 → K线/均价表 → 玩家查询
                                → 反刷监控（同IP/账号关联分析）
```

### ⚡ 实战经验

1. **Lua 原子撮合 vs 数据库行锁的性能差距**：单服 QPS 500 的撮合引擎，把「SELECT 余量 + UPDATE 扣减」改成 Redis Lua 原子脚本后，单笔撮合从 8ms 压到 0.3ms，快了约 25 倍，热销品秒杀不再卡服。
2. **超卖事故复盘**：早期用「SELECT 余量 → UPDATE 扣减」两步走，在并发 100 请求下出现 2 个玩家同时买到同一件 +15 传说武器，事后回滚 + 全服补偿；引入 Redis Lua 原子扣减后超卖归零。
3. **搜索 P99 从 1.2s 降到 60ms**：从 MySQL 全表 LIKE 扫描换到 ES 倒排索引 + Redis 热销 Top100 缓存后，搜索 P99 从 1200ms 降到 60ms，因「搜索转圈退出」的玩家流失率下降约 30%。
4. **自买自卖洗盘检测**：上线「同一账号 30 分钟内对同一 itemId 买卖超过 5 次」+「价格偏离均值 200% 以上」双重告警规则后，一周内抓到 23 个刷价工作室账号，成交价曲线回归正常波动。
5. **挂单过期退款一致性**：玩家挂单后下线，订单 24 小时未成交自动过期，退款走异步队列 + 幂等键（orderId）；曾因退款队列堆积导致 2000 玩家 4 小时未收到退款金币，引入对账兜底任务（每小时扫描未结算订单）后 SLA 恢复。

### 🔗 相关问题

- 拍卖行的手续费怎么设计才能既回收金币（经济通缩）又不会被工作室套利搬砖？
- 如果要做「全服统一拍卖行」（跨服交易），架构上需要做哪些改造？跨服数据一致性如何保证？
- 竞价模式（拍卖到期最高价中标）的定时结算怎么设计才不会在结算峰值卡服？到期未支付的订单如何处理？
