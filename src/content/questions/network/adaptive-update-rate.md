---
title: "游戏中如何实现自适应同步频率（Adaptive Update Rate）？根据网络质量动态调整发送速率"
category: "network"
level: 3
tags: ["自适应同步", "流量控制", "QoS", "带宽优化"]
related: ["network/tick-rate-vs-network-rate", "network/rtt-jitter-packetloss", "network/bandwidth-budget-rate-limiting"]
hint: "玩家网络时好时坏，固定频率发送要么浪费带宽要么卡顿——如何让同步频率自己适配？"
---

## 参考答案

### ✅ 核心要点

1. **核心动机**：固定发送频率在弱网下浪费带宽（高丢包重发），在好网络下又利用不充分——自适应频率根据 RTT、丢包率、Jitter 动态升降
2. **核心算法**：类似 TCP 拥塞控制的思路——探测可用带宽，成功则加性增（AI），丢包则乘性减（MD），在游戏场景中需更平滑
3. **分层策略**：关键状态（位置/生命）高频、非关键状态（表情/装饰）低频，配合 AOI 距离做空间维度降频
4. **实现位置**：可工作在传输层（调整发包间隔）、编码层（调整量化精度）、或调度层（选择哪些实体本期发送）
5. **与 TCP BBR / QUIC 的关系**：现代传输层已有内建拥塞控制，游戏应用层的自适应更多是做"在有限带宽预算内分配优先级"

### 📖 深度展开

#### 自适应频率的整体架构

```
                    ┌─────────────────────────┐
   网络指标采集      │   Network Monitor        │
   RTT / Jitter     │   ┌───────────────────┐ │
   Packet Loss  ───→│   │ EWMA 平滑滤波器    │ │
   Bandwidth        │   └────────┬──────────┘ │
                    └────────────┼─────────────┘
                                 │
                    ┌────────────▼─────────────┐
   频率决策          │  Rate Controller          │
                    │  ┌─────────────────────┐  │
                    │  │ AIMD / PID 控制器   │  │
                    │  │ targetHz = f(metrics)│  │
                    │  └──────────┬──────────┘  │
                    └─────────────┼─────────────┘
                                  │
                    ┌─────────────▼─────────────┐
   分级调度          │  Priority Scheduler       │
                    │  Tier 1: 位置/动作 → 高频 │
                    │  Tier 2: 属性/状态 → 中频 │
                    │  Tier 3: 外观/特效 → 低频 │
                    │  Tier 4: 远距离实体 → 降频│
                    └───────────────────────────┘
```

#### 网络质量监测

```cpp
struct NetworkQuality {
    float rtt;           // EWMA 平滑后的 RTT (ms)
    float jitter;        // RTT 标准差 (ms)
    float packetLoss;    // 丢包率 (0~1)
    float availableBps;  // 估算可用带宽 (bytes/sec)
};

// EWMA（指数加权移动平均）平滑
class NetworkMonitor {
    static constexpr float ALPHA = 0.1f; // 平滑因子
    
    float ewmaRtt = 50.0f;
    float ewmaJitter = 5.0f;
    float ewmaLoss = 0.0f;
    
    void onPacketAcked(float measuredRtt) {
        // RTT 平滑
        ewmaRtt = ALPHA * measuredRtt + (1 - ALPHA) * ewmaRtt;
        
        // Jitter = RTT 与 EWMA RTT 的偏差
        float deviation = fabs(measuredRtt - ewmaRtt);
        ewmaJitter = ALPHA * deviation + (1 - ALPHA) * ewmaJitter;
    }
    
    void onPacketLost() {
        ewmaLoss = ALPHA * 1.0f + (1 - ALPHA) * ewmaLoss;
    }
    
    void onPacketReceived() {
        ewmaLoss = ALPHA * 0.0f + (1 - ALPHA) * ewmaLoss;
    }
    
    // 网络质量评分 0~1，越高越好
    float getQualityScore() {
        // 简化模型：RTT < 50ms 满分，>300ms 归零
        float rttScore = clamp(1.0f - (ewmaRtt - 50.0f) / 250.0f, 0, 1);
        // 丢包率 < 1% 满分，> 10% 归零
        float lossScore = clamp(1.0f - (ewmaLoss - 0.01f) / 0.09f, 0, 1);
        // Jitter < 10ms 满分，> 80ms 归零
        float jitterScore = clamp(1.0f - (ewmaJitter - 10.0f) / 70.0f, 0, 1);
        
        return rttScore * 0.4f + lossScore * 0.4f + jitterScore * 0.2f;
    }
};
```

