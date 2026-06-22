---
title: "游戏房间生命周期状态机如何设计？Lobby→Loading→Playing→Result 的状态流转与异常处理"
category: "network"
level: 3
tags: ["房间系统", "状态机", "匹配", "生命周期", "断线重连", "游戏服务器"]
related: ["network/matchmaking-room-server", "network/reconnect-state-recovery", "network/server-authority-vs-client-trust"]
hint: "玩家在 Loading 时退游戏了怎么办？打到一半服务器崩了怎么办？一个好的房间状态机能回答所有这些问题。"
---

## 参考答案

### ✅ 核心要点

1. **房间状态机是游戏服务器逻辑的核心骨架**：定义了从创建到销毁的完整生命周期，每个状态有明确的允许行为和流转条件
2. **核心状态**：`Created → Matching → Lobby → Loading → Playing → Result → Destroyed`，每个状态对应不同的网络消息集和超时策略
3. **超时驱动状态流转**：每个状态必须设超时——Loading 超时踢人、Playing 心跳超时标记断线、Result 超时自动关闭房间
4. **状态持久化**：关键字段（成员、比分、局数）写入 Redis/DB，服务器崩溃后可以恢复房间到 Playing 状态（热重启）
5. **异常处理三原则**：可重连的断线不踢人（给宽限期）、不可恢复的异常优雅结算（判负或弃赛）、所有状态变更记录日志用于纠纷处理

### 📖 深度展开

#### 完整状态流转图

```
┌─────────┐     创建房间      ┌──────────┐
│ Created │ ────────────────→ │ Matching │
└─────────┘                   └────┬─────┘
     ↑                             │ 人齐或超时
     │  解散/取消                   ↓
     │                        ┌──────────┐
     │                        │  Lobby   │ ←─ 准备/取消准备
     │                        └────┬─────┘
     │                             │ 全员准备 + 房主开始
     │                             ↓
     │                        ┌──────────┐
     │             ┌─────────│ Loading  │ ←─ 加载进度同步
     │             │ 超时/退出  └────┬─────┘
     │             │                │ 全员加载完成
     │             │                ↓
     │             │          ┌──────────┐
     │             │          │ Playing  │ ←─ 游戏中（可能多局）
     │             │          └────┬─────┘
     │             │               │ 游戏结束 / 投降 / 超时
     │             │               ↓
     │             │          ┌──────────┐
     │             │          │  Result  │ ←─ 结算展示
     │             │          └────┬─────┘
     │             │               │ 超时/房主确认
     ↓             ↓               ↓
┌─────────┐                       
│Destroyed│ ←──── 所有路径最终汇聚
└─────────┘
```

#### 状态定义（伪代码）

```cpp
enum class RoomState {
    Created,     // 房间刚创建，未开始匹配
    Matching,    // 匹配中，等待玩家加入
    Lobby,       // 大厅，玩家准备中
    Loading,     // 加载场景中
    Playing,     // 游戏进行中
    Result,      // 结算页面
    Destroyed,   // 已销毁
};

struct RoomStateContext {
    RoomState state;
    uint32_t  roomId;
    PlayerID  hostId;
    std::vector<PlayerSlot> players;
    int       maxPlayers;
    int64_t   stateEnterTime;    // 进入当前状态的时间戳
    int64_t   stateTimeoutMs;    // 当前状态的超时时间
    MatchResult lastResult;      // 游戏结果
};
```

#### 各状态的核心逻辑与超时策略

| 状态 | 主要行为 | 允许的操作 | 超时处理 |
|------|---------|-----------|---------|
| Created | 初始化房间配置 | 设置规则、邀请 | 30s 无操作 → 销毁 |
| Matching | 匹配系统分配玩家 | 取消匹配 | 按匹配规则超时 |
| Lobby | 玩家准备/换角色 | 准备、取消、聊天、换阵营 | 单人 60s 未准备 → 踢出 |
| Loading | 同步加载进度 | 上报加载 % | 90s 未到 100% → 踢出该玩家 |
| Playing | 游戏核心逻辑 | 游戏内操作 | 心跳 30s 超时 → 标记断线 |
| Result | 展示比分/MVP | 确认、再来一局、退出 | 20s 后自动流转 |

#### Loading 阶段：最容易被忽视的陷阱

