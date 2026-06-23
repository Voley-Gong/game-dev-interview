---
title: "游戏网络连接状态机（Connection State Machine）如何设计？完整连接生命周期管理"
category: "network"
level: 3
tags: ["连接管理", "状态机", "握手", "断线重连", "会话管理", "网络架构"]
related: ["network/reconnect-state-recovery", "network/protocol-layer-architecture", "network/room-lifecycle-state-machine"]
hint: "从玩家点击'开始匹配'到游戏中断线重连——这中间连接经历了哪些状态？"
---

## 参考答案

### ✅ 核心要点

1. **连接生命周期**：Connecting → Handshaking → Authenticating → Loading → Playing → Paused → Reconnecting → Disconnected
2. **状态机核心职责**：管理每个阶段允许的操作、超时处理、状态转换条件和错误恢复
3. **握手层**：版本协商 → 加密协商 → 认证授权，每步都有超时和重试策略
4. **重连机制**：Session Token 保持 + 状态快照恢复，让玩家"无感"回到游戏
5. **优雅断开 vs 异常断开**：正常流程走 FIN/RST 清理资源，异常流程靠心跳超时检测

### 📖 深度展开

#### 完整状态机图

```
                    ┌──────────────┐
                    │   IDLE       │
                    │  (未连接)     │
                    └──────┬───────┘
                           │ Connect()
                           ▼
                    ┌──────────────┐
                    │  CONNECTING  │◄─────────┐
                    │  TCP/UDP握手  │          │
                    └──────┬───────┘          │
                           │ 连接建立          │ │ Reset/Timeout
                           ▼                  │ │ (5次重试)
                    ┌──────────────┐          │ │
                    │  HANDSHAKING │          │ │
                    │ 版本/加密协商 │          │ │
                    └──────┬───────┘          │ │
                           │ 版本匹配          │ │
                           ▼                  │ │
                    ┌──────────────┐          │ │
                    │AUTHENTICATING│          │ │
                    │ 登录/Token验证│          │ │
                    └──────┬───────┘          │ │
                           │ 认证成功          │ │
                           ▼                  │ │
                    ┌──────────────┐          │ │
                    │   LOADING    │          │ │
                    │ 加载场景/资源 │          │ │
                    └──────┬───────┘          │ │
                           │ 资源就绪          │ │
                           ▼                  │ │
     ┌─────────────┌──────────────┐          │ │
     │             │   PLAYING    │          │ │
     │  Heartbeat  │  (游戏中)     │          │ │
     │   Timeout   └──────┬───────┘          │ │
     │             │      │ Disconnect       │ │
     │             ▼      │ Detected         │ │
     │       ┌──────────┐ │                  │ │
     │       │  PAUSED  │◄┤                  │ │
     │       │ (暂停)   │ │                  │ │
     │       └────┬─────┘ │                  │ │
     │            │       │                  │ │
     │            │ Resume│ Manual Quit      │ │
     │            ▼       ▼                  │ │
     │       ┌──────────────┐                │ │
     └──────►│ RECONNECTING │────────────────┘ │
             │  (重连中)     │  Reconnect OK    │
             └──────┬───────┘                   │
                    │ 重连失败 (3次)             │
                    ▼                           │
             ┌──────────────┐                   │
             │ DISCONNECTED │───────────────────┘
             │  (已断开)     │  用户手动重连
             └──────────────┘
```

#### 握手协议详细流程

```cpp
// 阶段 1：版本协商
Client → Server: HelloMsg {
    protocolVersion: 3,
    clientVersion: "1.2.3",
    platform: "Android"
}
Server → Client: HelloAck {
    accepted: true,
    serverVersion: "1.2.3",
    // 协商加密方式
    cryptoSuite: AES256_GCM,
    // 服务器时间用于时钟同步
    serverTime: 1719504000000
}

// 阶段 2：认证
Client → Server: AuthMsg {
    sessionToken: "eyJhbG...",  // JWT 或自定义 Token
    // 或账号密码
    playerId: "12345",
    signature: HMAC(...)
}
Server → Client: AuthAck {
    result: OK,
    heartbeatInterval: 5000,  // 5s 心跳
    reconnectWindow: 30000    // 30s 重连窗口
}

// 阶段 3：进入游戏
Client → Server: ReadyMsg {
    assetVersion: "assets_v42",
    loaded: true
}
Server → Client: EnterGameMsg {
    roomId: "room_789",
    initialState: Snapshot{...},
    serverTickRate: 30
}
```

