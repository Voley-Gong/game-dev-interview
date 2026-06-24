---
title: "多人游戏的房间、匹配与会话管理架构怎么设计？高并发下如何保证一致性？"
category: "architecture"
level: 4
tags: ["房间系统", "匹配系统", "会话管理", "分布式", "状态机", "架构设计"]
related: ["architecture/network-sync-architecture", "architecture/server-client-architecture-consistency", "architecture/fsm-behavior-tree"]
hint: "匹配不是'按战力排个序'，房间不是'开个字典存玩家ID'——高并发下房间状态机的一致性、匹配池的分布式分片、断线重连的会话恢复，每个都是上线后才暴露的难题。"
---

## 参考答案

### ✅ 核心要点

1. **三者是不同层次的概念**：**匹配（Matchmaking）** 负责把合适的玩家凑到一起，是"找人对"的过程；**房间（Room）** 是一局对战的逻辑容器，承载玩家列表、队伍、准备状态、游戏配置；**会话（Session）** 是玩家与房间之间的连接绑定，管断线重连和身份验证。三者生命周期不同，必须分开建模。
2. **匹配的核心是匹配池 + 评分函数**：玩家进入匹配池后，用评分函数（MMR/ELO/战力差+等待时间宽松化）计算匹配度，定期从池中选出"最合适的一组"撮合成房间。关键设计：等待越久匹配条件越宽松（expanding range），避免高战力玩家永远等不到对手。
3. **房间是显式状态机**：`空闲 → 准备中 → 加载中 → 战斗中 → 结算中 → 销毁`，每个状态有严格的合法转换。状态变更必须原子化（分布式锁或单线程顺序处理），防止"两个玩家同时点准备"导致的竞态。房间服务器（Room Server）是无状态的游戏逻辑执行者，房间元数据存在中心化的房间管理服务。
4. **会话管理的核心是断线重连**：玩家断线时会话进入"挂起"状态（保留座位 N 秒），重连后凭会话票据恢复到原房间，而非重新匹配。这要求房间状态在服务端持久化、连接层与逻辑层解耦（连接断了游戏逻辑继续跑，玩家变成 AI 接管或暂停）。
5. **高并发的关键是分片与无状态**：匹配池按段位/模式分片到多个匹配节点并行处理；房间分布到多个 Room Server，由大厅服务做负载均衡路由。单点中心化（一个全局房间表）会成为瓶颈和单点故障，必须水平拆分。

### 📖 深度展开

**匹配 → 房间 → 会话的整体流程：**

```
玩家点击"开始匹配"
  ↓
[匹配池] ── 评分函数定期撮合 ──▶ 创建房间
  │                              ↓
  │                         [房间状态机]
  │                         空闲→准备中→加载中→战斗中→结算→销毁
  │                              ↑
  └─ 等待超时/取消 ◀──────────── 会话绑定
                                 │
                            [会话管理]
                            玩家↔房间的连接绑定
                            断线→挂起(N秒)→重连恢复 / 超时→踢出

分布式部署：
  LobbyServer(大厅) ──路由──▶ MatchNode×N(匹配分片)
                            RoomServer×N(房间执行器)
                            SessionService(会话/票据)
```

**房间状态机实现：**

```csharp
public enum RoomState { Idle, Waiting, Loading, Battling, Settling, Destroyed }

public class Room {
    public string RoomId { get; }
    public RoomState State { get; private set; }
    public List<PlayerSlot> Slots { get; } = new();
    public int MaxPlayers;

    // 状态转换必须是原子的，防止并发竞态
    private readonly object _lock = new();

    public bool Transition(RoomState next) {
        lock (_lock) {   // 或用分布式锁/单线程 Actor 模型
            if (!IsValidTransition(State, next)) {
                Logger.Warn($"非法转换 {State}→{next}");
                return false;
            }
            State = next;
            OnStateChanged?.Invoke(next);   // 通知所有玩家
            return true;
        }
    }

    private static bool IsValidTransition(RoomState from, RoomState to) => (from, to) switch {
        (RoomState.Idle,     RoomState.Waiting)   => true,
        (RoomState.Waiting,  RoomState.Loading)   => AllReady(),   // 全员准备
        (RoomState.Loading,  RoomState.Battling)  => AllLoaded(),
        (RoomState.Battling, RoomState.Settling)  => true,
        (RoomState.Settling, RoomState.Destroyed) => true,
        _ => false   // 其他转换一律拒绝
    };
}

public class PlayerSlot {
    public ulong PlayerId;
    public SlotStatus Status;   // Empty / Connected / Ready / Disconnected
    public int Team;
}
```

**匹配评分函数（expanding range）：**

