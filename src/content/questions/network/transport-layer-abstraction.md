---
title: "如何在 UDP 之上构建游戏传输层抽象？多通道虚拟可靠性、消息分帧与拥塞控制的工程实践"
category: "network"
level: 4
tags: ["传输层", "UDP", "可靠性", "多通道", "网络架构"]
related: ["network/multi-channel-reliability-design", "network/reliable-udp-implementation", "network/protocol-layer-architecture"]
hint: "游戏需要可靠登录、不可靠位置、有序指令——如何在一条 UDP 连接上同时满足这些需求？"
---

## 参考答案

### ✅ 核心要点

1. **传输层抽象的核心目标**：在一条 UDP 连接上虚拟出多条逻辑通道，各自拥有独立的可靠性、有序性和优先级策略
2. **消息分帧（Framing）是基础**：每个包携带 Channel ID + Flags + Sequence Number，接收端按通道分发处理
3. **可靠性是可选层**：Reliable 通道叠加 ARQ（ACK/重传），Unreliable 通道直接透传，Sequenced 通道用序号丢弃旧包
4. **多通道独立流控**：每个通道维护独立的滑动窗口和序号空间，互不阻塞（不像 TCP 的全局队头阻塞）
5. **生产级参考**：ENet、KCP、GameNetworkingSockets（Valve）、Photon 都采用类似的通道化设计

### 📖 深度展开

#### 通道类型定义

```
┌──────────────────────────────────────────────────────────────┐
│                    一条 UDP 连接                              │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Channel 0│  │ Channel 1│  │ Channel 2│  │ Channel 3│    │
│  │ Reliable │  │ Reliable │  │ Unreliable│ │ Sequenced │    │
│  │ Ordered  │  │ Unordered│  │          │ │           │    │
│  │ 登录/交易 │  │ 战斗指令  │  │ 位置同步 │  │ 语音/特效 │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                                                              │
│  各通道独立的：序号空间 / 窗口 / ACK队列 / 重传计时器         │
└──────────────────────────────────────────────────────────────┘
```

| 通道类型 | 可靠 | 有序 | 丢包处理 | 典型用途 |
|---------|------|------|---------|---------|
| Reliable Ordered | ✅ | ✅ | 重传 | 登录、交易、聊天 |
| Reliable Unordered | ✅ | ❌ | 重传 | 战斗指令（顺序不重要） |
| Unreliable Sequenced | ❌ | ✅ | 丢弃旧包 | 位置同步、朝向 |
| Unreliable Unordered | ❌ | ❌ | 忽略 | 语音、爆炸特效 |

#### 数据包格式设计

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Channel ID   |    Flags      |       Sequence Number         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Ack Sequence (可靠通道)    |    Ack Bitmask (可靠通道)     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         Payload ...                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

**Flags 位定义：**

| Bit | 含义 |
|-----|------|
| 0-1 | 通道类型 (0=RelOrd, 1=RelUnord, 2=UnrelSeq, 3=Unrel) |
| 2 | 是否为 ACK 包 |
| 3 | 是否为分片包 |
| 4 | 是否为Ping/Pong（心跳） |
| 5-7 | 保留 |

#### 核心实现：通道发送逻辑

