---
title: "断线重连与状态恢复（Reconnect & State Recovery）如何实现？"
category: "network"
level: 3
tags: ["断线重连", "状态恢复", "可靠性", "网络同步"]
related: ["network/frame-vs-state-sync", "network/client-side-prediction"]
hint: "玩家 WiFi 闪断 30 秒重连回来，他所在的位置、背包、战斗状态如何无损恢复？"
---

## 参考答案

### ✅ 核心要点

1. **会话保持（Session Persistence）**：服务器在玩家断线后保留其游戏状态一段时间（通常 30s~5min），而非立即销毁
2. **重连认证（Reconnect Authentication）**：客户端携带断线前的 Session ID 或 Reconnect Token 发起重连，服务器据此恢复会话
3. **状态追赶（State Catch-up）**：重连后客户端不需要回放全部历史，服务器发送"当前全量快照 + 后续增量"即可
4. **帧同步的特殊处理**：帧同步游戏中重连需从断线帧开始回放所有逻辑帧，可能需要服务器保存帧历史或客户端走"追帧"流程
5. **断线检测（Connection Loss Detection）**：心跳超时判定断线，区分"真断线"和"网络抖动"避免误杀

### 📖 深度展开

**断线重连全流程：**

```
玩家正常游戏中
    ↓
网络中断（WiFi切换 / 运营商抖动 / 进程后台被杀）
    ↓
客户端：检测到心跳超时 → 进入"重连中"UI
服务器：心跳超时 → 标记为 Disconnected，但保留状态（TTL 倒计时）
    ↓
客户端网络恢复
    ↓
Step 1: 重连握手 —— 携带 ReconnectToken
    Client → Server: CONNECT { token: "abc123", lastFrame: 4500 }
    Server: 验证 token → 找到缓存的 Session
    ↓
Step 2: 状态恢复 —— 根据同步模式分策略
    ├── 状态同步：服务器发送当前 World Full Snapshot
    ├── 帧同步：服务器发送 Frame 4500 → Frame 5100 的所有逻辑帧
    └── 混合模式：全量快照 + 最近 N 帧增量
    ↓
Step 3: 追帧/应用快照
    客户端：收到全量快照 → 直接应用
    客户端：收到帧序列 → 加速追帧（以 2x/4x 速度模拟）
    ↓
Step 4: 追上实时进度后，恢复正常同步
```

**状态同步模式——重连实现：**

```csharp
// ============ 服务器 ============

class PlayerSession {
    public uint playerId;
    public string reconnectToken;
    public PlayerState state;       // 角色状态
    public Inventory inventory;     // 背包
    public Connection conn;         // 当前连接（断线时为 null）
    public DateTime disconnectTime;
    public int disconnectTimeoutSec = 120; // 保留 2 分钟

    public bool IsExpired => conn == null &&
        (DateTime.Now - disconnectTime).TotalSeconds > disconnectTimeoutSec;
}

// 服务器主循环
void Update() {
    foreach (var session in sessions) {
        if (session.IsExpired) {
            // 超时未重连，正式销毁
            DestroyPlayer(session);
            sessions.Remove(session);
        }
    }
}

void OnClientDisconnect(Connection conn) {
    var session = FindSessionByConn(conn);
    if (session != null) {
        session.conn = null;              // 清除连接但保留状态
        session.disconnectTime = DateTime.Now;
        Log($"Player {session.playerId} disconnected, state preserved for {session.disconnectTimeoutSec}s");
    }
}

void OnReconnect(Connection newConn, string token) {
    var session = sessions.Find(s => s.reconnectToken == token);
    if (session == null || session.IsExpired) {
        // Token 无效或已过期，需要重新登录
        SendReconnectFailed(newConn, "Session expired");
        return;
    }

    session.conn = newConn; // 绑定新连接

    // 发送全量快照——把当前游戏世界状态一次性推给客户端
    var snapshot = BuildFullSnapshot(session);
    Send(newConn, snapshot);

    Log($"Player {session.playerId} reconnected, full snapshot sent");
}

// ============ 客户端 ============

enum ReconnectState {
    Connected,
    WaitingHeartbeat,   // 心跳超时，等待恢复
    Reconnecting,       // 正在重连
    RecoveryFastPath,   // 收到快照，应用中
}

ReconnectState connState = ReconnectState.Connected;
string savedReconnectToken;
int lastConfirmedFrame;

void OnHeartbeatTimeout() {
    connState = ReconnectState.WaitingHeartbeat;
    ShowReconnectingUI();

    // 指数退避重试
    StartCoroutine(ReconnectWithBackoff());
}

IEnumerator ReconnectWithBackoff() {
    float[] backoff = { 1f, 2f, 4f, 8f, 8f, 8f }; // 最大 8 秒间隔
    for (int i = 0; i < backoff.Length; i++) {
        yield return new WaitForSeconds(backoff[i]);

        bool ok = TryConnect(serverAddr);
        if (ok) {
            // 发送重连请求
            Send(new ReconnectRequest {
                token = savedReconnectToken,
                lastFrame = lastConfirmedFrame
            });
            connState = ReconnectState.Reconnecting;
            yield break;
        }
    }
    // 全部重试失败 → 回到登录界面
    GoToLoginScreen();
}

void OnFullSnapshot(WorldSnapshot snapshot) {
    // 重连后的全量快照——直接替换本地状态
    ApplyWorldState(snapshot);
    lastConfirmedFrame = snapshot.frame;
    connState = ReconnectState.Connected;
    HideReconnectingUI();
}
```

