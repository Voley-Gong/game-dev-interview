---
title: "游戏匹配与房间服务器架构（Matchmaking & Lobby Server）如何设计？"
category: "network"
level: 3
tags: ["匹配系统", "房间服务器", "架构设计", "Lobby"]
related: ["network/server-authority-vs-client-trust", "network/reconnect-state-recovery"]
hint: "从玩家点击「匹配」到进入对局，中间的服务器架构是怎样流转的？"
---

## 参考答案

### ✅ 核心要点

1. **匹配服务器（Matchmaker）** 负责按 ELO/MMR 等规则将玩家分组
2. **大厅服务器（Lobby Server）** 管理房间生命周期（创建、加入、离开、准备）
3. **游戏服务器（Game Server）** 承载实际对局，由房间服务器通过分配服务启动或调度
4. **状态机驱动**：玩家状态在 Lobby → Matching → Room → InGame 之间流转
5. **水平扩展**：匹配服务无状态化，房间服务按 Shard 分片，游戏服务器按区域部署

### 📖 深度展开

#### 整体架构

```
玩家客户端
    │
    ├──► [Gateway / 路由层]  ← WebSocket 长连接，负载均衡
    │
    ├──► [Lobby Server]     ← 大厅/房间管理（有状态）
    │       ├── 创建房间
    │       ├── 邀请/匹配加入
    │       └── 准备/开始
    │
    ├──► [Matchmaker]        ← 匹配引擎（无状态，可水平扩展）
    │       ├── MMR/ELO 分段
    │       ├── 匹配队列（按模式/段位）
    │       └── 匹配算法（ widening window 策略）
    │
    └──► [Game Server Manager / Allocator]
            ├── 从空闲池中分配 Game Server 实例
            ├── 下发对局配置（地图、模式、玩家列表）
            └── 返回连接地址给客户端
                    │
                    ▼
              [Dedicated Game Server]  ← 实际战斗服
```

#### 匹配算法：Widening Window

最经典的匹配策略是**逐步放宽条件**：

```csharp
// 伪代码：匹配窗口随等待时间扩大
public class Matchmaker
{
    // 基础搜索范围
    const float BaseMMRRange = 100f;
    const float MaxMMRRange = 500f;
    const float WideningRate = 50f; // 每秒扩大

    public List<Player> TryMatch(List<Player> queue, float deltaTime)
    {
        foreach (var player in queue)
        {
            // 等待越久，范围越大
            float range = Math.Min(
                BaseMMRRange + player.WaitTime * WideningRate,
                MaxMMRRange
            );

            var candidates = queue
                .Where(p => p != player
                    && Math.Abs(p.MMR - player.MMR) <= range
                    && p.GameMode == player.GameMode)
                .ToList();

            if (candidates.Count >= RequiredPlayers - 1)
            {
                return new List<Player> { player }
                    .Concat(candidates.Take(RequiredPlayers - 1))
                    .ToList();
            }
        }
        return null;
    }
}
```

#### 房间状态机

```
[Created] → [Waiting] → [Ready] → [Loading] → [InGame] → [Finished]
     ↓          ↓          ↓
  [Destroyed] [Kicked]  [Left]
```

| 状态 | 含义 | 允许的操作 |
|------|------|-----------|
| Created | 房间刚创建 | 邀请玩家 |
| Waiting | 等待玩家加入 | 加入/离开 |
| Ready | 所有玩家准备 | 开始游戏 |
| Loading | 加载地图 | 等待加载完成 |
| InGame | 对局进行中 | 游戏逻辑 |
| Finished | 对局结束 | 回到大厅/解散 |

#### Game Server 分配策略

```
┌─────────────────────────────────────────────┐
│            Game Server Pool                  │
│                                              │
│  Region: Asia-East    Region: US-West       │
│  ┌─────────────────┐  ┌─────────────────┐   │
│  │ GS-1 [Idle]  ✓  │  │ GS-1 [Busy]     │   │
│  │ GS-2 [Busy]     │  │ GS-2 [Idle]  ✓  │   │
│  │ GS-3 [Idle]  ✓  │  │ GS-3 [Boot]     │   │
│  └─────────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────┘
```

分配流程：
1. Matchmaker 产出匹配结果 → 通知 Allocator
2. Allocator 从目标区域的空闲池中选一台 Game Server
3. 下发 Match Configuration（玩家列表、地图、规则）
4. Game Server 回报就绪状态 → 返回连接 IP:Port 给所有客户端
5. 客户端断开 Lobby 连接，连接 Game Server

#### 技术选型对比

| 组件 | 常见方案 | 特点 |
|------|---------|------|
| Lobby 通信 | WebSocket / TCP 长连接 | 低频高可靠 |
| 匹配引擎 | Redis Sorted Set + 轮询 | 高性能排序 |
| Game Server 调度 | Kubernetes / Agones | 容器化游戏服管理 |
| 服务发现 | Consul / etcd / Nacos | 动态注册与发现 |
| 跨服通信 | gRPC / NATS | 内部服务调用 |

> **Agones** 是 Google + Ubisoft 联合开源的游戏服务器托管方案，基于 Kubernetes，专门解决 Dedicated Game Server 的生命周期管理。

### ⚡ 实战经验

- **匹配服务的「惊群问题」**：多个 Matchmaker 实例同时抢同一个队列中的玩家，用 Redis 分布式锁或单消费者模式（如 Kafka 消费组）解决
- **房间服务要有「心跳超时清理」机制**：玩家异常断开后房间不能永久占用资源，通常 30-60s 无心跳自动回收
- **Game Server 预热池**：冷启动一台游戏服可能需要 10-30s，保持 2-3 台预热实例可以将匹配到进入的延迟从 30s 压到 3s 以内
- **跨区域匹配的延迟权衡**：严格同区域匹配可能等待过久，可以允许「次优区域」作为 fallback，但需要告知玩家可能的网络延迟

### 🔗 相关问题

- 断线重连时，如何判断玩家是「重连」还是「逃跑」？如何恢复房间状态？
- 大厅服务器如何做到水平扩展？分片策略是怎样的？
- Agones 相比自研 Game Server 调度方案有哪些优劣？
