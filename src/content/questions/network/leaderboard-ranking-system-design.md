---
title: "游戏全球排行榜（Leaderboard）的网络架构如何设计？Redis Sorted Set、分片策略与实时更新"
category: "network"
level: 3
tags: ["排行榜", "Redis", "Sorted Set", "分片", "高可用", "后端架构"]
related: ["network/game-server-microservices", "network/gateway-load-balancing"]
hint: "百万玩家实时排行榜，如何兼顾写入吞吐、读取延迟与数据一致性？"
---

## 参考答案

### ✅ 核心要点

1. **Redis Sorted Set（ZSET）是核心数据结构**：O(log N) 的插入与排名查询，天然适合排行榜场景
2. **读写分离 + 多级缓存**：写入走异步队列削峰，读取走 CDN/边缘缓存 + 本地缓存
3. **分片策略**：按分数段或按时间窗口分片，避免单个 ZSET 过大导致性能下降
4. **实时推送 vs 轮询**：WebSocket/SSE 推送 Top-N 变更，普通玩家用周期性轮询 + ETag 缓存
5. **防刷与公平性**：分数提交需服务端验证 + 频率限制，异常分数触发审计流程

### 📖 深度展开

#### 整体架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Game Client│────▶│  API Gateway │────▶│  Score Submit   │
│  (提交分数) │     │  (限流/鉴权) │     │  Service        │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                                           ┌───────▼───────┐
                                           │  Kafka / MQ   │
                                           │  (异步削峰)    │
                                           └───────┬───────┘
                                                   │
                    ┌──────────────────────────────▼──────────┐
                    │         Leaderboard Service              │
                    │  ┌─────────┐  ┌──────────┐  ┌────────┐ │
                    │  │ Redis   │  │ Redis    │  │ Redis  │ │
                    │  │ Master  │  │ Replica  │  │ Cache  │ │
                    │  │ (Write) │  │ (Read)   │  │(Top-N) │ │
                    │  └─────────┘  └──────────┘  └────────┘ │
                    └──────────────────────┬──────────────────┘
                                           │
                    ┌──────────────────────▼──────────────────┐
                    │         Push Service (WebSocket)        │
                    │    Top-N 变更实时推送到在线玩家          │
                    └─────────────────────────────────────────┘
```

#### Redis ZSET 核心操作

```python
import redis
import json
from datetime import datetime

class LeaderboardService:
    """基于 Redis ZSET 的排行榜服务"""
    
    def __init__(self, redis_client: redis.Redis):
        self.r = redis_client
        self.LEADERBOARD_KEY = "lb:global:season_7"
        self.TOPN_CACHE_KEY = "lb:global:season_7:top100"
        self.USER_RANK_CACHE_TTL = 60  # 用户排名缓存 60 秒
    
    def submit_score(self, user_id: str, score: int, 
                     metadata: dict = None) -> dict:
        """提交分数（经 MQ 异步调用）"""
        pipe = self.r.pipeline()
        
        # 1. 写入 ZSET
        member = user_id
        pipe.zadd(self.LEADERBOARD_KEY, {member: score})
        
        # 2. 记录分数变更日志（审计 + 防刷）
        log_entry = json.dumps({
            "user_id": user_id,
            "score": score,
            "ts": datetime.utcnow().isoformat(),
            **(metadata or {})
        })
        pipe.lpush(f"lb:log:{user_id}", log_entry)
        pipe.ltrim(f"lb:log:{user_id}", 0, 99)  # 保留最近100条
        
        # 3. 失效 Top-N 缓存（如果分数可能进入 Top 100）
        pipe.delete(self.TOPN_CACHE_KEY)
        
        pipe.execute()
        
        # 4. 获取当前排名
        rank = self.r.zrevrank(self.LEADERBOARD_KEY, member)
        return {"user_id": user_id, "score": score, "rank": rank + 1}
    
    def get_top_n(self, n: int = 100) -> list:
        """获取 Top-N（优先读缓存）"""
        # 缓存命中
        cached = self.r.get(self.TOPN_CACHE_KEY)
        if cached:
            return json.loads(cached)[:n]
        
        # 缓存未命中：从 ZSET 读取并回填
        results = self.r.zrevrange(
            self.LEADERBOARD_KEY, 0, n - 1, withscores=True
        )
        
        # 批量获取用户信息
        user_ids = [r[0].decode() for r in results]
        pipe = self.r.pipeline()
        for uid in user_ids:
            pipe.hgetall(f"user:{uid}")
        user_infos = pipe.execute()
        
        leaderboard = [
            {
                "rank": i + 1,
                "user_id": uid,
                "score": int(score),
                "name": info.get(b"name", b"").decode(),
                "avatar": info.get(b"avatar", b"").decode(),
            }
            for i, ((uid, score), info) in enumerate(
                zip(results, user_infos)
            )
        ]
        
        # 回填缓存，TTL 30 秒
        self.r.setex(self.TOPN_CACHE_KEY, 30, json.dumps(leaderboard))
        return leaderboard
    
    def get_around_rank(self, user_id: str, 
                        range_size: int = 10) -> list:
        """获取玩家附近排名（邻居排行榜）"""
        rank = self.r.zrevrank(self.LEADERBOARD_KEY, user_id)
        if rank is None:
            return []
        
        start = max(0, rank - range_size)
        end = rank + range_size
        
        results = self.r.zrevrange(
            self.LEADERBOARD_KEY, start, end, withscores=True
        )
        return [
            {"rank": start + i + 1, "user_id": r[0].decode(), 
             "score": int(r[1])}
            for i, r in enumerate(results)
        ]
