---
title: "回合制 / 卡牌游戏的网络同步如何设计？与实时游戏有什么本质区别？"
category: "network"
level: 2
tags: ["回合制", "卡牌游戏", "状态同步", "协议设计", "断线重连"]
related: ["network/frame-vs-state-sync", "network/reconnect-state-recovery", "network/server-authority-vs-client-trust"]
hint: "炉石传说、游戏王、麻将游戏——不需要每帧同步，但绝不允许状态不一致。回合制同步的核心难点是什么？"
---

## 参考答案

### ✅ 核心要点

1. **请求-确认模型**：客户端发操作请求 → 服务器验证 → 广播结果，绝不允许客户端先执行
2. **绝对权威的服务器**：回合制游戏 100% 服务器权威，客户端只是渲染层
3. **操作日志 = 游戏状态**：记录所有操作序列（Action Log），任何时候可重放到相同状态
4. **乐观锁与回合号**：每个操作携带 expectedTurnId，服务器校验防止乱序和重复
5. **断线重连 = 全量快照 + 未处理操作**：重连时发送完整游戏状态，无需增量补偿

### 📖 深度展开

#### 回合制 vs 实时同步的本质区别

| 维度 | 回合制 / 卡牌 | 实时（ARPG / FPS） |
|------|--------------|-------------------|
| 同步频率 | 事件驱动（玩家操作） | 固定 Tick（15-60Hz） |
| 延迟容忍 | 200-500ms 可接受 | >100ms 需要预测 |
| 带宽 | 极低（KB/s） | 高（KB/s ~ MB/s） |
| 客户端预测 | 几乎不需要 | 必须 |
| 状态恢复 | 全量快照即可 | 需要增量 + 插值 |
| 一致性要求 | 绝对一致（零容忍） | 最终一致 |

#### 协议设计

```
操作请求（C→S）
{
    "msgId": "PLAYER_ACTION",
    "roomId": "room_12345",
    "turnId": 7,                    // 当前回合号（乐观锁）
    "action": {
        "type": "PLAY_CARD",
        "cardId": "card_0042",
        "targetIndex": 2,
        "cost": [{ "type": "mana", "amount": 3 }]
    },
    "seqId": 42,                    // 操作序列号（防重放）
    "checksum": 0xA3F1B2C0          // 客户端状态校验码
}
```

```
操作确认广播（S→C）
{
    "msgId": "ACTION_RESULT",
    "turnId": 8,                    // 推进到下一回合
    "results": [
        { "entity": 1, "effect": "DAMAGE", "amount": 5 },
        { "entity": 2, "effect": "DESTROY" },
        { "entity": 0, "effect": "DRAW_CARD", "cardId": "card_0078" }
    ],
    "stateChecksum": 0xB7E2D401,   // 服务器最新状态校验
    "nextPlayer": 0,
    "nextTurnId": 8
}
```

#### 服务器验证流程

```
Client 发送 PLAY_CARD 请求
        │
        ▼
┌───────────────────┐
│ 1. 序列号校验      │ ── seqId <= lastSeqId? → 拒绝（重复/乱序）
├───────────────────┤
│ 2. 回合号校验      │ ── turnId != currentTurn? → 拒绝（过期操作）
├───────────────────┤
│ 3. 状态校验码      │ ── checksum 不匹配? → 要求全量重同步
├───────────────────┤
│ 4. 规则引擎验证    │ ── 法力值够吗？目标合法吗？阶段对吗？
├───────────────────┤
│ 5. 执行 & 生成结果 │ ── 更新服务器状态，生成效果链
├───────────────────┤
│ 6. 广播结果        │ ── 发给所有玩家 + 观战者
└───────────────────┘
```

#### 断线重连策略

```csharp
public class ReconnectHandler
{
    public void OnPlayerReconnect(string playerId, string roomId)
    {
        var game = GameManager.GetGame(roomId);
        
        // 1. 构建完整游戏快照
        var snapshot = new GameSnapshot
        {
            Players = game.Players.Select(p => new PlayerState
            {
                Hand = p.Hand,           // 手牌
                Deck = p.DeckCount,      // 牌库数量（不暴露内容）
                Field = p.Field,         // 场上单位
                Health = p.Health,
                Mana = p.Mana
            }).ToArray(),
            CurrentTurn = game.TurnId,
            ActivePlayer = game.ActivePlayerIndex,
            Phase = game.CurrentPhase,   // 出牌阶段 / 结束阶段
            // 操作日志：最近 N 条用于客户端播放动画
            RecentActions = game.ActionLog.TakeLast(10)
        };
        
        // 2. 发送快照
        Send(playerId, "GAME_SNAPSHOT", snapshot);
        
        // 3. 如果断线期间是自己的回合，补发计时器状态
        if (game.ActivePlayerId == playerId)
        {
            Send(playerId, "TURN_TIMER", new {
                remaining = game.TurnTimer.RemainingSeconds
            });
        }
    }
}
```

#### 炉石传说的实际架构参考

- **通信层**：基于 TCP 的自定义协议（非 WebSocket）
- **操作模型**：Client → Server 的 Command 模式，Server 权威执行
- **确定性**：所有随机数由服务器生成并附带 Seed，客户端只做表现层动画
- **重连**：全量状态快照 + Action 回放队列

### ⚡ 实战经验

1. **校验码（Checksum）是防作弊利器**：客户端状态与服务器不一致时立即触发全量重同步，能检测到内存篡改、协议篡改。用 CRC32 或 FNV-1a 足够
2. **回合计时器要服务器驱动**：客户端不要自己倒计时，每秒收一个 HEARTBEAT 带 remaining_seconds。否则玩家改本地时钟就能作弊
3. **操作动画播放不能阻塞协议**：客户端收到 ACTION_RESULT 后先入队，动画系统按队列播放。如果玩家断线 10 秒重连，10 条操作的动画要能快进或跳过
4. **麻将/扑克的牌序随机性必须服务器掌控**：洗牌 Seed 不能下发给客户端。客户端只知道"我摸到了第 N 张"，不知道牌堆顺序

### 🔗 相关问题

- 回合制游戏中如何设计回放系统（Replay / Spectator）？
- 服务器规则引擎怎么设计才能支持多种卡牌效果（Buff/Debuff/触发链）？
- 移动网络下 TCP 长连接频繁断开怎么优化心跳策略？
