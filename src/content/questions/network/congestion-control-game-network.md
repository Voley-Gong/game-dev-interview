---
title: "游戏网络中的拥塞控制策略：TCP CUBIC/Reno vs QUIC BBR vs KCP/ENet 深度对比"
category: "network"
level: 3
tags: ["拥塞控制", "KCP", "QUIC", "BBR", "TCP", "带宽探测", "面试高频"]
related: ["network/kcp-protocol-deep-dive", "network/adaptive-update-rate", "network/bandwidth-budget-rate-limiting"]
hint: "同样是从服务器发数据到客户端，为什么 TCP 在丢包时会「卡住」而 KCP 不会？拥塞控制算法决定了游戏的生死线。"
---

## 参考答案

### ✅ 核心要点

1. **拥塞控制的目标**：在公平共享网络带宽的前提下，尽可能充分利用链路，同时避免拥塞崩溃——核心矛盾是「探测带宽」与「避免加剧拥塞」
2. **TCP 的 AIMD 模型**（Reno/CUBIC）：加性增（每 RTT +1 包）、乘性减（丢包窗口 ÷2），稳态吞吐量在丢包率高的链路上急剧下降——这是游戏用 TCP 感觉「卡」的根因
3. **BBR（Bottleneck Bandwidth and Round-trip）**：基于带宽探测而非丢包驱动，Google 在 QUIC/TCP 中采用，显著改善高丢包链路吞吐——但游戏实时包的优先级与 BBR 的批量发送逻辑存在张力
4. **KCP 的策略**：不做传统拥塞控制，牺牲公平性换取低延迟——普通模式允许快速重传、可选关闭拥塞窗口，使其在 20%+ 丢包链路下仍能维持实时性
5. **游戏专用拥塞控制设计**：区分「实时状态包」（不可靠、可丢、不做拥塞退避）和「关键事件包」（可靠、重传、有限拥塞响应），按通道分别管控

### 📖 深度展开

#### TCP 拥塞控制回顾：从 Reno 到 CUBIC

TCP 拥塞控制经历了三代演进：

```
┌─────────────┬──────────┬──────────────┬───────────────────┐
│   算法       │ 探测信号  │  窗口调整     │  稳态吞吐特征       │
├─────────────┼──────────┼──────────────┼───────────────────┤
│ Reno (1988) │ 丢包      │ AIMD (+1/-½) │ 丢包率↑ → 吞吐↓↑²   │
│ CUBIC(2008) │ 丢包      │ 三次函数增长   │ 高BDP链路更好       │
│ BBR  (2016) │ RTT×带宽  │ 带宽探测模型   │ 高丢包链路不退避    │
└─────────────┴──────────┴──────────────┴───────────────────┘
```

**Reno/CUBIC 的核心问题在游戏场景中：**

```math
吞吐量 ≈ MSS × 1.22 / (RTT × √丢包率)
```

在 2% 丢包、100ms RTT 的移动网络下，一条 TCP 连接的稳态吞吐只有约 **3 Mbps**——而 UDP 同条件下可以跑到链路上限。这就是为什么实时游戏几乎不用 TCP。

#### BBR：基于模型而非丢包

BBR 的核心思路：

```
1. 测量最小 RTT（基础延迟，排除排队）
2. 测量最大带宽（瓶颈链路容量）
3. BDP = 带宽 × RTT → 稳态窗口 = BDP
4. 周期性探测：窗口 ×1.25（探测更多带宽），然后回到稳态
```

```python
# BBR 简化伪代码
class BBRCongestionControl:
    def __init__(self):
        self.min_rtt = float('inf')
        self.max_bandwidth = 0
        self.state = 'PROBE_BW'

    def on_ack(self, rtt, packets_acked, time_delta):
        self.min_rtt = min(self.min_rtt, rtt)
        bw = packets_acked / time_delta
        self.max_bandwidth = max(self.max_bandwidth, bw)

        bdp = self.max_bandwidth * self.min_rtt
        if self.state == 'PROBE_BW':
            self.cwnd = bdp * 1.25  # 探测更多带宽
        else:
            self.cwnd = bdp          # 稳态

    def on_loss(self):
        pass  # BBR 不因丢包退避！这与TCP截然不同
```

**BBR 在游戏中的问题**：BBR 发送突刺（probe）可能短暂占用游戏包的队列，造成 Jitter。QUIC 中的 BBRv2 做了改进，加入了一定丢包响应。

#### KCP 的「反拥塞控制」哲学

KCP 的设计哲学与 TCP 相反——**不追求公平，追求低延迟**：

```
KCP 模式对比：
┌────────────┬───────────────────┬───────────────────────┐
│   模式      │  拥塞窗口          │  重传策略               │
├────────────┼───────────────────┼───────────────────────┤
│ 普通(none)  │ 关闭               │ 快速重传 (3 ACK)        │
│ 流控(wnd)   │ 固定窗口            │ 快速重传 + 窗口限制     │
│ 默认        │ 开启(可选关闭)       │ RTO×1.5 退避（温和）    │
└────────────┴───────────────────┴───────────────────────┘
```

