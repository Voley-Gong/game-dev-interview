---
title: "游戏服务器 Tick Rate 和网络发包频率（Network Send Rate）如何解耦设计？"
category: "network"
level: 3
tags: ["Tick Rate", "网络频率", "帧率解耦", "性能优化", "服务器架构"]
related: ["network/snapshot-delta-sync", "network/bandwidth-budget-rate-limiting", "network/jitter-buffer-design"]
hint: "逻辑服务器跑 60 tick，但客户端每秒只收到 20 个包——中间的差值谁来补？答案：解耦 simulation tick 和 network send rate。"
---

## 参考答案

### ✅ 核心要点

1. **Tick Rate（逻辑帧率）**：服务器以固定频率推进游戏逻辑模拟（如 60Hz/128Hz），保证物理确定性和手感
2. **Network Send Rate（网络频率）**：服务器向客户端发送状态同步包的频率（如 10-30Hz），受带宽和 CPU 限制
3. **解耦策略**：逻辑 Tick 多次后取快照发送，而非每个 Tick 都发包；通过累积/聚合减少冗余数据
4. **客户端补偿**：收到低频快照后，用插值/外推弥补中间帧的视觉空白
5. **自适应调节**：根据网络状况和负载动态调整 Send Rate，而非一刀切固定值

### 📖 深度展开

#### 为什么不能每个 Tick 都发包？

假设服务器以 128 tick 运行 CS:GO 风格的 FPS，如果每个 tick 都给每个客户端发包：

```
128 tick × 64 players × 1500 bytes/snapshot = 12.288 MB/s per player
```

这在实际中完全不可行。即便 30Hz 发包：

```
30 send/s × 1500 bytes = 45 KB/s per player（勉强可接受）
```

所以 **Tick Rate 和 Send Rate 必须解耦**。

#### 典型架构图

```
┌─────────────────────────────────────────────┐
│              Game Server                     │
│                                              │
│  ┌──────────────┐    Simulation Tick 60Hz    │
│  │  Game Logic   │◄──────────────────────────┤
│  │  (Physics,    │                           │
│  │   AI, Rules)  │   ┌───────────────────┐   │
│  └──────┬────────┘   │  Snapshot Accu-   │   │
│         │            │  mulator (每3 tick │   │
│         │            │   生成一次快照)     │   │
│         ▼            └────────┬──────────┘   │
│  ┌──────────────┐             │              │
│  │  World State  │─────────────┤              │
│  │  (Authoritative)│           ▼              │
│  └──────────────┘    Send Rate 20Hz           │
│                                │              │
│                    ┌───────────┴───────────┐  │
│                    │  Delta Compression    │  │
│                    │  + Priority Queue     │  │
│                    └───────────┬───────────┘  │
│                                │              │
└────────────────────────────────┼──────────────┘
                                 ▼
                         ┌───────────────┐
                         │  UDP / KCP    │
                         └───────┬───────┘
                                 ▼
                    ┌────────────────────────┐
                    │  Client                │
                    │  Receive 20Hz snapshot │
                    │  Interpolation 60fps   │
                    │  (渲染帧率独立)         │
                    └────────────────────────┘
```

#### 解耦参数对比

| 参数 | 典型值 | 说明 |
|------|--------|------|
| Tick Rate | 30-128 Hz | 逻辑模拟频率，越高手感越好 |
| Send Rate | 10-30 Hz | 网络发包频率，受带宽约束 |
| Render Rate | 30-144 fps | 客户端渲染帧率，与服务器无关 |
| Interpolation Buffer | 2-3 snapshots | 平滑插值所需的快照缓冲 |

#### 不同游戏的经典配置

| 游戏 | Tick Rate | Send Rate | 设计考量 |
|------|-----------|-----------|----------|
| CS2 (sub-tick) | 64/128 | 64/128 Hz | 竞技极致，Tick=Send |
| Valorant | 128 | 128 Hz | 同上，FPS 竞技标杆 |
| League of Legends | 30 | 10-30 Hz | 策略游戏，低频够用 |
| PUBG | 30 | 20 Hz | 大地图，带宽受限 |
| MMO (FF14) | ~10-20 | 5-10 Hz | 万人同屏，极致省带宽 |

#### 代码示例：Snapshot 累积器

```csharp
public class NetworkSendManager
{
    private readonly int _tickRate;      // 逻辑帧率 60
    private readonly int _sendRate;      // 网络频率 20
    private int _tickCount;
    private int _ticksPerSend;           // 60/20 = 3
    private readonly SnapshotAccumulator _accumulator;

    public void OnLogicTick(WorldSnapshot snapshot)
    {
        _tickCount++;
        _accumulator.Accumulate(snapshot); // 每帧累积变化

        if (_tickCount % _ticksPerSend == 0)
        {
            var deltaSnapshot = _accumulator.BuildDeltaSnapshot();
            SendToClients(deltaSnapshot);  // 每3 tick发一次
            _accumulator.Reset();
        }
    }

    // 自适应调整：根据网络质量动态调节
    public void AdjustSendRate(float rtt, float packetLoss)
    {
        if (packetLoss > 0.05f || rtt > 200f)
        {
            _sendRate = Mathf.Max(10, _sendRate - 2); // 降频保命
            _ticksPerSend = _tickRate / _sendRate;
        }
        else if (rtt < 50f && packetLoss < 0.01f)
        {
            _sendRate = Mathf.Min(30, _sendRate + 1); // 网络好就提频
            _ticksPerSend = _tickRate / _sendRate;
        }
    }
}
```

#### 自适应 Send Rate 策略

```
网络状况判定：
  RTT < 50ms,  Loss < 1%  →  High Quality:   Send 30Hz, 全量字段
  RTT 50-100ms, Loss < 3% →  Normal Quality:  Send 20Hz, 重要字段优先
  RTT > 100ms, Loss > 5%  →  Low Quality:     Send 10Hz, 仅核心位置/血量
```

### ⚡ 实战经验

1. **竞技游戏 Tick=Send Rate**：CS2、Valorant 等硬核 FPS 服务器 128 tick 且 128Hz 发包，不为每个玩家省钱——公平性和手感压倒一切。但成本极高，需要社区服务器或赛事专用
2. **大世界 MMO 的 Send Rate 要极低**：8-10Hz 足够，客户端用航位推测（Dead Reckoning）填补间隙。玩家不会因为 100ms 没收到包就觉得卡
3. **Sub-Tick 架构是趋势**：CS2 不再"提升 Tick Rate"，而是在低 Tick 下记录精确时间戳，在客户端做 Sub-Tick 插值。这是兼顾成本和精度的巧妙方案
4. **监控 Send Rate 的实际带宽**：开发阶段一定要可视化每个玩家的上行/下行带宽，Send Rate 改动直接影响成本，运维会对这个数字非常敏感

### 🔗 相关问题

- 状态同步中的快照机制如何与 Delta Compression 配合减少带宽？
- 客户端插值缓冲应该设置多大？收到乱序包怎么处理？
- Sub-Tick 架构（CS2）与传统高 Tick Rate 相比有什么优劣？