```cpp
// ========== 通道抽象基类 ==========
class IChannel {
public:
    virtual ~IChannel() = default;
    virtual void Send(const uint8_t* data, size_t len) = 0;
    virtual void OnPacketReceived(const Packet& pkt) = 0;
    virtual void OnTick(float deltaTime) {}  // 重传检查等
    virtual ChannelType GetType() const = 0;
};

// ========== Reliable Ordered 通道 ==========
class ReliableOrderedChannel : public IChannel {
    uint32_t m_localSeq = 0;       // 发送序号
    uint32_t m_remoteAckSeq = 0;   // 对方已确认的最大序号
    uint32_t m_expectedSeq = 0;    // 期望接收的下一个序号

    struct PendingPacket {
        uint32_t seq;
        std::vector<uint8_t> data;
        float resendTimer;
        int retryCount;
    };
    std::deque<PendingPacket> m_sendBuffer;  // 未确认队列
    std::map<uint32_t, std::vector<uint8_t>> m_recvBuffer; // 乱序缓存

public:
    void Send(const uint8_t* data, size_t len) override {
        Packet pkt;
        pkt.channelId = GetId();
        pkt.seq = m_localSeq++;
        pkt.payload.assign(data, data + len);

        // 写入底层 UDP
        m_transport->SendRaw(pkt);

        // 存入待确认队列
        PendingPacket pp{pkt.seq, pkt.payload, m_rto, 0};
        m_sendBuffer.push_back(std::move(pp));
    }

    void OnPacketReceived(const Packet& pkt) override {
        if (pkt.seq < m_expectedSeq) {
            return; // 重复包，丢弃
        }

        if (pkt.seq > m_expectedSeq) {
            // 乱序：缓存起来，等前面的包到达
            m_recvBuffer[pkt.seq] = pkt.payload;
            SendAck(pkt.seq); // 仍然 ACK，告知收到
            return;
        }

        // 按序到达：交付上层
        m_expectedSeq++;
        DeliverToUser(pkt.payload);

        // 检查缓存中是否有后续包可以连续交付
        while (m_recvBuffer.count(m_expectedSeq)) {
            DeliverToUser(m_recvBuffer[m_expectedSeq]);
            m_recvBuffer.erase(m_expectedSeq);
            m_expectedSeq++;
        }
    }

    void OnTick(float dt) override {
        for (auto& pp : m_sendBuffer) {
            pp.resendTimer -= dt;
            if (pp.resendTimer <= 0 && pp.retryCount < MAX_RETRIES) {
                m_transport->SendRaw(MakePacket(pp.seq, pp.data));
                pp.resendTimer = m_rto * (pp.retryCount + 1) * 1.2f; // 线性退避
                pp.retryCount++;
            }
        }
        // 处理收到的 ACK（从 ACK 包中提取）
        // 清理已确认的包...
    }
};

// ========== Unreliable Sequenced 通道 ==========
class UnreliableSequencedChannel : public IChannel {
    uint32_t m_localSeq = 0;
    uint32_t m_lastReceivedSeq = 0; // 低于此值直接丢弃

public:
    void Send(const uint8_t* data, size_t len) override {
        Packet pkt;
        pkt.channelId = GetId();
        pkt.seq = m_localSeq++;
        pkt.payload.assign(data, data + len);
        m_transport->SendRaw(pkt); // 发完就完，不存队列
    }

    void OnPacketReceived(const Packet& pkt) override {
        if (pkt.seq <= m_lastReceivedSeq) {
            return; // 旧包，直接丢弃（关键！）
        }
        m_lastReceivedSeq = pkt.seq;
        DeliverToUser(pkt.payload);
    }
    // 无需 OnTick，无需重传
};
```

#### Sequenced 通道为什么重要

位置同步使用 Unreliable Sequenced 通道是游戏网络的关键设计：

```
发送端（60fps，每帧一个位置包）：
  Seq=100: pos(10, 5, 3)  ← 丢失
  Seq=101: pos(10.1, 5, 3.1)
  Seq=102: pos(10.2, 5, 3.2)  ← 乱序到达
  Seq=103: pos(10.3, 5, 3.3)

接收端（使用 Sequenced 丢弃旧包）：
  收到 Seq=101 → 交付，lastSeq=101
  收到 Seq=103 → 交付，lastSeq=103
  收到 Seq=102 → 丢弃！（102 < 103，是旧位置，无意义）
  （Seq=100 永远没到，也不需要它）

如果用 Reliable Ordered：
  收到 Seq=101 → 缓存，等 100
  收到 Seq=103 → 缓存，等 100
  收到 Seq=102 → 缓存，等 100
  → 全部卡住等 100 的重传 → 角色卡顿 200ms+
```

#### ACK 压缩与批量确认

为减少 ACK 包数量，采用类似 SACK 的位图机制：

```cpp
// 每个 ACK 包携带 32-bit 的接收位图
struct AckHeader {
    uint16_t ackSeq;      // 已收到的最大连续序号
    uint16_t ackBitmask;  // ackSeq+1 ~ ackSeq+16 的接收状态
};

// 接收端每 N 个包或每 T 毫秒发送一个 ACK
// 发送端根据位图批量清理待确认队列
```

### ⚡ 实战经验

1. **通道数量控制在 4-8 个**：太多通道会增加每包的 header 开销和管理复杂度。实战中 4 个通道（RelOrd/RelUnord/UnrelSeq/Unrel）足够覆盖绝大多数需求
2. **Reliable 通道注意拥塞级联**：如果登录/交易通道积压大量未确认包，会挤占底层 UDP 发送窗口，影响位置同步通道。建议各通道共享底层带宽时有优先级调度——RelOrd 低优先级、UnrelSeq 高优先级
3. **包大小控制在 MTU 以内**：UDP 包超过 MTU（通常 1400 字节）会在 IP 层分片，丢一个分片整包作废。要么在应用层做分片重组（如 KCP 的 frg 字段），要么控制每包 payload 不超过 1200 字节
4. **调试工具：通道级统计面板**：线上问题排查必须能看到每个通道的发包率、丢包率、重传次数、RTT。没有这个面板等于盲调

### 🔗 相关问题

- ENet 的通道机制与本方案有什么区别？
- 如何在传输层之上实现加密与防重放？
- TCP 也有多路复用（HTTP/2 Streams），为什么不适合游戏？