```csharp
public class Matchmaker {
    private readonly List<MatchTicket> _pool = new();

    // 每个 ticket 记录玩家ID、战力、入队时间
    public void Enqueue(ulong playerId, int mmr) {
        _pool.Add(new MatchTicket { PlayerId = playerId, Mmr = mmr, EnqueueTime = Time.Now });
    }

    // 定时撮合：等待越久，可接受的战力差越大
    public List<Room> TryMatch(int teamSize) {
        var now = Time.Now;
        var rooms = new List<Room>();

        // 按战力排序，贪心凑队
        var sorted = _pool.OrderBy(t => t.Mmr).ToList();
        var matched = new HashSet<ulong>();

        for (int i = 0; i < sorted.Count; i++) {
            if (matched.Contains(sorted[i].PlayerId)) continue;
            var team = new List<MatchTicket> { sorted[i] };
            int waitMs = (int)(now - sorted[i].EnqueueTime).TotalMilliseconds;
            int expandRange = Math.Min(200 + waitMs / 1000 * 50, 500); // 每秒扩 50，上限 500

            for (int j = i + 1; j < sorted.Count && team.Count < teamSize; j++) {
                if (matched.Contains(sorted[j].PlayerId)) continue;
                if (Math.Abs(sorted[j].Mmr - sorted[i].Mmr) <= expandRange) {
                    team.Add(sorted[j]);
                }
            }
            if (team.Count == teamSize) {
                foreach (var t in team) matched.Add(t.PlayerId);
                rooms.Add(CreateRoom(team));
            }
        }
        _pool.RemoveAll(t => matched.Contains(t.PlayerId));
        return rooms;
    }
}
```

**会话与断线重连：**

```csharp
public class SessionService {
    // playerId → 会话票据，带过期时间
    private readonly Dictionary<ulong, Session> _sessions = new();

    public string BindSession(ulong playerId, string roomId) {
        var ticket = GenerateTicket();
        _sessions[playerId] = new Session {
            Ticket = ticket, RoomId = roomId,
            ExpireAt = Time.Now + TimeSpan.FromSeconds(30)  // 30秒内可重连
        };
        return ticket;
    }

    // 重连：凭票据恢复，不重新匹配
    public bool Reconnect(ulong playerId, string ticket, out string roomId) {
        if (!_sessions.TryGetValue(playerId, out var session)) {
            roomId = null; return false;
        }
        if (session.Ticket != ticket || Time.Now > session.ExpireAt) {
            _sessions.Remove(playerId);   // 过期，座位释放
            roomId = null; return false;
        }
        roomId = session.RoomId;
        session.ExpireAt = Time.Now + TimeSpan.FromHours(1);  // 续期
        return true;
    }
}
```

**房间服务器部署模式对比：**

| 模式 | 房间生命周期 | 适用场景 | 优劣 |
|------|--------------|----------|------|
| 专用服务器（Dedicated） | 每局起一个进程/容器 | 竞技、反作弊要求高 | 隔离好、安全；成本高 |
| 大厅托管（Lobby Host） | 一个玩家当主机 | 合作、休闲 | 成本低；主机作弊/掉线风险 |
| 区块/实例服务器 | 长驻进程跑多个房间 | MMO、大世界 | 资源复用；状态管理复杂 |
| Serverless（按需起容器） | 匹配成功才起容器 | 流量波动大 | 省成本；冷启动延迟 |

### ⚡ 实战经验

- **房间状态变更必须原子化，用锁或 Actor 模型**：最常见的 bug 是"两个玩家同时点准备"，并发请求同时读到 `readyCount=3` 各自加一，结果变成 4 而非预期的触发开始。解决：房间状态机必须在单线程内顺序处理（Actor 模型），或用分布式锁串行化关键转换。别指望数据库的乐观锁能兜住所有竞态——房间逻辑在内存里跑，数据库只是持久化兜底。
- **匹配的 expanding range 要有上限和回退**：等待越久条件越宽松是对的，但必须设硬上限，否则顶级战力玩家等 10 分钟匹配到一个新手，体验对双方都差。超过最大等待时间应该"放弃匹配 + 提示玩家"或"放宽到用机器人补位"，而不是无限等下去。监控匹配等待时间的 P95，异常增长说明池子太小或评分函数有问题。
- **断线重连的"座位保留时间"要按玩法调**：快节奏对战（MOBA、FPS）保留 30-60 秒够了，重连慢的直接 AI 接管；慢节奏或回合制可以保留几分钟甚至允许"下线后重连"（如棋牌）。保留时间越长，挂起会话占的内存和房间座位越多，要权衡。战斗中玩家断线后，座位是给 AI 接管还是暂停等重连，取决于玩法和公平性要求。
- **房间销毁要确保所有资源释放**：房间进入 Destroyed 状态后，必须清理：踢出所有玩家连接、销毁游戏场景、上报结算数据、释放 Room Server 槽位。最常见的泄漏是"房间逻辑销毁了但玩家连接没断"，残留的连接持续占用资源。建议房间销毁时强制断开所有关联会话，并在监控里跟踪"活跃房间数 vs 占用 Room Server 槽位数"，两者不一致说明有泄漏。

### 🔗 相关问题

1. 匹配系统如何防止"刷分车队"（高战力带低战力炸鱼）？组队匹配的战力聚合公式怎么设计？
2. 跨服匹配（多个游戏服务器共用一个匹配池）在数据一致性和网络延迟上如何权衡？
3. Room Server 用容器化部署（K8s）时，如何处理"战斗中途容器被驱逐"导致的房间异常中断？
