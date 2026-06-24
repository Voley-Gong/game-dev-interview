---
title: "游戏网络包如何做流量整形与 QoS 标记（Traffic Shaping & DSCP）？"
category: "network"
level: 3
tags: ["流量整形", "QoS", "DSCP", "带宽管理", "网络优化"]
related: ["network/bandwidth-budget-rate-limiting.md", "network/network-priority-scheduling.md", "network/protocol-layer-architecture.md"]
hint: "为什么同样走 UDP，语音包比状态同步包更先到达？DSCP 标记和令牌桶怎么用？"
---

## 参考答案

### ✅ 核心要点

1. **流量整形（Traffic Shaping）**：在发送端控制发包速率和节奏，避免突发流量（Burst）撑满网络缓冲区导致拥塞丢包
2. **令牌桶算法（Token Bucket）**：经典整形方案，按类别为不同消息队列分配速率配额，实现差异化带宽管理
3. **DSCP 标记**：在 IP 头部 TOS 字段标记优先级（EF/AFx），让中间路由器优先转发实时游戏包
4. **包优先级分层**：语音 > 输入/位置同步 > 加载进度 > 聊天 > 资源下载
5. **分通道发送**：将不同优先级的包走不同的 UDP socket（或不同端口），配合操作系统和路由器的 QoS 策略

### 📖 深度展开

#### 流量整形的必要性

没有流量整形的网络层，发包时序往往呈现"突发"模式：

```
无整形：
  t=0ms   ████ 50 packets burst （Tick 结束时一次性发出）
  t=50ms  （静默）
  t=50ms  ████ 50 packets burst
  
问题：
  - 突发包超过路由器队列容量 → 尾部丢弃（Tail Drop）
  - 中间节点缓冲膨胀（Bufferbloat）→ RTT 飙升
  - 丢包重传进一步加剧拥塞

有整形（Token Bucket, 1000 pkt/s）：
  t=0ms   ██ 10 packets
  t=1ms   ██ 10 packets
  t=2ms   ██ 10 packets
  ...均匀分布，不触发拥塞
```

#### 令牌桶实现

```csharp
public class TokenBucket
{
    private float _tokens;
    private readonly float _maxTokens;    // 桶容量（允许短时突发）
    private readonly float _refillRate;   // 每秒补充令牌数
    private float _lastRefillTime;

    public TokenBucket(float rate, float burstSize)
    {
        _refillRate = rate;
        _maxTokens = burstSize;
        _tokens = burstSize;
        _lastRefillTime = Time.time;
    }

    public bool TryConsume(int tokensNeeded = 1)
    {
        Refill();
        if (_tokens >= tokensNeeded)
        {
            _tokens -= tokensNeeded;
            return true;
        }
        return false; // 令牌不足，包进入队列等待
    }

    private void Refill()
    {
        float now = Time.time;
        float elapsed = now - _lastRefillTime;
        _tokens = Mathf.Min(_maxTokens, _tokens + elapsed * _refillRate);
        _lastRefillTime = now;
    }
}
```

#### 多通道优先级调度

```
┌─────────────────────────────────────────────────────────┐
│              Packet Priority Channels                    │
├──────────┬──────────────┬──────────────┬────────────────┤
│ Priority │ Channel      │ Token Bucket │ DSCP Marking   │
├──────────┼──────────────┼──────────────┼────────────────┤
│ P0 最高  │ 输入同步包   │ 无限制       │ EF (46)        │
│          │ 位置快照     │              │ Expedited      │
│          │              │              │ Forwarding     │
├──────────┼──────────────┼──────────────┼────────────────┤
│ P1 高    │ VOIP 语音包  │ 64 pkt/s     │ EF (46)        │
│          │ 关键事件     │ burst 128    │                │
├──────────┼──────────────┼──────────────┼────────────────┤
│ P2 中    │ 普通状态同步 │ 200 pkt/s    │ AF41 (34)      │
│          │ AOI 更新     │ burst 300    │ Assured        │
│          │              │              │ Forwarding     │
├──────────┼──────────────┼──────────────┼────────────────┤
│ P3 低    │ 聊天消息     │ 10 pkt/s     │ AF11 (10)      │
│          │ 表情/贴纸    │ burst 20     │                │
├──────────┼──────────────┼──────────────┼────────────────┤
│ P4 最低 │ 资源预加载   │ 50 KB/s      │ BE (0)         │
│          │ 补丁下载    │ (字节限速)   │ Best Effort    │
│          │ 回放录制上传│              │                │
└──────────┴──────────────┴──────────────┴────────────────┘
```

