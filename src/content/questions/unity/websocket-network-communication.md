---
title: "Unity 中如何实现 WebSocket 网络通信？与 Protobuf 配合的最佳实践是什么？"
category: "unity"
level: 3
tags: ["WebSocket", "网络通信", "Protobuf", "实时对战"]
related: ["unity/netcode-gameobjects-architecture", "unity/network-sync"]
hint: "从 NativeWebSocket 到 Protobuf 序列化，再到重连与心跳——实时网络通信是一套完整工程"
---

## 参考答案

### ✅ 核心要点

1. **WebSocket 选型**：`NativeWebSocket`（纯 C# 实现，全平台兼容）是 Unity 最主流方案，`Best.HTTP/2` 是功能更强的付费替代
2. **消息协议**：Protobuf（Protocol Buffers）是游戏通信的事实标准——紧凑、跨语言、前向兼容
3. **心跳保活**：定时发送 Ping 消息，检测连接活性，超时自动重连
4. **断线重连**：指数退避重连策略 + 消息队列缓冲，保证重连后消息不丢失
5. **线程安全**：WebSocket 回调在子线程触发，必须通过 `ConcurrentQueue` 将消息分派到主线程处理

### 📖 深度展开

#### 网络方案对比

| 方案 | 协议 | 适用场景 | 优点 | 缺点 |
|------|------|----------|------|------|
| **HTTP REST** | HTTP/1.1 | 非实时（排行榜、商城） | 简单、CDN 友好 | 无推送、高延迟 |
| **WebSocket** | TCP | 实时双向通信（聊天、回合制） | 全双工、可靠传输 | 需自行处理粘包/重连 |
| **UDP/KCP** | UDP | 高速实时（FPS、MOBA） | 低延迟 | 不可靠、需自行实现可靠性 |
| **gRPC** | HTTP/2 | 微服务间通信 | 强类型、流式 | 移动端支持有限 |
| **Unity Netcode** | 多种 | 局域网/小型多人 | 开箱即用 | 大规模需配合 Relay |

#### WebSocket 通信架构

```
Unity Client                          Server
    │                                    │
    ├── WebSocket Connect ──────────────►│ Handshake (HTTP Upgrade)
    │                                    │
    │◄─────────── Connected ─────────────┤
    │                                    │
    ├── Heartbeat Ping (每5s) ─────────►│
    │◄──────────── Pong ─────────────────┤
    │                                    │
    ├── Protobuf Message ──────────────►│ (LoginReq)
    │◄────────── Protobuf Message ───────┤ (LoginResp)
    │                                    │
    ├── 断线检测 (15s 无响应) ──────────►│
    │     ↓                              │
    │  指数退避重连                       │
    │     1s → 2s → 4s → 8s → 15s        │
    │                                    │
    ├── WebSocket Reconnect ───────────►│
    │     ↓ 重连成功                      │
    │  发送缓冲队列中的消息 ─────────────►│
    └────────────────────────────────────┘
```

#### 完整 WebSocket 客户端实现

