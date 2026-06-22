---
title: "如何从零实现一个可靠的 UDP 层？序列号、滑动窗口、ACK 机制详解"
category: "network"
level: 3
tags: ["UDP", "可靠性层", "ARQ", "滑动窗口", "序列号", "面试高频"]
related: ["network/kcp-protocol-deep-dive", "network/protocol-selection", "network/rtt-jitter-packetloss"]
hint: "TCP 太慢、KCP 是黑盒——如果让你自己造一个可靠 UDP 轮子，你需要解决哪些问题？"
---

## 参考答案

### ✅ 核心要点

1. **序列号（Sequence Number）**：每个包分配单调递增的序号，接收方据此检测丢包、去重、排序
2. **ACK 确认机制**：接收方对收到的包返回确认，发送方据此移除重传队列中的包——可选择 Cumulative ACK 或 SACK
3. **滑动窗口（Sliding Window）**：控制在途未确认包的数量，兼顾吞吐量与流控
4. **超时重传 + 快速重传**：RTO 超时触发重传；收到重复 ACK 触发快速重传，两条腿走路
5. **连接管理**：握手（SYN）、心跳（Keep-Alive）、断线检测、挥手（FIN）——可靠性层也需要状态机

### 📖 深度展开

#### 整体架构

```
┌──────────────────────────────────────────────┐
│           应用层（游戏逻辑）                    │
├──────────────────────────────────────────────┤
│           可靠性层（本层实现）                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ 发送模块  │ │ 接收模块  │ │ 连接状态机    │ │
│  │ - 序列号  │ │ - 去重   │ │ - 握手/挥手   │ │
│  │ - 滑动窗口│ │ - 排序   │ │ - 心跳检测    │ │
│  │ - 重传队列│ │ - ACK生成│ │ - 超时断连    │ │
│  └──────────┘ └──────────┘ └──────────────┘ │
├──────────────────────────────────────────────┤
│           传输层（UDP Socket）                 │
└──────────────────────────────────────────────┘
```

#### 1. 序列号设计

```csharp
public struct PacketHeader
{
    public uint Sequence;       // 序列号（循环回绕）
    public uint Ack;            // 确认号（累积确认）
    public uint AckBitfield;    // SACK 位域（选择性确认）
    public ushort Flags;        // SYN/ACK/FIN/DATA
    public ushort PayloadLen;   // 负载长度
}
```

序列号回绕处理——`uint` 有 42 亿个序号，但在高速场景（如 60Hz 发包）约 2 年回绕一次。比较序号时使用**有符号差值**：

```csharp
// 正确的序号比较（处理回绕）
static bool IsNewer(uint s1, uint s2)
{
    return (int)(s1 - s2) > 0;
}

static int SeqDistance(uint s1, uint s2)
{
    return (int)(s1 - s2);
}
```

#### 2. ACK 机制：Cumulative vs SACK

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| Cumulative ACK | 确认"序号 ≤ N 的所有包已收到" | 简单，ACK 包小 | 一个包丢失会"卡住"后续确认 |
| SACK（选择性确认） | 位域标记每个包的接收状态 | 精确告知哪些包丢了 | ACK 包稍大 |
| **混合方案** | Cumulative + SACK 位域 | 兼顾效率和精度 | 实现稍复杂 |

**推荐混合方案**——ACK 头部同时包含 Cumulative ACK 和 32-bit SACK 位域：

```
收到包:  100 101 102  ✗104  105  ✗106  107
ACK 头部:
  Ack = 102            ← 累积确认：102 及之前都收到
  AckBitfield = 0b00000101  ← bit0=104收到, bit1=105✗, bit2=106✗, bit3=107收到
                           实际含义：104, 107 已收到（相对于 Ack+1 的偏移）
```

```csharp
// 接收方：构建 ACK
public PacketHeader BuildAck()
{
    var header = new PacketHeader();
    header.Ack = _recvHighestContinuous; // 累积确认

    // SACK 位域：标记 Ack 之后的 32 个包
    header.AckBitfield = 0;
    for (int i = 0; i < 32; i++)
    {
        uint seq = _recvHighestContinuous + 1 + (uint)i;
        if (_receivedPackets.Contains(seq))
            header.AckBitfield |= (1u << i);
    }
    return header;
}

// 发送方：处理收到的 ACK
public void ProcessAck(PacketHeader ackHeader)
{
    // 累积确认：移除 ≤ Ack 的包
    while (_sendBuffer.Count > 0)
    {
        var seg = _sendBuffer.First;
        if (SeqDistance(seg.Seq, ackHeader.Ack) <= 0)
        {
            // 计算 RTT
            _sendBuffer.RemoveFirst();
            UpdateRtt(seg);
        }
        else break;
    }

    // SACK：移除位域中标记为已收的包
    for (int i = 0; i < 32; i++)
    {
        if ((ackHeader.AckBitfield & (1u << i)) != 0)
        {
            uint seq = ackHeader.Ack + 1 + (uint)i;
            _sendBuffer.RemoveAll(s => s.Seq == seq);
        }
    }
}
```