#### 状态转换表

| 当前状态 | 事件 | 目标状态 | 动作 |
|----------|------|----------|------|
| IDLE | Connect() | CONNECTING | 创建 Socket，发起连接 |
| CONNECTING | OnConnected | HANDSHAKING | 发送 HelloMsg |
| CONNECTING | Timeout(10s) | DISCONNECTED | 提示网络不可达 |
| HANDSHAKING | VersionMismatch | DISCONNECTED | 提示更新版本 |
| HANDSHAKING | HelloAck | AUTHENTICATING | 发送 AuthMsg |
| AUTHENTICATING | AuthOK | LOADING | 开始加载资源 |
| AUTHENTICATING | AuthFail | DISCONNECTED | 提示重新登录 |
| LOADING | LoadComplete | PLAYING | 发送 ReadyMsg |
| PLAYING | NetworkError | RECONNECTING | 启动重连定时器 |
| PLAYING | UserPause | PAUSED | 通知服务器暂停 |
| RECONNECTING | ReconnectOK | PLAYING | 恢复游戏状态 |
| RECONNECTING | Timeout(30s) | DISCONNECTED | 提示断线 |
| Any | UserQuit | DISCONNECTED | 发送 Bye，清理资源 |

#### 无感重连实现

```cpp
class ConnectionManager {
    SessionToken token;      // 会话令牌
    uint64_t lastSeq;        // 最后收到的包序号
    float reconnectTimer;
    int reconnectAttempts;
    static constexpr int MAX_RECONNECT = 3;
    static constexpr float RECONNECT_INTERVAL = 2.0f;
    
    void OnDisconnect(DisconnectReason reason) {
        if (reason == DisconnectReason::Graceful) {
            ChangeState(ConnectionState::DISCONNECTED);
            return;
        }
        // 异常断开 → 进入重连
        ChangeState(ConnectionState::RECONNECTING);
        reconnectAttempts = 0;
        reconnectTimer = 0;
    }
    
    void Update(float dt) {
        if (state == ConnectionState::RECONNECTING) {
            reconnectTimer += dt;
            if (reconnectTimer >= RECONNECT_INTERVAL) {
                reconnectTimer = 0;
                TryReconnect();
            }
        }
    }
    
    void TryReconnect() {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT) {
            ChangeState(ConnectionState::DISCONNECTED);
            return;
        }
        // 使用 Session Token 重连，而非重新认证
        network.Connect(token, lastSeq);
        // 服务器收到 lastSeq 后，补发缺失的包
    }
    
    void OnReconnectSuccess(ReconnectAck& ack) {
        // 服务器补发了 lastSeq 之后的所有缺失包
        // 应用状态恢复，回到 PLAYING
        ApplyMissedPackets(ack.missedPackets);
        ChangeState(ConnectionState::PLAYING);
    }
};
```

#### 心跳与超时设计

```
心跳机制:
  ┌─────────┐                    ┌─────────┐
  │ Client  │──── PING ────►     │ Server  │
  │         │◄─── PONG ────      │         │
  └─────────┘                    └─────────┘
  
  每 5s 发一次 PING
  连续 3 次未收到 PONG → 判定断线
  
  侧路：
  - PING 携带客户端时间戳 → 用于 RTT 估算
  - PONG 携带服务器最新帧号 → 可检测静默丢包
```

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| 心跳间隔 | 3-5s | 移动网络建议 3s |
| 超时阈值 | 3次心跳 ≈ 9-15s | 平衡检测速度与误判 |
| 重连窗口 | 30-60s | 超过则判定掉线 |
| 重连间隔 | 1-3s（指数退避） | 避免服务器雪崩 |

### ⚡ 实战经验

- **移动网络下重连要做指数退避**：手机网络波动时大量玩家同时重连会打垮服务器，1s→2s→4s 的退避比固定间隔更安全
- **Session Token 要有有效期和续期机制**：长时间挂机的玩家 Token 过期后重连会失败，需要静默续期
- **Loading 状态容易成为卡死死角**：资源加载中没有心跳超时机制是常见 Bug，Loading 阶段也必须维持心跳
- **区分"主动断开"和"网络波动"**：玩家主动退出走优雅清理流程，网络波动走重连流程，两者不能混用

### 🔗 相关问题

- 断线重连时如何恢复房间状态和游戏进度？
- 如何防止重连过程中的会话劫持？
- 大量玩家同时断线重连（服务器崩溃恢复）如何做限流？