```csharp
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using NativeWebSocket;
using Google.Protobuf;
using UnityEngine;

public class NetworkManager : MonoBehaviour
{
    [Header("Connection")]
    [SerializeField] private string serverUrl = "wss://game.example.com/ws";
    [SerializeField] private float heartbeatInterval = 5f;
    [SerializeField] private float heartbeatTimeout = 15f;
    [SerializeField] private int maxReconnectAttempts = 5;

    private WebSocket _ws;
    private float _lastHeartbeatTime;
    private bool _isConnected;
    private int _reconnectAttempts;

    // 子线程 → 主线程的消息队列
    private readonly ConcurrentQueue<Action> _mainThreadActions = new();
    // 重连前缓冲的待发送消息
    private readonly Queue<byte[]> _sendBuffer = new();
    // 消息处理器注册表
    private readonly Dictionary<int, Action<byte[]>> _handlers = new();

    #region Lifecycle

    private void Update()
    {
        // 分派子线程回调到主线程
        while (_mainThreadActions.TryDequeue(out var action))
            action?.Invoke();

        // 心跳检测
        if (_isConnected && Time.time - _lastHeartbeatTime > heartbeatInterval)
        {
            SendHeartbeat();
            _lastHeartbeatTime = Time.time;
        }

        // 超时检测
        if (_isConnected && Time.time - _lastHeartbeatTime > heartbeatTimeout)
        {
            Debug.LogWarning("[Net] 心跳超时，准备重连");
            _ = ReconnectAsync();
        }
    }

    private async void OnApplicationQuit()
    {
        if (_ws != null)
            await _ws.Close();
    }

    #endregion

    #region Connection

    public async void Connect()
    {
        _ws = new WebSocket(serverUrl);

        _ws.OnOpen += () =>
        {
            _mainThreadActions.Enqueue(() =>
            {
                _isConnected = true;
                _reconnectAttempts = 0;
                _lastHeartbeatTime = Time.time;
                Debug.Log("[Net] WebSocket 已连接");
                FlushSendBuffer();
            });
        };

        _ws.OnMessage += (bytes) =>
        {
            _mainThreadActions.Enqueue(() => HandleMessage(bytes));
        };

        _ws.OnError += (msg) =>
        {
            _mainThreadActions.Enqueue(() =>
            {
                Debug.LogError($"[Net] WebSocket 错误: {msg}");
            });
        };

        _ws.OnClose += (code, reason) =>
        {
            _mainThreadActions.Enqueue(() =>
            {
                _isConnected = false;
                Debug.LogWarning($"[Net] 连接关闭: {code} - {reason}");
                if (_reconnectAttempts < maxReconnectAttempts)
                    _ = ReconnectAsync();
            });
        };

        // NativeWebSocket 需要在主线程轮询
        // 通常用 Update 中调用 _ws.DispatchMessageQueue()
        InvokeRepeating(nameof(DispatchMessageQueue), 0f, 0.02f);

        await _ws.Connect();
    }

    private void DispatchMessageQueue()
    {
    #if !UNITY_WEBGL || UNITY_EDITOR
        _ws?.DispatchMessageQueue();
    #endif
    }

    private async System.Threading.Tasks.Task ReconnectAsync()
    {
        _reconnectAttempts++;
        float delay = Mathf.Min(Mathf.Pow(2, _reconnectAttempts - 1), 15f);
        Debug.Log($"[Net] 第 {_reconnectAttempts} 次重连，等待 {delay}秒");

        await System.Threading.Tasks.Task.Delay(TimeSpan.FromSeconds(delay));
        Connect();
    }

    #endregion

    #region Messaging

    // 发送 Protobuf 消息
    public void Send<T>(int msgId, T message) where T : IMessage<T>
    {
        // 消息结构: [4字节 msgId][N字节 protobuf body]
        byte[] body = message.ToByteArray();
        byte[] packet = new byte[4 + body.Length];
        BitConverter.GetBytes(msgId).CopyTo(packet, 0);
        body.CopyTo(packet, 4);

        if (_isConnected)
        {
            _ws.SendBytes(packet);
        }
        else
        {
            _sendBuffer.Enqueue(packet); // 断线时缓冲
            if (_sendBuffer.Count > 100) _sendBuffer.Dequeue(); // 防止溢出
        }
    }

    private void FlushSendBuffer()
    {
        while (_sendBuffer.Count > 0)
        {
            _ws.SendBytes(_sendBuffer.Dequeue());
        }
    }

    private void SendHeartbeat()
    {
        Send(MsgId.Heartbeat, new HeartbeatReq { Timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() });
    }

    private void HandleMessage(byte[] data)
    {
        if (data.Length < 4) return;

        int msgId = BitConverter.ToInt32(data, 0);
        byte[] body = new byte[data.Length - 4];
        Buffer.BlockCopy(data, 4, body, 0, body.Length);

        if (_handlers.TryGetValue(msgId, out var handler))
        {
            handler.Invoke(body);
        }
        else
        {
            Debug.LogWarning($"[Net] 未注册的消息 ID: {msgId}");
        }
    }

    // 注册消息处理器
    public void RegisterHandler<T>(int msgId, Action<T> handler) where T : IMessage<T>, new()
    {
        _handlers[msgId] = (body) =>
        {
            var msg = new T();
            msg.MergeFrom(body); // Protobuf 反序列化
            handler.Invoke(msg);
        };
    }

    #endregion
}
```

