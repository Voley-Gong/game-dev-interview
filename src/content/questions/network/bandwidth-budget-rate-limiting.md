---
title: "游戏网络同步中如何做带宽预算与限速策略？"
category: "network"
level: 3
tags: ["带宽优化", "限速", "流量控制", "QoS"]
related: ["network/snapshot-delta-sync", "network/aoi-priority-scheduling", "network/field-level-delta-encoding"]
hint: "每个玩家的上行带宽是有限的，如何在数千实体中分配？优先级队列 + 令牌桶 + AOI 裁剪三层联动"
---

## 参考答案

### ✅ 核心要点

1. **带宽预算** 是对每个客户端上下行流量的硬性配额规划，通常按 128KB/s 或 256KB/s 设计上限
2. **限速策略** 通过令牌桶（Token Bucket）或漏桶（Leaky Bucket）控制每包/每秒发送量
3. **优先级调度** 确保关键数据（玩家自身状态、战斗事件）优先于次要数据（远处实体、环境特效）
4. **动态带宽分配** 根据网络质量（RTT、丢包率）自适应调整发送频率和数据精度
5. **监控与预警** 在服务端实时统计每连接流量，超限时降级而非断连

### 📖 深度展开

#### 带宽预算模型

以一款 MOBA 游戏（10 人对局）为例，假设玩家上行带宽 512KB/s、下行 1MB/s：

```
┌─────────────────────────────────────────────┐
│           单客户端下行带宽预算 (1MB/s)          │
├──────────┬──────────┬────────────────────────┤
│ 自身状态  │ 战斗事件  │ 其他实体快照 (AOI 范围内) │
│ 16 KB/s  │ 64 KB/s  │ 最多 9 × 32KB = 288KB/s │
├──────────┼──────────┼────────────────────────┤
│ 系统消息  │ 聊天/信令 │ 预留缓冲                │
│ 8 KB/s   │ 16 KB/s  │ ~640 KB/s              │
└──────────┴──────────┴────────────────────────┘
```

#### 令牌桶限速实现

```cpp
struct TokenBucket {
    float capacity;      // 桶容量（允许突发）
    float tokens;        // 当前令牌数
    float refillRate;    // 每秒补充令牌数
    float lastRefillTime;

    bool TryConsume(float cost) {
        Refill();
        if (tokens >= cost) {
            tokens -= cost;
            return true;
        }
        return false; // 被限速
    }

    void Refill() {
        float now = GetTime();
        float elapsed = now - lastRefillTime;
        tokens = std::min(capacity, tokens + elapsed * refillRate);
        lastRefillTime = now;
    }
};
```

#### 优先级队列 + 带宽分配

```cpp
enum class NetPriority : uint8_t {
    Immediate,   // 断线、踢人 → 无条件发送
    High,        // 玩家自身移动、技能释放
    Normal,      // AOI 内其他实体状态
    Low,         // 远处实体、环境对象
    Background,  // 背景数据（排行榜、商店）
};

// 每帧按优先级分配带宽预算
struct BandwidthAllocator {
    float budgetPerFrame; // = totalBandwidth / tickRate

    bool Enqueue(NetMsg& msg, NetPriority priority) {
        float cost = msg.EstimateSize();
        float& remaining = budget[priority];

        if (remaining >= cost) {
            remaining -= cost;
            sendQueues[priority].push(msg);
            return true;
        }

        // 尝试向低优先级借带宽
        if (TryBorrowFromLower(priority, cost)) {
            sendQueues[priority].push(msg);
            return true;
        }

        // 降级策略：降低更新频率或丢弃
        return TryDegrade(msg, priority);
    }
};
```

#### 动态自适应调节

```cpp
// 根据网络质量动态调整发送策略
void UpdateAdaptiveRate(const NetworkMetrics& metrics) {
    if (metrics.packetLoss > 0.1f) {
        // 丢包严重：降低发送频率，加大冗余包
        tickRate = 15;  // 从 30 降到 15
        redundancyFactor = 2;
    } else if (metrics.rtt > 200ms) {
        // 高延迟：减少实体同步数量，增大 AOI 裁剪半径收缩
        aoiRadius *= 0.8f;
        tickRate = 20;
    } else {
        // 网络良好：恢复正常
        tickRate = 30;
        redundancyFactor = 1;
    }
}
```

#### 限速策略对比

| 策略 | 实现复杂度 | 优点 | 缺点 | 适用场景 |
|------|-----------|------|------|---------|
| 固定限速 | ★☆☆ | 简单可靠 | 浪费带宽、不灵活 | 小型游戏 |
| 令牌桶 | ★★☆ | 允许突发、平滑限速 | 需调参 | 大多数多人游戏 |
| 漏桶 | ★★☆ | 严格匀速 | 无突发能力 | 语音/视频流 |
| 优先级队列 | ★★★ | 精细化分配 | 复杂度高 | MMO、Battle Royale |
| 自适应限速 | ★★★★ | 动态最优 | 实现难度大 | 竞技类、跨区游戏 |

### ⚡ 实战经验

- **带宽预算要从设计阶段开始规划**：很多项目到测试期才发现带宽超标，被迫大幅砍同步频率，手感急剧下降。建议在原型期就做带宽估算表
- **令牌桶的突发容量很关键**：游戏流量天然是突发的（技能连招、多人同时出现），纯匀速限速会导致关键事件延迟。桶容量设为 refillRate 的 2-3 倍比较合理
- **移动网络要特别处理**：4G/5G 切换时 RTT 会瞬间飙升到 500ms+，自适应限速要能在 1-2 秒内检测并降级，否则玩家会直接掉线
- **服务端统计要用百分位数而非平均值**：带宽均值 100KB/s 但 P99 可能 300KB/s，按平均值做预算会导致部分玩家持续卡顿

### 🔗 相关问题

- AOI 算法如何与带宽预算联动，在不同玩家密度下动态调整同步范围？
- 状态同步的增量更新（Delta Compression）能节省多少带宽？如何量化测量？
- 在弱网环境下（丢包 20%+），应该优先降低哪些数据的发送频率？
