---
title: "如何设计一个支持百万玩家、实时更新的排行榜系统？"
category: "architecture"
level: 3
tags: ["排行榜", "Redis", "系统设计", "Sorted Set", "架构设计"]
related: ["architecture/event-driven-vs-data-driven", "architecture/module-decoupling-bus-signal"]
hint: "排行榜的核心不是「排序」而是「在海量数据中快速取 Top N」——Redis Sorted Set + 分段缓存 + 异步刷新是标准答案。"
---

## 参考答案

### ✅ 核心要点

1. **核心数据结构**：Redis Sorted Set（ZSet），`score` 为分数、`member` 为玩家 ID，天然有序、O(logN) 插入/查询
2. **取 Top N 极快**：`ZREVRANGE` 取前 N 名 O(logN+M)，无需全量排序
3. **查个人排名**：`ZREVRANK` 直接拿名次 O(logN)，避免遍历
4. **分层缓存策略**：Redis 热数据 + DB 冷数据 + 内存缓存 Top100（读多写少场景）
5. **赛季/周期刷新**：定时快照 + 季末归档 + 赛季重置，保证排行榜有「新鲜感」

### 📖 深度展开

**整体架构：**

```
玩家积分变动
  ↓ 异步写入
Redis ZSet (global_rank)
  ├── member: playerId
  └── score: 总积分
  ↓ 定时快照（每5分钟）
MySQL rank_snapshot（持久化/归档）
  ↓ 缓存预热
内存缓存（Top100 列表，TTL 30s）
  ↓ API 响应
客户端（分页拉取 / 个人排名 / 附近的人）
```

**Redis Sorted Set 核心操作：**

```bash
# 写入/更新分数（玩家 1001 积分变为 8500）
ZADD global_rank 8500 "player:1001"

# 获取全服 Top 100（分数从高到低）
ZREVRANGE global_rank 0 99 WITHSCORES

# 获取个人排名（0 = 第一名）
ZREVRANK global_rank "player:1001"

# 获取个人分数
ZSCORE global_rank "player:1001"

# 获取「附近的人」（排名±50，社交激励）
ZREVRANGE global_rank <start> <end> WITHSCORES
```

**游戏客户端排行榜管理器（TypeScript）：**

```typescript
class LeaderboardService {
  private topCache: RankEntry[] = [];
  private cacheExpireAt = 0;
  private readonly CACHE_TTL = 30_000; // 30秒缓存

  // 拉取 Top 100（带缓存）
  async fetchTop100(): Promise<RankEntry[]> {
    if (Date.now() < this.cacheExpireAt && this.topCache.length > 0)
      return this.topCache;
    const data = await http.get('/rank/top', { limit: 100 });
    this.topCache = data.list;
    this.cacheExpireAt = Date.now() + this.CACHE_TTL;
    return this.topCache;
  }

  // 拉取个人排名 + 前后各 20 名（「超越你 / 被超越」激励）
  async fetchAroundMe(playerId: string): Promise<{
    myRank: number; myScore: number; neighbors: RankEntry[];
  }> {
    return http.get('/rank/around', { playerId, span: 20 });
  }
}
```

**不同排行榜方案对比：**

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| Redis ZSet | 实时、快、原生有序 | 内存成本、全量在内存 | 百万级以下 |
| DB ORDER BY | 简单、无额外组件 | 全表排序极慢 | 小游戏/低频 |
| 分桶 + 预聚合 | 可扩展到亿级 | 非实时、架构复杂 | 超大服/全平台 |
| 桶排 + 定时刷 | 读极快 | 有延迟、非精确 | 赛季结算排行 |

**百万人级优化：分桶 + 近似排名：**

```
精确 ZSet 适合百万以下。更大规模：

  分桶（Bucket）策略：
  bucket_0: score [9000, 9999]  → ZSet
  bucket_1: score [8000, 8999]  → ZSet
  bucket_2: score [7000, 7999]  → ZSet
  ...

  查询个人排名 = 该桶内排名 + 所有更高桶的总人数
  → 近似排名，误差 ≤ 一个桶的人数，但 O(log(桶大小))

  定时（5分钟）把各桶 Top N 汇总成全局 Top100 缓存
```

**赛季重置与归档：**

```
赛季结束 → 快照当前 ZSet 到 MySQL rank_history_{seasonId}
         → ZSet 清零或按规则衰减（保留 70% 积分）
         → 发放赛季奖励（按快照排名）
         → 新赛季开启
```

### ⚡ 实战经验

- **别用 DB 做实时排行**：百万玩家的 `SELECT ... ORDER BY score LIMIT 100` 即使有索引也扛不住高频查询；Redis ZSet 才是标准答案
- **防并发刷分**：积分更新用 `ZINCRBY` 原子操作而非「读-改-写」，否则并发下排名会错乱
- **缓存 TTL 别太长**：排行榜延迟 30 秒玩家能接受，延迟 10 分钟会被吐槽「假的」；Top100 内存缓存 + 短 TTL 是性价比最高的方案
- **同分排序要有 tie-breaker**：分数相同时按「先达到该分数的人排名靠前」或玩家 ID 排序——Redis 中用 `score = 真实分数 * 1e10 + (MAX - timestamp)` 编码即可
- **赛季重置要有衰减而非清零**：全清零会让老玩家觉得「白玩了」，保留部分积分（如 50%）既有新鲜感又不伤感情

### 🔗 相关问题

- 如何实现「好友排行榜」和「公会排行榜」？数据量更大时怎么优化？
- 排行榜数据如何做冷热分离和归档？
- 如果 Redis 宕机，排行榜如何降级保证可用性？
