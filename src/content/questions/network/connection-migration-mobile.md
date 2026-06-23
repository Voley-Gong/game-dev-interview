---
title: "移动游戏的连接迁移（Connection Migration）如何实现？WiFi↔蜂窝无缝切换怎么做？"
category: "network"
level: 3
tags: ["连接迁移", "Connection Migration", "WiFi切换", "蜂窝网络", "QUIC", "断线重连", "移动游戏"]
related: ["network/reconnect-state-recovery", "network/quic-in-games", "network/rtt-jitter-packetloss"]
hint: "玩家从 WiFi 切到 4G 时，是断线重连还是无缝迁移？关键在于连接标识、状态保持和快速恢复机制。"
---

## 参考答案

### ✅ 核心要点

1. **连接迁移 vs 断线重连**：连接迁移是底层传输层透明切换网络接口，上层会话不中断；断线重连是应用层重新建连后恢复游戏状态，有不可见的断线期
2. **Session Token 机制**：用 Session ID（而非 IP+Port）标识玩家会话，切换网络后携带 Token 快速重新关联服务器端状态
3. **QUIC 原生迁移**：QUIC 协议的 Connection ID 设计天然支持路径迁移，IP 变化不触发重新握手，是移动游戏的理想传输层
4. **状态冻结与恢复窗口**：客户端检测到网络切换时主动暂停输入提交，服务器端保留会话状态 5-10 秒（Grace Period），超时才判定掉线
5. **网络变化检测**：通过 OS 网络状态 API（Android ConnectivityManager / iOS SCNetworkReachability）监听 WiFi↔Cellular 切换事件，提前预判

### 📖 深度展开

#### 方案对比

```
方案 A：传统断线重连（TCP）

  WiFi 断开 → TCP 连接断开 → 检测到掉线 → 重新建连 → 状态恢复
                                                      ↓
  玩家感知：⬛⬛⬛ 卡顿 3-8 秒 ⬛⬛⬛ → 可能被判定为掉线

方案 B：QUIC Connection Migration

  WiFi 断开 → 4G 接管 → Connection ID 不变 → 路径验证 → 继续传输
                                                      ↓
  玩家感知：▓▓▓ 轻微延迟（200-500ms） ▓▓▓ → 几乎无感

方案 C：双连接热备（Dual Socket）

  WiFi ── 主连接 ──→ 服务器
  4G  ── 备连接 ──→ 服务器（待命）
  
  WiFi 断开 → 立刻切到 4G 主连接 → 0ms 中断
  代价：双倍连接维护开销
```

#### 连接迁移架构

```
┌──────────────┐                              ┌──────────────────┐
│  Mobile Game │                              │   Game Server    │
│              │     Session Token: ABC123    │                  │
│  ┌────────┐  │  ┌────────────────────────┐  │  ┌────────────┐  │
│  │Net     │  │  │ 1. WiFi: 192.168.1.5  │──→  │ Session    │  │
│  │Monitor │  │  │    :54321             │  │  │ Manager    │  │
│  │        │  │  │                       │  │  │            │  │
│  │ WiFi↓↑ │  │  │ 2. 切换检测            │  │  │ Token:     │  │
│  │ 4G  ↓↑ │  │  │    ↓                   │  │  │  ABC123    │  │
│  │        │  │  │ 3. QUIC Path Migration │  │  │            │  │
│  │ Migration│ │  │    or Token Reconnect │──→  │ Player:    │  │
│  │ Manager │  │  │    ↓                   │  │  │ Hero_42    │  │
│  └────────┘  │  │ 4. 4G: 10.2.x.x:38921 │──→  │ State:     │  │
│              │  │    (新路径)             │  │  │ InBattle   │  │
│  Grace       │  └────────────────────────┘  │  │            │  │
│  Period: 8s  │                              │  │ Grace: 10s │  │
└──────────────┘                              └──────────────────┘
```

#### 核心代码实现