```cpp
// KCP 关闭拥塞窗口的典型配置
ikcpcb *kcp = ikcp_create(conv, user);
kcp->stream = 1;        // 流模式
ikcp_nodelay(kcp, 1, 10, 2, 1);  // nodelay=1, interval=10ms, resend=2, nc=1(关闭拥塞控制)
ikcp_wndsize(kcp, 128, 128);     // 发送/接收窗口
```

`nc=1`（no congestion）是 KCP 在游戏中的常用配置——不做拥塞退避，即使丢包也不降低发送速率。这在共享链路上不公平，但对游戏实时性至关重要。

#### 游戏专用多通道拥塞管理

现代游戏网络库（如 GameNetworkingSockets、NNG）采用**多通道+差异化拥塞控制**：

```
┌──────────────────────────────────────────────────┐
│                 连接 (Connection)                  │
├────────────┬────────────┬─────────────────────────┤
│ 通道 0:     │ 通道 1:     │ 通道 2:                  │
│ 实时状态    │ 可靠事件    │ 大数据块                  │
│ (Unreliable)│ (Reliable)  │ (Reliable+Ordered)       │
├────────────┼────────────┼─────────────────────────┤
│ 不退避      │ 轻度退避    │ 完整拥塞控制              │
│ 丢就丢      │ 重传有限次  │ AIMD/BBR                 │
│ 最高优先级  │ 中优先级    │ 低优先级                  │
├────────────┼────────────┼─────────────────────────┤
│ 位置/朝向   │ 开火/受伤  │ 地图/资源加载             │
│ 血量/弹药   │ 拾取/任务  │ 补丁/热更新               │
└────────────┴────────────┴─────────────────────────┘
```

```csharp
// 多通道拥塞控制伪代码
public class GameCongestionManager
{
    private const int MaxBandwidth = 5_000_000; // 5 Mbps 预算

    public void Send(ChannelType channel, byte[] data)
    {
        switch (channel)
        {
            case ChannelType.Realtime:
                // 永远发送，不做拥塞退避
                transport.SendUnreliable(data);
                break;

            case ChannelType.ReliableEvent:
                // 有预算上限，但退避温和（只降 20%）
                if (currentUsage < MaxBandwidth * 0.8)
                    transport.SendReliable(data, maxRetries: 3);
                break;

            case ChannelType.Bulk:
                // 完整 AIMD 拥塞控制，像 TCP 一样公平
                if (congestionWindow > data.Length)
                {
                    transport.SendReliable(data, maxRetries: 10);
                    congestionWindow += MSS;  // 加性增
                }
                break;
        }
    }

    public void OnPacketLoss(ChannelType channel)
    {
        if (channel == ChannelType.Bulk)
            congestionWindow /= 2;  // 乘性减
        // Realtime 通道不响应丢包
    }
}
```

#### 各方案在实际游戏中的选型参考

| 游戏类型 | 推荐方案 | 原因 |
|---------|---------|------|
| FPS/TPS 竞技 | UDP + KCP(nc=1) 或 自定义可靠UDP | 延迟敏感，丢包可容忍 |
| MOBA | UDP + 多通道差异化拥塞 | 兼顾实时性和技能可靠性 |
| MMO RPG | UDP + BBR-like + 分级同步 | 带宽敏感，玩家密度变化大 |
| 回合制/卡牌 | TCP/WebSocket | 延迟不敏感，简单可靠 |
| 大逃杀(100人) | UDP + QUIC/自定义 + 前向纠错(FEC) | 高并发 + 弱网容忍 |

### ⚡ 实战经验

- **别用 TCP 做实时同步**：即使在 1% 丢包的"正常"WiFi 下，TCP 的重传和拥塞退避也会引入 200ms+ 的 stall，这在竞技游戏中是不可接受的
- **KCP nc=1 的代价**：关闭拥塞控制后，在 NAT 后的共享网络（如公司WiFi）中会挤占其他流量，可能导致 IT 封端口；建议做带宽上限（如 1Mbps）
- **BBR 不是银弹**：BBR 在 10%+ 丢包的移动网络下确实好于 CUBIC，但它的 probe 阶段会造成周期性的 Jitter 尖峰，对游戏手感有影响；很多项目最终用的是 BBR 变体 + 自定义抖动平滑
- **监控拥塞信号**：不要只看 RTT 和丢包率，还要监控「重传率」「乱序率」「Jitter」——当这三个指标同时上升时，说明链路已进入拥塞状态，应在应用层主动降频（减少非关键同步）

### 🔗 相关问题

- KCP 的 fast resend（快速重传）触发条件和退避策略具体是什么？
- QUIC 在游戏中相比 UDP+自定义可靠层有什么优势和劣势？
- 当服务器上行带宽成为瓶颈时，如何在不同玩家之间公平分配带宽？
