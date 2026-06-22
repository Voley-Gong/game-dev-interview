---
title: "Listen Server 的主机迁移（Host Migration）如何实现？断线无缝切换全流程"
category: "network"
level: 3
tags: ["主机迁移", "Host Migration", "Listen Server", "P2P", "断线重连", "状态同步"]
related: ["network/network-topology", "network/reconnect-state-recovery", "network/server-authority-vs-client-trust"]
hint: "主机玩家突然断线，其他玩家的对局如何不中断？这背后是一套复杂的角色迁移机制。"
---

## 参考答案

### ✅ 核心要点

1. **主机迁移 = 权威角色转移**：当 Host（主机玩家）断线时，从剩余玩家中选举新 Host，将权威模拟状态完整迁移
2. **状态快照序列化**：新 Host 需要获得完整的游戏世界状态——通过定期广播 State Snapshot 或让每个客户端维护最小权威副本
3. **选举算法**：通常选延迟最低、连接最稳定、或预设优先级的节点做新 Host
4. **冻结期（Freeze Frame）**：迁移过程中短暂暂停游戏逻辑（1-3 秒），避免状态不一致
5. **回滚与合并**：迁移完成后，各客户端可能需要回滚未确认的操作并基于新 Host 状态重新同步

### 📖 深度展开

#### 迁移全流程

```
时间线：
═══════════════════════════════════════════════════════
  正常游戏中         Host 断线检测        迁移冻结期        恢复游戏
  (Host=Player1)    (心跳超时)          (选举+状态迁移)    (Host=Player3)
───────────────────────────────────────────────────────
     │                 │                  │               │
     ▼                 ▼                  ▼               ▼
  Host 定期          某客户端检测      所有客户端暂停     新 Host 广播
  广播心跳           到 Host 心跳      游戏逻辑输入       Full Snapshot
  和状态快照         超时 (3-5s)       进入迁移流程       恢复正常同步
```

#### 迁移状态机

```
                ┌──────────┐
                │  正常游戏  │
                │ Host=Player1│
                └─────┬────┘
                      │ Host 心跳超时
                      ▼
                ┌──────────┐
                │ 检测断线  │
                │ 进入迁移  │
                └─────┬────┘
                      │
                      ▼
                ┌──────────┐     无人应答(全断)
                │  选举阶段  │─────────────────→ 对局结束
                │ (Elect)   │
                └─────┬────┘
                      │ 新 Host 确定
                      ▼
                ┌──────────┐
                │ 状态收集  │
                │ (Collect) │
                └─────┬────┘
                      │ 状态合并完成
                      ▼
                ┌──────────┐
                │ 状态广播  │
                │ (Broadcast│
                └─────┬────┘
                      │ 所有客户端确认
                      ▼
                ┌──────────┐
                │  恢复游戏  │
                │ Host=Player3│
                └──────────┘
```

#### 选举算法

```csharp
public class HostMigrationManager
{
    // 预设优先级：房主 > 等级最高 > 延迟最低
    public int CalculatePriority(PlayerInfo player)
    {
        int score = 0;
        score += player.IsRoomOwner ? 10000 : 0;
        score += player.Level * 100;
        score -= (int)(player.AverageRTT); // 延迟越低分越高
        return score;
    }

    public PlayerInfo ElectNewHost(List<PlayerInfo> alivePlayers)
    {
        // 方案 A：优先级选举（简单可靠）
        return alivePlayers.OrderByDescending(CalculatePriority).First();
    }

    // 方案 B：Bully 算法变体——超时后各自广播候选，
    // 收集所有候选后在固定窗口内选最优
    public async Task<PlayerInfo> BullyElect(List<PlayerInfo> alivePlayers)
    {
        var myCandidate = CalculatePriority(_localPlayer);
        var responses = new List<(PlayerInfo candidate, int priority)>();

        // 广播自己的候选优先级
        Broadcast(new MigrationVote {
            CandidateId = _localPlayer.Id,
            Priority = myCandidate
        });

        // 等待 500ms 收集其他人的投票
        await Task.Delay(MIGRATION_VOTE_WINDOW_MS);

        // 所有人选优先级最高的
        return responses.OrderByDescending(r => r.priority).First().candidate;
    }
}
```

#### 状态迁移：核心难题