```csharp
// ============ 网络变化检测（Unity / C#） ============
public class NetworkMonitor : MonoBehaviour
{
    public enum NetworkType { WiFi, Cellular, None }
    private NetworkType _currentType;

    void Start()
    {
        _currentType = DetectNetworkType();
        // Android: 注册 ConnectivityManager.NetworkCallback
        // iOS:     SCNetworkReachability 回调
        // Unity:   Application.internetReachability + 自定义原生插件
        StartCoroutine(PollNetworkChanges());
    }

    IEnumerator PollNetworkChanges()
    {
        while (true)
        {
            yield return new WaitForSeconds(0.5f);
            var newType = DetectNetworkType();
            if (newType != _currentType)
            {
                Debug.Log($"[NetMonitor] {_currentType} → {newType}");
                OnNetworkChanged(_currentType, newType);
                _currentType = newType;
            }
        }
    }

    void OnNetworkChanged(NetworkType oldType, NetworkType newType)
    {
        if (newType == NetworkType.None)
        {
            // 完全断网
            NetworkManager.Instance.EnterGracePeriod();
        }
        else
        {
            // WiFi↔Cellular 切换，或从断网恢复
            NetworkManager.Instance.TriggerConnectionMigration();
        }
    }

    NetworkType DetectNetworkType()
    {
        if (Application.internetReachability == NetworkReachability.NotReachable)
            return NetworkType.None;
        if (Application.internetReachability == NetworkReachability.ReachableViaLocalAreaNetwork)
            return NetworkType.WiFi;
        return NetworkType.Cellular;
    }
}

// ============ 连接迁移管理器 ============
public class ConnectionMigrationManager
{
    private readonly string _sessionToken;
    private readonly string _playerId;
    private readonly GameClient _client;
    private readonly float _gracePeriodSeconds = 10f;

    private float _disconnectTime;
    private bool _inGracePeriod;

    // 触发连接迁移
    public void TriggerConnectionMigration()
    {
        // Step 1: 尝试 QUIC 无缝迁移（如果使用 QUIC）
        if (_client.Transport == TransportType.QUIC)
        {
            // QUIC 层自动处理 Path Migration，只需验证新路径
            _client.SendPathChallenge();
            Debug.Log("[Migration] QUIC path migration triggered");
            return;
        }

        // Step 2: TCP/KCP 方案 → Token 快速重连
        _client.DisconnectOldSocket();
        _client.ConnectWithToken(_sessionToken);

        // 服务器端验证 Token 并恢复会话
        var reconnectMsg = new ReconnectRequest
        {
            SessionToken = _sessionToken,
            PlayerId = _playerId,
            LastConfirmedTick = _client.LastConfirmedTick,
            MigrationFlag = true  // 标记为迁移而非新连接
        };
        _client.Send(reconnectMsg);
    }

    // 进入 Grace Period（完全断网时）
    public void EnterGracePeriod()
    {
        _inGracePeriod = true;
        _disconnectTime = Time.time;

        // 客户端：暂停输入提交，但继续模拟已有状态
        GameLoop.Instance.PauseInputSubmission();

        // 客户端预测继续跑（用最后已知输入）
        PredictionController.Instance.StartBlindPrediction();
    }

    // 每帧检查 Grace Period 是否超时
    public void Update()
    {
        if (_inGracePeriod)
        {
            if (Time.time - _disconnectTime > _gracePeriodSeconds)
            {
                // 超时：正式判定掉线
                GameLoop.Instance.OnDisconnected();
                _inGracePeriod = false;
            }
        }
    }

    // 服务器端：Token 验证 + 会话恢复
    public class ServerSessionManager
    {
        private readonly Dictionary<string, PlayerSession> _activeSessions = new();

        public ReconnectResponse HandleReconnect(ReconnectRequest req)
        {
            if (!_activeSessions.TryGetValue(req.SessionToken, out var session))
                return new ReconnectResponse { Success = false, Reason = "Session expired" };

            if (session.IsExpired)
                return new ReconnectResponse { Success = false, Reason = "Session timed out" };

            // 更新连接信息（新 IP/Port）
            session.UpdateEndpoint(req.SourceEndpoint);
            session.LastActiveTime = Time.time;
            session.MigrationCount++;

            // 发送最近 N 帧的状态快照（恢复丢失期间的状态）
            var recentSnapshots = session.GetRecentSnapshots(req.LastConfirmedTick);

            return new ReconnectResponse
            {
                Success = true,
                ResumeTick = session.CurrentTick,
                Snapshots = recentSnapshots,
                MigrationDelayMs = 0 // 无需重新匹配
            };
        }
    }
}
```

#### QUIC Connection ID 迁移详解

```
QUIC 路径迁移流程：

  Client (WiFi: 192.168.1.5:54321)           Server (1.2.3.4:443)
  │                                           │
  │  Connection ID: CID-X（不变）              │
  │  ──────────────────────────────────────→  │
  │  正常数据传输                               │
  │                                           │
  │  ⚡ WiFi 断开，4G 上线                     │
  │  新源地址: 10.2.x.x:38921                 │
  │                                           │
  │  ── PATH_CHALLENGE (新路径) ────────────→  │
  │                                           │  验证新路径可达性
  │  ←── PATH_RESPONSE ─────────────────────  │
  │                                           │
  │  ── Packet (CID=X, from 10.2.x.x) ─────→  │  自动关联到已有连接
  │                                           │  无需重新握手！
  │  正常数据传输恢复                           │
  │                                           │

  关键：Connection ID 标识逻辑连接，与 IP:Port 解耦
  迁移延迟：仅需 1 个 RTT 的 PATH_CHALLENGE/RESPONSE
```

### ⚡ 实战经验

- **Grace Period 要比匹配超时长**：服务器端的 Grace Period 至少 5-10 秒，确保玩家穿越短隧道或电梯等短暂断网场景能恢复。但也不能太长，否则掉线玩家占着房间位置影响其他人——通常配合 AI 接管或房间超时机制
- **QUIC 迁移不是万能药**：某些运营商会对 UDP 限速或 QoS 降级，WiFi→4G 切换后 QUIC 包可能被丢弃。生产环境中 QUIC 迁移失败后必须有 TCP 回退方案
- **迁移期间的输入缓冲很重要**：客户端在迁移期间缓存玩家输入（不丢弃），恢复后批量发送给服务器进行 Reconciliation，避免迁移期间的按键丢失。这和 CSP 中的输入队列思路一致
- **网络切换检测要快**：Unity 的 `Application.internetReachability` 精度不够（只区分 WiFi/Cellular/None），且更新频率慢。生产环境建议写原生插件直接订阅 Android `ConnectivityManager.NetworkCallback` 和 iOS `NWPathMonitor`，可以在 200-500ms 内检测到切换

### 🔗 相关问题

- 断线重连和连接迁移在状态恢复机制上有什么区别？
- QUIC 的 Connection ID 如何防止跨路径的中间人攻击？
- 双连接热备方案（WiFi + 4G 同时维持）在什么场景下值得用？