```

#### 分片策略对比

| 策略 | 实现 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|----------|
| 不分片 | 单个 ZSET | 简单、排名精确 | 大规模性能下降 | < 100 万玩家 |
| 按分数段 | 多个 ZSET 按分数范围分 | 写入分散 | 跨段排名需合并 | 分段排行榜 |
| 按时间段 | 按日/周/月分 Key | 天然支持历史榜 | Key 数量多 | 赛季/周榜 |
| 一致性哈希 | 按 user_id hash 分片 | 写入均匀 | 全局排名需聚合 | 超大规模（千万级） |

#### 实时推送策略

```
                    ┌───────────────────┐
                    │  Leaderboard      │
                    │  Update Event     │
                    └────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐
     │ Top-100    │ │ 玩家邻居榜  │ │ 公会榜     │
     │ WebSocket  │ │ SSE Push   │ │ Polling    │
     │ 推送       │ │ 仅推送变更 │ │ 60秒轮询   │
     └────────────┘ └────────────┘ └────────────┘
```

- **Top-100 推送**：仅当 Top-100 内排名变动时推送给所有订阅者，频率限制 1 次/5 秒
- **邻居榜推送**：玩家 ±10 名发生变动时推送，个性化推送
- **全量缓存**：通过 CDN 边缘节点缓存 Top-1000 JSON，TTL 30 秒，降低中心化读取压力

#### 防刷机制

```python
def validate_score(self, user_id: str, score: int, 
                   game_session_id: str) -> bool:
    """服务端分数验证"""
    # 1. 频率检查：同一用户 60 秒内最多提交 3 次
    key = f"lb:rate:{user_id}"
    if self.r.incr(key) > 3:
        return False
    self.r.expire(key, 60)
    
    # 2. 分数合理性：与历史最高分比较
    best = self.r.zscore(self.LEADERBOARD_KEY, user_id) or 0
    if score > best * 3 and best > 0:
        # 异常涨幅，触发审计
        self.r.sadd("lb:audit:suspicious", 
                     f"{user_id}:{score}:{best}")
        return False
    
    # 3. 会话验证：确认 game_session_id 有效
    session = self.r.get(f"session:{game_session_id}")
    if not session:
        return False
    
    return True
```

### ⚡ 实战经验

- **Redis ZSET 在 500 万 member 以上时性能急剧下降**：ZADD/ZRANGEBYSCORE 从亚毫秒升到 10ms+。实践方案是按赛季定期归档，活跃榜控制在 200 万以内
- **「我的排名」是读放大杀手**：ZREVRANK 是 O(log N)，但百万级 QPS 下 Redis CPU 会打满。用本地缓存 + 短 TTL（30-60 秒）兜住 99% 的请求
- **赛季结算瞬间是写入洪峰**：赛季结束时大量玩家同时提交最终分数。必须用 Kafka/MQ 削峰 + 批量写入（Pipeline 每 100 条提交一次）
- **跨服排行榜的一致性窗口**：分布式部署时各 Region 的排行榜同步存在秒级延迟。对玩家展示时需标注"数据可能有短暂延迟"，竞技结算以主库为准

### 🔗 相关问题

- 匹配系统（Matchmaking）的 MMR/Elo 评分与排行榜分数系统如何整合？
- 如果 Redis 发生主从切换导致数据丢失，如何恢复排行榜数据？
- 百万级 DAU 的赛季结算，如何设计批量结算与奖励发放流程？