新 Host 需要完整世界状态。有三种方案：

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **A. 客户端权威副本** | 每个客户端维护自己负责的实体的权威副本 | 迁移快，新 Host 直接收集 | 需要设计分布式权威，复杂 |
| **B. 定期全量快照** | Host 定期广播全量快照，所有客户端缓存最新一份 | 简单可靠 | 快照大、带宽消耗高 |
| **C. 混合方案** | 每个客户端缓存自己收到的最近状态 + 本地预测状态 | 平衡带宽与完整性 | 合并冲突处理复杂 |

**推荐方案 C**——每个客户端维护一个"影子状态"：

```csharp
public class ShadowStateManager
{
    // 影子状态：每个客户端都维护一份最近确认过的世界状态
    private Dictionary<uint, EntityState> _shadowState = new();
    private int _lastConfirmedTick;

    // 每次收到 Host 的状态更新，更新影子状态
    public void OnStateUpdate(uint entityId, EntityState state, int tick)
    {
        _shadowState[entityId] = state.Clone();
        _lastConfirmedTick = tick;
    }

    // 迁移时：把影子状态交给新 Host
    public WorldSnapshot BuildMigrationSnapshot()
    {
        var snapshot = new WorldSnapshot {
            Tick = _lastConfirmedTick,
            Entities = new List<EntityState>(_shadowState.Values)
        };
        return snapshot;
    }
}

// 迁移时的状态合并流程
public class MigrationStateMerger
{
    public WorldState MergeSnapshots(List<WorldSnapshot> snapshots)
    {
        var merged = new WorldState();

        // 按 tick 取最新的实体状态
        foreach (var snapshot in snapshots.OrderByDescending(s => s.Tick))
        {
            foreach (var entity in snapshot.Entities)
            {
                if (!merged.Contains(entity.Id))
                {
                    // 取 tick 最高的版本
                    merged.Add(entity);
                }
            }
        }

        return merged;
    }
}
```

#### 完整迁移序列图

```
Player1(Host)  Player2       Player3       Player4
    │             │             │             │
    │ ── 心跳 ──→ │             │             │  正常心跳
    │             │             │             │
    ✗ ─────────── │             │             │  Host 断线！
    │             │             │             │
    │   Player2 超时检测 (3s 无心跳)          │
    │             │             │             │
    │ ← 广播迁移 │ ──────────→ │ ──────────→ │  发起迁移
    │             │             │             │
    │             │ ← 投票 ──── │ ──────────→ │  各自发送候选优先级
    │             │             │             │
    │      选举结果：Player3 (延迟最低+等级高) │
    │             │             │             │
    │             │ → 快照给P3 │ ← 快照给P3   │  各客户端发送影子状态
    │             │             │             │
    │             │             │ 合并快照     │  P3 合并所有状态
    │             │             │ 重建权威     │
    │             │             │             │
    │             │ ← 全量状态 │ ──────────→ │  P3 广播新世界状态
    │             │             │             │
    │             │ ── ACK ──→ │ ──── ACK ──→│  确认就绪
    │             │             │             │
    │             │             │ ← 恢复游戏  │  解除冻结，继续对局
    │             │             │             │
```

### ⚡ 实战经验

1. **冻结时间要够但不能太长**：1-3 秒的冻结期是体验和正确性的权衡。太短（<500ms）状态还没合并完，太长（>5s）玩家可能直接退出。可以在冻结期显示"正在重新连接..."的过渡画面
2. **断线检测不要太灵敏**：心跳超时设 3-5 秒比较稳妥。设太短（1 秒）一个网络抖动就触发迁移，导致频繁切 Host。用"连续 N 次心跳缺失"而非单次超时来判断
3. **离线 Host 重连问题**：原 Host 重新连上后应该作为普通客户端加入，而不是抢回 Host 身份。否则状态会出现两次权威覆盖
4. **移动端要考虑后台杀进程**：手机玩家切到后台被系统杀掉是 Host Migration 最常见的触发原因。建议移动端游戏慎用 Listen Server 架构，或至少在 Host 切到后台时主动通知迁移

### 🔗 相关问题

- 为什么竞技游戏几乎不用 Listen Server 而坚持用 Dedicated Server？
- 如果迁移过程中多个客户端的状态快照冲突（同一实体不同状态），如何仲裁？
- 能否做到零冻结时间的主机迁移（Zero-Downtime Migration）？需要什么前提条件？
