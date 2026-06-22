---
title: "游戏网络协议如何分层设计？会话层、同步层、逻辑层的职责边界在哪？"
category: "network"
level: 3
tags: ["网络架构", "协议分层", "会话管理", "同步层", "架构设计"]
related: ["network/protocol-selection", "network/network-topology", "network/snapshot-delta-sync"]
hint: "从 UDP Socket 到游戏逻辑，中间需要几层抽象？每层各管什么？这是网络架构师面试的核心题。"
---

## 参考答案

### ✅ 核心要点

1. **四层经典分层**：传输层（Transport）→ 可靠性层（Reliability）→ 会话层（Session）→ 同步层（Replication/Sync），职责清晰才能可维护
2. **传输层只管收发**：封装 UDP/TCP Socket 差异，提供统一的 Send/Recv 接口，处理地址管理和多路复用
3. **会话层管理连接生命周期**：握手鉴权、心跳保活、断线检测、重连恢复——类似 TLS 之于 TCP
4. **同步层是游戏核心**：状态序列化、Delta 压缩、插值预测、AOI 过滤——所有与游戏逻辑相关的网络决策都在这一层

### 📖 深度展开

#### 完整分层架构

```
┌─────────────────────────────────────────────────────┐
│  应用层（Application Layer）                          │
│  游戏逻辑、技能系统、移动系统、战斗系统                │
│  ↓ 调用 Replicate/RPC 接口                           │
├─────────────────────────────────────────────────────┤
│  同步层（Replication Layer）                          │
│  ┌─────────┐ ┌──────────┐ ┌─────────────────┐       │
│  │状态序列化│ │Delta压缩  │ │AOI/兴趣区域过滤  │       │
│  │属性注册  │ │快照管理   │ │优先级调度        │       │
│  └─────────┘ └──────────┘ └─────────────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐      │
│  │RPC 路由   │ │插值/预测   │ │事件聚合/批处理    │     │
│  │远程调用   │ │Client Pred│ │Send Queue 管理   │      │
│  └──────────┘ └──────────┘ └─────────────────┘      │
├─────────────────────────────────────────────────────┤
│  会话层（Session Layer）                              │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐      │
│  │握手/鉴权  │ │心跳保活   │ │断线重连          │      │
│  │Token 验证│ │RTT 测量   │ │连接状态机         │      │
│  └──────────┘ └──────────┘ └─────────────────┘      │
├─────────────────────────────────────────────────────┤
│  可靠性层（Reliability Layer）                         │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐      │
│  │序列号管理 │ │ACK/SACK  │ │重传/滑动窗口      │     │
│  │多通道复用 │ │可靠/不可靠│ │拥塞控制           │      │
│  │通道优先级 │ │消息拆分   │ │带宽限制           │      │
│  └──────────┘ └──────────┘ └─────────────────┘      │
├─────────────────────────────────────────────────────┤
│  传输层（Transport Layer）                             │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐      │
│  │UDP Socket │ │TCP Fallback│ │IPv4/IPv6 双栈   │      │
│  │收发缓冲区  │ │WebSocket  │ │地址管理          │      │
│  └──────────┘ └──────────┘ └─────────────────┘      │
└─────────────────────────────────────────────────────┘
```

#### 各层职责详解与代码示例

**Layer 1: 传输层（Transport）**

```csharp
// 统一接口，屏蔽 UDP/TCP/WebSocket 差异
public interface ITransport
{
    bool Connect(string address, int port);
    int Send(byte[] data, int offset, int length);
    int Receive(byte[] buffer, int offset, int maxLength);
    void Close();
    bool IsConnected { get; }
}

public class UdpTransport : ITransport
{
    private UdpClient _socket;
    private IPEndPoint _remoteEP;

    public bool Connect(string address, int port)
    {
        _socket = new UdpClient();
        _remoteEP = new IPEndPoint(IPAddress.Parse(address), port);
        // UDP "连接"只是绑定远端地址，不真正握手
        _socket.Connect(_remoteEP);
        return true;
    }

    public int Send(byte[] data, int offset, int length)
    {
        return _socket.Send(data, length);
    }

    public int Receive(byte[] buffer, int offset, int maxLength)
    {
        var ep = (EndPoint)_remoteEP;
        return _socket.Client.ReceiveFrom(buffer, offset, maxLength,
            SocketFlags.None, ref ep);
    }
}
```