#### 发送管线整合

```csharp
public class NetworkSendPipeline
{
    private readonly Channel[] _channels;
    private readonly UdpClient _socket;

    // 每个通道独立的令牌桶和队列
    class Channel
    {
        public int Priority;
        public Queue<Packet> Queue = new();
        public TokenBucket Bucket;
        public byte DscpValue;
    }

    public void Send(Packet pkt)
    {
        var ch = _channels[(int)pkt.Type];
        ch.Queue.Enqueue(pkt);
    }

    // 网络线程主循环
    public void SendLoop()
    {
        while (_running)
        {
            // 按优先级从高到低遍历
            foreach (var ch in _channels.OrderBy(c => c.Priority))
            {
                while (ch.Queue.Count > 0 && ch.Bucket.TryConsume())
                {
                    var pkt = ch.Queue.Dequeue();
                    SetDscp(pkt, ch.DscpValue);
                    _socket.Send(pkt.Data, pkt.Data.Length, pkt.Endpoint);
                }
            }
            Thread.Sleep(1); // 1ms 粒度
        }
    }

    private void SetDscp(Packet pkt, byte dscp)
    {
        // Linux: setsockopt SO_TOS
        // Windows: SIO_SET_QOS 或 setsockopt IP_TOS
        // 注意：需要管理员权限（Linux CAP_NET_ADMIN 或 root）
        pkt.SetSocketOption(SocketOptionLevel.IP,
            SocketOptionName.TypeOfService, dscp << 2);
    }
}
```

#### DSCP 值对照表

| DSCP 值 | 名称 | 编号 | 用途 | 路由器行为 |
|---------|------|------|------|-----------|
| EF | Expedited Forwarding | 46 | 实时输入/语音 | 最高优先队列，低延迟 |
| AF41 | Assured Forwarding | 34 | 状态同步 | 中高优先，有保证带宽 |
| AF31 | | 26 | 重要事件 | 中优先 |
| AF11 | | 10 | 聊天/非关键 | 低优先 |
| BE | Best Effort | 0 | 后台下载 | 尽力而为 |

> ⚠️ **注意**：DSCP 标记只在启用了 QoS 策略的网络中有效。家庭宽带运营商通常会清除 DSCP 标记（重写为 0），因此它主要用于：
> - 数据中心内部（游戏服务器 → 边缘节点）
> - 企业/校园网络
> - 部分 ISP（如 Comcast Business）保留 DSCP

#### Bufferbloat 与 CoDel/LQM

```
  问题：路由器队列满 → 所有包排队 → RTT 从 30ms 涨到 300ms+
  
  解决方案（客户端侧）：
  ┌──────────────────────────────────────┐
  │  LQM (Link Quality Manager)          │
  │                                      │
  │  监测 min RTT 和当前 RTT 的比值      │
  │  如果 RTT / minRTT > 3：             │
  │    → 主动降低发送速率 30%            │
  │    → 直到 RTT 恢复到 minRTT * 1.5    │
  └──────────────────────────────────────┘
```

### ⚡ 实战经验

- **分通道比 DSCP 更实际**：DSCP 在公网上大概率被擦除，但不同端口走不同 QoS 策略在家庭路由器上是可控的（如游戏路由器的"游戏加速"功能）。语音走独立端口+独立 socket 是最有效的方案
- **突发包是延迟杀手**：一个 Tick 内集中发 100 个包，比 100ms 内匀速发 100 个包的效果差 10 倍。令牌桶不是可选项而是必选项
- **移动网络下 QoS 几乎无效**：4G/5G 网络的核心网有自己的调度策略，DSCP 标记不会被尊重。移动端只能依赖应用层整形+前向纠错（FEC）
- **监控 RTT 变化是发现整形问题的最佳手段**：如果 min RTT 很低（20ms）但 P99 RTT 很高（200ms+），说明中间节点存在 Bufferbloat，需要在发送端加强整形

### 🔗 相关问题

- 带宽预算（Bandwidth Budget）与流量整形如何配合？总量超限时优先牺牲哪个通道？
- FEC 前向纠错和流量整形有冲突吗？冗余包应该走哪个优先级通道？
- 在 WebRTC 游戏中，如何利用内置的 GCC（Google Congestion Control）算法做自适应流量整形？