```cpp
// Loading 状态需要处理的关键逻辑
void Room::OnLoadingUpdate(PlayerID pid, float progress) {
    auto& slot = GetPlayerSlot(pid);
    slot.loadProgress = progress;

    // 检查是否所有人加载完成
    bool allLoaded = true;
    for (auto& p : players) {
        if (p.IsConnected() && p.loadProgress < 1.0f) {
            allLoaded = false;
            break;
        }
    }

    if (allLoaded) {
        // 所有人就绪 → 广播 GameStart
        Broadcast(MsgGameStart{});
        TransitionTo(RoomState::Playing);
    }
}

// 超时处理：90 秒还没加载完
void Room::OnLoadingTimeout() {
    for (auto& p : players) {
        if (p.loadProgress < 1.0f) {
            // 情况1: 网络断了 → 给宽限期等重连
            if (!p.IsConnected()) {
                p.markDisconnected = true;
                Log("Player %u disconnected during loading", p.pid);
            }
            // 情况2: 还连着但加载慢 → 踢出
            else {
                KickPlayer(p.pid, "Loading timeout");
            }
        }
    }
    // 如果还有足够玩家，继续开始
    if (GetActivePlayerCount() >= minPlayers) {
        TransitionTo(RoomState::Playing);
    } else {
        TransitionTo(RoomState::Destroyed);
    }
}
```

#### Playing 状态下的断线与重连

```
玩家断线处理流程:

1. 心跳超时 (30s 无心跳)
   → 标记 player.status = DISCONNECTED
   → 通知其他玩家: "XXX 已断线"
   → 启动重连宽限期 (通常 120s)

2. 宽限期内:
   → 角色在游戏中保持原地/交由 AI 托管
   → 房间状态不变，游戏继续
   → 玩家重连 → 恢复状态 → status = ONLINE

3. 宽限期超时:
   → 判定为本局弃权
   → 通知队友 → 根据规则判负或继续
   → 如果剩余玩家 < 最低人数 → 提前结束本局

4. 服务器崩溃恢复:
   → 从 Redis 恢复 RoomStateContext
   → 状态 = Playing，恢复所有玩家断线标记
   → 广播 "服务器重连中..."
   → 给所有玩家 60s 重连窗口
```

#### 状态持久化设计

```cpp
// Redis 存储结构
struct RoomPersistData {
    // --- 基础信息 ---
    uint32_t roomId;
    RoomState state;
    int64_t   createdAt;
    int64_t   lastStateChange;

    // --- 玩家信息 ---
    struct PersistPlayer {
        PlayerID pid;
        int      team;
        bool     isReady;
        bool     isConnected;
        int      score;
    };
    std::vector<PersistPlayer> players;

    // --- 游戏快照（用于恢复）---
    std::string gameSnapshotBase64;  // 游戏内的状态快照

    // --- 配置 ---
    GameConfig config;
};

// 持久化时机：
// 1. 每次状态流转时
// 2. 游戏内每 30s 定期快照
// 3. 关键事件（得分、回合结束）

// 恢复流程：
Room* RoomManager::RestoreRoom(uint32_t roomId) {
    auto data = redis.Get(roomKey(roomId));
    if (!data) return nullptr; // 没有存档，无法恢复

    Room* room = new Room();
    room->Deserialize(data);
    // 恢复后进入特殊状态
    room->state = RoomState::Playing;
    room->StartReconnectGracePeriod(60000); // 60s 重连窗口
    return room;
}
```

### ⚡ 实战经验

1. **Loading 阶段是事故高发区**：客户端 Crash、设备性能差加载慢、网络波动——务必做分级处理（给宽限期 vs 直接踢），并且 Loading 界面要显示其他人的加载进度，避免玩家以为卡死了
2. **状态流转必须是单向的（Created→...→Destroyed）**，不要允许回退（如 Playing→Lobby）。需要"再来一局"时，新建一个房间状态机实例，复用玩家列表但重置所有游戏状态。回退状态会导致脏数据问题
3. **房主的特殊处理**：房主断线时需要自动转移房主权限给其他在线玩家，否则房间会卡死在"等待房主操作"状态。优先级：最先准备的在线玩家
4. **结算阶段的数据写入必须异步**：比分、MVP、经验结算等写入数据库的操作不要阻塞状态流转。先写入消息队列，立即流转到 Result 状态，后台消费者异步落库。如果 DB 写入失败，有重试机制和对账日志兜底

### 🔗 相关问题

- 匹配系统的 ELO/MMR 算法如何与房间状态机配合？
- 大厅系统中如何处理跨服匹配（多个游戏服实例之间的房间调度）？
- 如何设计观战系统的状态流转——观战者算不算房间成员？