**Layer 2: 可靠性层（Reliability）**

```csharp
// 多通道设计：不同优先级走不同逻辑通道
public class ReliableLayer
{
    private ITransport _transport;
    private Channel[] _channels = new Channel[8];

    // 通道定义
    public const int CH_RELIABLE_ORDERED = 0;   // 聊天、RPC（可靠有序）
    public const int CH_RELIABLE_UNORDERED = 1;  // 文件分片（可靠无序）
    public const int CH_UNRELIABLE = 2;          // 位置快照（不可靠）
    public const int CH_UNRELIABLE_FRAGMENT = 3; // 大快照分片（不可靠分片）

    public void Send(byte[] data, int channelId)
    {
        var ch = _channels[channelId];
        switch (ch.mode)
        {
            case ReliabilityMode.Reliable:
                ch.SendReliable(data);  // 走 ACK + 重传
                break;
            case ReliabilityMode.Unreliable:
                ch.SendUnreliable(data); // 直接发，不追踪
                break;
        }
    }

    // 上层调用：每帧处理收到的包并分发给对应通道
    public void Update()
    {
        while (_transport.Receive(_recvBuf, 0, MAX_PACKET) > 0)
        {
            var header = ParseHeader(_recvBuf);
            var channel = _channels[header.ChannelId];
            channel.OnPacketReceived(header, _recvBuf);
        }

        // 各通道处理超时重传等
        foreach (var ch in _channels)
            ch.Update();
    }
}
```

**Layer 3: 会话层（Session）**

```csharp
public class SessionManager
{
    public enum State { Disconnected, Connecting, Handshake, Connected, Reconnecting }

    private State _state = State.Disconnected;
    private long _lastHeartbeatMs;
    private const long HEARTBEAT_INTERVAL = 1000;   // 1 秒
    private const long HEARTBEAT_TIMEOUT = 5000;     // 5 秒

    // 连接状态机
    public async Task<bool> Connect(string sessionId, string authToken)
    {
        _state = State.Connecting;
        _transport.Connect(serverAddr, serverPort);

        // 握手阶段：发送 Hello + Token
        _state = State.Handshake;
        SendHello(sessionId, authToken);

        // 等待服务器 Welcome
        var welcome = await WaitForWelcome(5000);
        if (welcome == null)
        {
            _state = State.Disconnected;
            return false;
        }

        _state = State.Connected;
        _lastHeartbeatMs = GetTimeMs();
        return true;
    }

    // 心跳保活
    public void Update()
    {
        var now = GetTimeMs();

        if (_state != State.Connected) return;

        // 发心跳
        if (now - _lastHeartbeatMs > HEARTBEAT_INTERVAL)
        {
            SendHeartbeat();
            _lastHeartbeatMs = now;
        }

        // 检测超时
        if (now - _lastRecvMs > HEARTBEAT_TIMEOUT)
        {
            _state = State.Disconnected;
            OnDisconnected?.Invoke(DisconnectReason.Timeout);
        }
    }

    // 断线重连
    public async Task<bool> Reconnect()
    {
        _state = State.Reconnecting;
        // 使用断线恢复令牌（Reconnect Token）
        var token = _sessionInfo.ReconnectToken;
        return await Connect(_sessionInfo.SessionId, token);
    }
}
```

**Layer 4: 同步层（Replication）**