#### AIMD 速率控制器

```cpp
class AdaptiveRateController {
    NetworkMonitor& monitor;
    
    float currentHz = 20.0f;       // 当前发送频率
    float minHz = 5.0f;            // 最低频率（保证基本可玩）
    float maxHz = 60.0f;           // 最高频率
    float additiveIncrease = 1.0f; // 每秒可增加的 Hz
    float multiplicativeDecrease = 0.5f; // 降速因子
    
    float qualityThreshold = 0.7f; // 质量好于此值才尝试加速
    
    void update(float dt) {
        float quality = monitor.getQualityScore();
        
        if (quality < 0.3f) {
            // 网络很差：快速降频
            currentHz *= (1.0f - multiplicativeDecrease * dt);
        } else if (quality < qualityThreshold) {
            // 网络一般：维持当前频率
        } else {
            // 网络良好：缓慢加频
            currentHz += additiveIncrease * dt;
        }
        
        currentHz = clamp(currentHz, minHz, maxHz);
    }
    
    float getSendInterval() const {
        return 1.0f / currentHz;
    }
};
```

#### 优先级分级调度

| 层级 | 数据类型 | 频率倍率 | 说明 |
|------|---------|---------|------|
| Tier 0 | 本机玩家输入/位置 | 1.0x | 始终以满频率发送 |
| Tier 1 | 附近玩家位置/动作 | 1.0x | 战斗核心数据 |
| Tier 2 | 中距离实体状态 | 0.5x | 隔帧发送 |
| Tier 3 | 远距离实体 | 0.25x | 每 4 帧发送一次 |
| Tier 4 | 静态/装饰数据 | 0.1x | 仅变化时发送 |

```cpp
bool shouldSendThisTick(Entity& entity, int tickCount, float adaptiveHz) {
    int tier = computeEntityTier(entity);  // 0~4
    
    // 每个 tier 对应一个跳帧间隔
    static const int skipInterval[] = {1, 1, 2, 4, 10};
    int interval = skipInterval[tier];
    
    return (tickCount % interval) == 0;
}
```

#### 与传输层拥塞控制的协调

```
应用层自适应          传输层拥塞控制 (KCP/QUIC)
     │                        │
     │  ┌──────────────────┐  │
     │  │  目标：在有限     │  │
     ├──│  带宽内最大化     │──┤
     │  │  游戏体验质量     │  │
     │  └──────────────────┘  │
     │                        │
     ▼                        ▼
  调整发送内容              调整发送速率
  (哪些实体/哪些字段)       (窗口大小/ACK策略)
```

> **关键区分**：传输层拥塞控制回答"网络能承受多少？"，应用层自适应回答"在有限带宽下发送什么最有价值？"两者协同工作。

### ⚡ 实战经验

1. **降频要平滑，升频要谨慎**：频率骤降会让玩家感觉卡顿，建议在 2-3 帧内渐变过渡；升频时探测更慢，避免刚恢复就再次拥塞（ping-pong 效应）
2. **不要只看丢包率**：有些 WiFi 网络丢包率低但 Jitter 极大（bufferbloat），这种情况下高频小包反而比低频大包更糟。Jitter 权重在移动端要调高
3. **留足安全余量**：估算的可用带宽打 7 折再作为目标，网络波动比想象中剧烈。在移动端尤其要注意基站切换（handoff）瞬间的吞吐崩塌
4. **客户端可感知性**：当频率从 30Hz 降到 10Hz 时，客户端插值要相应调整（延长插值窗口），否则画面会抖动。降频和插值参数必须联动

### 🔗 相关问题

- AOI（兴趣区域）系统如何与自适应频率配合？远距离实体降到多少频率合适？
- KCP 的拥塞窗口和发送间隔参数，与应用层的自适应频率如何协调避免重复降频？
- 在 4G/5G/WiFi 切换时，自适应频率策略如何快速响应？检测切换的信号是什么？