**帧同步模式——追帧机制：**

```
帧同步重连的难点：

断线时在 Frame 4500，重连回来服务器已经在 Frame 5100
中间 600 帧的逻辑输入丢失了，必须补齐

方案 A：服务器发送 4500-5100 的全部帧输入
  客户端以加速模式追帧：
  每帧实际 deltaTime = fixedDeltaTime × speedMultiplier
  speedMultiplier 从 2x 开始，追上后恢复 1x

方案 B：服务器发送 Frame 5100 的全量快照（需要服务器额外存快照）
  客户端直接跳到 5100，不需要追帧
  但帧同步服务器通常不维护完整游戏状态，此方案需要额外设计
```

```csharp
// 帧同步追帧实现

bool isCatchingUp = false;
int targetFrame;
Queue<FrameInput> pendingFrames = new();

void OnReconnectFrames(FrameInput[] frames, int serverCurrentFrame) {
    isCatchingUp = true;
    targetFrame = serverCurrentFrame;

    foreach (var f in frames) {
        pendingFrames.Enqueue(f);
    }
}

void FixedUpdate() {
    if (isCatchingUp) {
        // 追帧模式：一帧内执行多步模拟
        int stepsPerFrame = Mathf.Min(8, pendingFrames.Count); // 每帧最多追 8 步
        for (int i = 0; i < stepsPerFrame; i++) {
            var input = pendingFrames.Dequeue();
            SimulateFrame(input);
        }

        if (pendingFrames.Count == 0) {
            isCatchingUp = false; // 追帧完成
            Log("Reconnect catch-up complete");
        }
    } else {
        // 正常帧同步
        if (pendingFrames.TryDequeue(out var input)) {
            SimulateFrame(input);
        }
    }
}
```

**断线检测策略：**

| 策略 | 超时阈值 | 说明 |
|------|----------|------|
| 心跳超时 | 5-10s | 超过 N 个心跳周期未收到响应 → 断线 |
| TCP RST | 即时 | TCP 连接被显式重置（服务器崩溃等） |
| 应用层 Ping | 3-5s | 比心跳更频繁的应用层探活 |
| ACK 超时 | 2-3s | 可靠 UDP 连续重传无 ACK → 疑似断线 |

### ⚡ 实战经验

- **区分"短暂抖动"和"真正断线"**：心跳超时先进入"等待恢复"状态（继续渲染最后已知状态），给 3-5 秒缓冲期再进入重连流程，避免地铁信号闪烁导致频繁弹重连 UI
- **重连后的角色控制权过渡**：重连后不要立即恢复玩家操作权，先等全量快照应用完毕（可能 1-2 帧延迟），否则玩家在状态未同步时就输入会导致预测混乱
- **移动网络切换 IP 问题**：4G→WiFi 切换会导致 IP 变化，重连不能依赖 IP 绑定 Session，必须用 Player ID + Reconnect Token
- **帧同步追帧的 CPU 峰值**：追帧时如果积压了上千帧，一帧内执行多次物理模拟可能造成卡顿。建议限制追帧速度（如每帧最多追 4-8 步），并在追帧期间显示进度条

### 🔗 相关问题

- 帧同步游戏中如何降低断线重连的追帧时间？
- 如果服务器在玩家断线期间也宕机重启了，如何恢复？
- 如何设计 Reconnect Token 的过期与续期策略？