```csharp
// 声明式同步：在游戏对象上标注哪些属性需要同步
public class ReplicationLayer
{
    // 注册需要同步的实体
    public void RegisterEntity(NetworkEntity entity)
    {
        foreach (var prop in entity.GetSyncProperties())
        {
            _propRegistry.Register(entity.Id, prop);
        }
    }

    // 服务器端：每 Tick 构建同步包
    public void ServerTick(int tick, List<int> clientIds)
    {
        foreach (var clientId in clientIds)
        {
            // AOI 过滤：只同步这个客户端可见的实体
            var visibleEntities = _aoiManager.GetVisibleEntities(clientId);

            // Delta 计算：只序列化变化的属性
            var deltaBuilder = new DeltaBuilder(_baselines[clientId]);
            foreach (var entity in visibleEntities)
            {
                deltaBuilder.AddIfChanged(entity);
            }

            // 按通道发送：位置走不可靠通道，RPC 走可靠通道
            var snapshot = deltaBuilder.Build();
            _reliableLayer.Send(snapshot, ReliableLayer.CH_UNRELIABLE);
        }
    }

    // 客户端：接收并应用同步数据
    public void ClientApply(byte[] data)
    {
        var snapshot = Snapshot.Deserialize(data);
        foreach (var entry in snapshot.Entries)
        {
            var entity = _world.GetOrCreateEntity(entry.EntityId);
            entity.ApplyState(entry.Properties);

            // 交给插值系统做平滑
            _interpSystem.OnSnapshotReceived(entity, entry);
        }
    }
}

// 声明式属性注册（类似 Unity Netcode 的 [NetworkVariable]）
public class PlayerEntity : NetworkEntity
{
    [SyncProperty(SyncMode.Continuous, Priority.High)]
    public Vector3 Position;

    [SyncProperty(SyncMode.OnChange, Priority.Medium)]
    public int Health;

    [SyncProperty(SyncMode.OnChange, Priority.Low)]
    public string DisplayName;
}
```

#### 分层设计的收益

| 场景 | 不分层（面条式） | 分层架构 |
|------|----------------|---------|
| 从 UDP 换到 QUIC | 全局重构 | 只改 Transport 层 |
| 新增 RPC 机制 | 在收发逻辑中硬塞 | 在 Replication 层新增 RPC 路由 |
| 调试丢包问题 | 不知道哪层出错 | 逐层打日志，精确定位 |
| 支持断线重连 | 业务逻辑和连接耦合 | Session 层独立处理 |
| 多人/单人切换 | 大量 if-else | Replication 层切换开关 |

#### 对比主流框架的分层

```
Unity Netcode (NGO):
  Transport (UTP/UDP) → Messaging → NetworkBehaviour (Replication)

Mirror:
  Transport (KCP/TCP) → MessagePacking → NetworkBehaviour

FishNet:
  Transport (TugNet/UDP) → ServerManager/ClientManager → NetworkBehaviour

Photon (Quantum):
  Photon Transport → Deterministic Simulation → ECS Replication

自研引擎推荐:
  Transport → Reliability (多通道) → Session → Replication → GameLogic
```

### ⚡ 实战经验

1. **不要在游戏逻辑层直接调用 Socket**：这是分层最基本的要求。游戏代码应该只调用 `Replicate()` 或 `Rpc()` 这样的高层接口，永远不碰底层 Send/Recv。违反这一点会导致无法替换底层协议、无法做单元测试
2. **会话层和可靠性层不要混在一起**：很多新手把心跳、ACK、重传逻辑全塞在一个类里。当需要做断线重连时，重连逻辑和重传逻辑互相耦合，调试极其痛苦。分开后，重连只是 Session 层重新握手，Reliability 层无感知
3. **多通道是性能关键**：位置快照走不可靠通道（丢了无所谓，下一帧补上），技能释放走可靠通道（不能丢）。如果只有一个通道，要么全可靠（延迟高），要么全不可靠（数据丢失），都不理想
4. **接口设计要面向错误**：每一层都应该有明确的错误上报机制——Transport 断连通知 Reliability，Reliability 通知 Session，Session 通知 Replication，Replication 通知游戏逻辑做降级处理。用事件/委托而非返回值，避免层层 if 判断

### 🔗 相关问题

- 如何设计一个支持热切换传输协议（UDP ↔ QUIC ↔ WebSocket）的架构？
- Replication 层如何与 ECS（Entity Component System）集成？
- 为什么很多商业引擎把 Reliability 和 Session 合并？这种简化有什么隐患？
