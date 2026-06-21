---
title: "实体插值与外推（Entity Interpolation & Extrapolation）如何实现平滑的远程玩家运动？"
category: "network"
level: 3
tags: ["实体插值", "外推", "平滑算法", "网络同步", "渲染补偿"]
related: ["network/client-side-prediction", "network/frame-vs-state-sync"]
hint: "服务器每秒推送 20 次位置快照，但客户端以 60fps 渲染——中间缺失的帧怎么补？"
---

## 参考答案

### ✅ 核心要点

1. **插值（Interpolation）**：在两个已收到的快照之间平滑过渡，代价是增加渲染延迟
2. **外推（Extrapolation）**：基于最新速度预测未来位置，延迟更低但会产生"橡皮筋"抖动
3. **插值延迟（Interpolation Delay）**：通常设为 1~2 个快照间隔（50~100ms），用于吸收网络抖动
4. **快照缓冲区（Snapshot Buffer）**：维护一个滑动窗口存放最近 N 个快照，作为插值的数据源
5. **混合策略**：近距离用插值保平滑，超时或高速运动时降级为外推保响应

### 📖 深度展开

#### 问题本质

服务器以固定频率（如 20Hz）广播实体状态快照。客户端渲染频率通常为 60fps 或更高。直接使用最新快照位置会导致两个问题：

- **低频更新导致运动卡顿**：两个快照之间有 50ms 空白，60fps 渲染会出现明显跳跃
- **网络抖动导致不稳定**：包到达时间不均匀，直接使用会造成忽快忽慢

#### 插值方案详解

```
时间轴：
  t=0    t=50   t=100  t=150  t=200ms（快照间隔50ms，即20Hz）
  S0 ─── S1 ─── S2 ─── S3 ─── S4   ← 收到的快照
              ↑
              当前渲染时刻（延迟100ms渲染）
              在 S0→S1 之间做线性插值
```

**核心思路**：永远"回放过去"——渲染延迟前的世界状态，在两个已知快照之间插值。

```csharp
// 快照数据结构
struct Snapshot {
    public float timestamp;   // 服务器时间戳
    public Vector3 position;
    public Quaternion rotation;
    public Vector3 velocity;
}

// 快照缓冲区（滑动窗口）
class SnapshotBuffer {
    private List<Snapshot> snapshots = new();
    private float interpolationDelay = 0.1f; // 100ms 渲染延迟

    // 添加新收到的快照
    public void AddSnapshot(Snapshot snap) {
        snapshots.Add(snap);
        // 保留最近1秒的数据即可
        while (snapshots.Count > 0 && snapshots[0].timestamp < snap.timestamp - 1.0f)
            snapshots.RemoveAt(0);
    }

    // 获取插值后的当前状态
    public Vector3 GetInterpolatedPosition(float currentServerTime) {
        float renderTime = currentServerTime - interpolationDelay;

        // 找到包围 renderTime 的两个快照
        for (int i = 0; i < snapshots.Count - 1; i++) {
            if (snapshots[i].timestamp <= renderTime && renderTime <= snapshots[i + 1].timestamp) {
                float t = (renderTime - snapshots[i].timestamp)
                        / (snapshots[i + 1].timestamp - snapshots[i].timestamp);
                return Vector3.Lerp(snapshots[i].position, snapshots[i + 1].position, t);
            }
        }

        // 如果找不到合适的区间，使用最新快照（降级处理）
        return snapshots[^1].position;
    }
}
```

#### 外推方案详解

当渲染时间超出最新快照时间戳（缓冲区不足时），用最新速度线性预测未来位置：

```csharp
public Vector3 GetExtrapolatedPosition(float currentServerTime) {
    if (snapshots.Count == 0) return Vector3.zero;

    var latest = snapshots[^1];
    float dt = currentServerTime - latest.timestamp;
    return latest.position + latest.velocity * dt;
}
```

#### 插值 vs 外推对比

| 维度 | 插值（Interpolation） | 外推（Extrapolation） |
|------|----------------------|----------------------|
| 额外延迟 | +50~100ms | 0ms |
| 视觉平滑度 | ✅ 非常平滑 | ❌ 突变时抖动（橡皮筋） |
| 准确性 | ✅ 100%准确（回放历史） | ❌ 预测可能偏离真实路径 |
| 适用场景 | RPG、策略、休闲游戏 | 竞技 FPS（配合 CSP） |
| 丢包容错 | 缺包时降级为外推 | 可短暂维持但不持久 |

#### 高级平滑技术

**Hermite 样条插值**：考虑快照的速度向量，生成更自然的曲线（Unity 的 `Vector3.SmoothDamp` 本质类似）：

```csharp
// Catmull-Rom 样条：用 4 个点拟合平滑曲线
Vector3 CatmullRom(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return 0.5f * (
        2f * p1 +
        (-p0 + p2) * t +
        (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2 +
        (-p0 + 3f * p1 - 3f * p2 + p3) * t3
    );
}
```

#### 自适应插值延迟

```
网络状态监控：
  基础延迟 = 2 × 快照间隔（如 100ms）
  动态调整 = 基础延迟 + Jitter Buffer
  ┌─────────────────────────────────────────┐
  │  if 抖动 < 20ms → delay = 70ms          │
  │  if 抖动 20~50ms → delay = 100ms        │
  │  if 抖动 > 50ms → delay = 150ms         │
  │  if 连续丢包 > 3 → delay += 50ms        │
  └─────────────────────────────────────────┘
```

### ⚡ 实战经验

1. **不要用 `Vector3.Lerp` 直接渲染最新位置**——那是"瞬移"，要用 `Vector3.Lerp` 在两个历史快照间插值，再用 `SmoothDamp` 做二次平滑消除量化精度误差
2. **旋转插值用 `Quaternion.Slerp` 而非 `Lerp`**——角度空间是球面的，线性插值会导致高速旋转时出现"走捷径"的错误朝向
3. **插值延迟不要固定写死**——网络状况在变化，固定 100ms 在好网络下浪费体验，在差网络下不够吸收抖动。根据 RTT 方差动态调整效果显著
4. **外推时加"最大外推时间"限制**——超过 200ms 仍未收到新快照就冻结实体，否则一个丢包玩家会"飞"到地图外

### 🔗 相关问题

- 本地玩家的 Client-Side Prediction 和远程玩家的 Entity Interpolation 如何协调？
- 当插值缓冲区耗尽（长时间丢包），如何优雅降级而不会让玩家看到瞬移？
- 快照频率、插值延迟、带宽占用三者如何权衡？