#### 3. 滑动窗口

```
发送窗口示意（窗口大小 WindowSize = 8）：

已确认        在途（未确认）        未发送
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1 2 3 4 5 │ 6 7 8 9 10 11 12 13 │ 14 15 ...
            └──── 滑动窗口 ────┘

- 窗口左边界 = 最小未确认序号
- 窗口右边界 = 左边界 + WindowSize - 1
- 只有在窗口内的包才能发送
- 每收到一个 ACK，窗口向右滑动
```

```csharp
public bool CanSend()
{
    return InFlightCount < _windowSize;
}

public void SendPending(byte[] data)
{
    while (CanSend() && _sendQueue.Count > 0)
    {
        var seg = _sendQueue.Dequeue();
        seg.Seq = _nextSeq++;
        seg.SendTime = GetTimeMs();
        _sendBuffer.AddLast(seg);     // 加入重传队列
        _socket.Send(seg.Serialize());
        InFlightCount++;
    }
}
```

**动态窗口调整**：根据 RTT 和丢包率自适应

```csharp
// 简化的 AIMD（加性增，乘性减）流控
void OnAckReceived()
{
    // 网络好：线性增加窗口
    _windowSize = Math.Min(_windowSize + 1, MAX_WINDOW);
}

void OnTimeout()
{
    // 网络差：窗口减半
    _windowSize = Math.Max(_windowSize / 2, MIN_WINDOW);
}
```

#### 4. 重传策略

```
                    收到 ACK
                        │
               ┌────────┴────────┐
               │                 │
          正常确认            重复 ACK ≥ 3
          移除包                 │
                            快速重传
                          （不等超时）

                    ┌──────────────┐
                    │  RTO 定时器   │
                    └──────┬───────┘
                           │
                      超时触发
                     重传 + 退避
```

```csharp
public void Update(long nowMs)
{
    // 超时重传检测
    foreach (var seg in _sendBuffer)
    {
        if (nowMs - seg.SendTime > _rto)
        {
            // 超时重传
            seg.SendTime = nowMs;
            seg.RetransmitCount++;
            _socket.Send(seg.Serialize());

            // 指数退避（或线性退避，根据策略）
            _rto = Math.Min(_rto * 2, MAX_RTO);

            if (seg.RetranslimiteCount > MAX_RETRIES)
            {
                _state = ConnectionState.Disconnected;
                break;
            }
        }
    }

    // 快速重传检测
    if (_dupAckCount >= FAST_RETRANSMIT_THRESHOLD)
    {
        FastRetransmit();
        _dupAckCount = 0;
    }
}
```

#### 5. RTT 估算

```csharp
//加权移动平均（与 TCP RFC 6298 类似）
void UpdateRtt(Segment ackedSeg)
{
    long r = GetTimeMs() - ackedSeg.SendTime;  // Sample RTT

    if (!_srttInitialized)
    {
        _srtt = r;
        _rttvar = r / 2;
        _srttInitialized = true;
    }
    else
    {
        // SRTT = 7/8 * SRTT + 1/8 * R
        _srtt = (_srtt * 7 + r) / 8;
        // RTTVAR = 3/4 * RTTVAR + 1/4 * |SRTT - R|
        _rttvar = (_rttvar * 3 + Math.Abs(_srtt - r)) / 4;
    }

    // RTO = SRTT + max(G, K * RTTVAR)，G 为时钟粒度
    _rto = _srtt + Math.Max(CLOCK_GRANULARITY_MS, 4 * _rttvar);
    _rto = Math.Clamp(_rto, MIN_RTO, MAX_RTO);
}
```

### ⚡ 实战经验

1. **不要重传重传的包**：一个包如果已经被快速重传过，它的 RTT 样本是不可靠的（无法区分原始包的 ACK 还是重传包的 ACK）。必须排除重传包的 RTT 样本，或使用 Timestamp 方案（在包头放发送时间戳）
2. **ACK 捎带（Piggybacking）省带宽**：游戏是双向通信，数据包头部天然携带 ACK 信息。纯 ACK 包只在无数据发送时才单独发，可以大幅减少 ACK 的小包数量
3. **区分可靠通道和不可靠通道**：同一个 UDP 连接上开两个逻辑通道——可靠通道走重传机制（如聊天消息、技能释放），不可靠通道直接丢弃不重传（如位置快照）。多数游戏框架（如 ENet）就是这么做的
4. **连接迁移问题**：UDP 是无连接的，玩家从 WiFi 切到 4G 时 IP 变了。如果用 IP:Port 做连接标识会导致断连。应使用 Connection ID（类似 QUIC）来标识会话，底层 IP 变化对上层透明

### 🔗 相关问题

- KCP、ENet、GameNetworkingSockets 的可靠性层各有什么优劣？
- QUIC 已经是可靠 UDP 了，游戏可以直接用 QUIC 替代自研吗？
- 在弱网环境（丢包率 30%+）下，滑动窗口和重传策略应该如何调参？