#### Protobuf 消息定义示例

```protobuf
// proto/game_messages.proto
syntax = "proto3";

message HeartbeatReq {
    int64 timestamp = 1;
}

message HeartbeatResp {
    int64 server_time = 1;
}

message LoginReq {
    string account = 1;
    string token = 2;
    int32 client_version = 3;
}

message LoginResp {
    int32 code = 1;
    string player_id = 2;
    int32 level = 3;
    repeated ItemInfo items = 4;
}

message ItemInfo {
    string item_id = 1;
    int32 count = 2;
}
```

#### Protobuf 在 Unity 中的集成

```bash
# 方式一：NuGet 安装 Google.Protobuf + 手动引入 runtime
# 方式二：使用 protobuf-net（不需要 .proto 文件，直接用特性标注）
# 方式三：grpc-tools 预编译 .proto → C# 文件（推荐，运行时零反射）

# 推荐的构建流程：
# 1. 维护 .proto 文件在单独目录
# 2. CI/CD 中用 protoc 预编译生成 C# 代码
# 3. 生成的代码放入 Unity 项目的 Plugins/ProtobufGenerated/
# 4. 游戏逻辑引用生成的类型
```

#### 常见网络问题排查表

| 现象 | 可能原因 | 排查方法 |
|------|----------|----------|
| 连接后立刻断开 | 服务器拒绝、协议版本不匹配 | 查看服务器日志、检查子协议 |
| 收不到消息 | DispatchMessageQueue 未调用 | 确认 Update 或 InvokeRepeating 正常执行 |
| 游戏卡顿 | 序列化在主线程耗时过长 | 用 Profiler 检查 Protobuf 序列化耗时 |
| 连接不稳定 | MTU 不匹配、代理超时 | 心跳间隔 < 代理超时时间（通常 < 60s） |
| WebGL 连不上 | WSS 证书问题、跨域策略 | 必须用 WSS（不能在 HTTPS 页面用 WS） |
| iOS 后台断开 | App 进入后台后网络被系统暂停 | 在 `OnApplicationPause` 处理重连 |

### ⚡ 实战经验

1. **永远不要在 WebSocket 回调中直接访问 Unity API**——`OnMessage`、`OnOpen` 等回调在子线程触发，直接调用 `transform.position` 等 Unity API 会崩溃或出现不可预期的行为。必须通过 `ConcurrentQueue<Action>` 将逻辑切换到主线程。这是新手最常犯的错误。
2. **Protobuf 比 JSON 快 10 倍以上**——在网络通信场景，序列化/反序列化耗时直接影响帧率。一个包含 200 个玩家位置同步的消息，JSON 序列化可能需要 2-3ms，Protobuf 只要 0.2ms。对于高频同步（如 30Hz 位置同步），这个差距是决定性的。
3. **心跳间隔要小于服务器和中间代理的超时时间**——大多数云服务和反向代理（Nginx、AWS ALB）默认 WebSocket 空闲超时 60 秒。如果心跳间隔 > 60 秒，连接会被代理单方面关闭。推荐心跳间隔 5-15 秒。
4. **WebGL 平台 WebSocket 有特殊限制**——WebGL 不能使用 `System.Net.WebSockets`（线程限制），必须用 JS 层的 WebSocket。NativeWebSocket 已经处理了这个问题（内部通过 `jslib` 桥接），但要确保使用 WebGL 兼容的构建配置。

### 🔗 相关问题

- Unity 实时对战游戏该选 WebSocket（TCP）还是 KCP（UDP）？
- 如何实现帧同步（Lockstep）与状态同步（State Sync）的混合方案？
- Protobuf 的前向兼容和后向兼容在版本迭代中如何保证？
