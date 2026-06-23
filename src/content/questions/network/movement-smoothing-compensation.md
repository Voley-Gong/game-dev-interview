---
title: "网络游戏中角色移动平滑（Movement Smoothing）与运动补偿怎么做？"
category: "network"
level: 3
tags: ["移动平滑", "运动补偿", "Entity Interpolation", "表现层优化", "网络同步"]
related: ["network/entity-interpolation", "network/client-side-prediction", "network/jitter-buffer-design"]
hint: "服务器 20Hz 发位置，客户端 60Hz 渲染——中间缺失的帧怎么补？角色不能一格一格地跳。"
---

## 参考答案

### ✅ 核心要点

1. **基础插值（Linear Interpolation）**：在两个服务器快照间做线性插值，延迟一个快照周期消除抖动
2. **速度感知平滑（Velocity-Based Blending）**：利用快照中的速度信息预测运动方向，避免急停时的滑步
3. **外推与衰减（Extrapolation with Decay）**：当快照超时未到时短期外推，但外推距离需随时间衰减回弹
4. **动画驱动移动（Animation-Led Movement）**：移动速度和距离应受角色动画 RootMotion 或步幅约束，避免"滑冰"
5. **动态延迟调节**：根据网络抖动实时调节插值缓冲深度，在"手感延迟"和"画面平滑"间动态平衡

### 📖 深度展开

#### 问题本质：频率不匹配

```
服务器：    ●─────●─────●─────●─────●      20 Hz（50ms间隔）
             │     │     │     │     │
             │  ??? │ ??? │ ??? │ ??? │     缺失的中间状态
             │     │     │     │     │
客户端渲染： ●──●──●──●──●──●──●──●──●──●   60 Hz（16.7ms间隔）
            t0 t1 t2 t3 t4 t5 t6 t7 t8 t9

目标：在 t1~t4 之间生成平滑的中间位置
```

#### 方案分层：从简单到高级

| 层级 | 方案 | 延迟 | 平滑度 | 实现难度 |
|------|------|------|--------|----------|
| L0 | 直接设置位置 | 最低 | 最差（瞬移抖动） | ⭐ |
| L1 | 线性插值 | 1帧 | 一般（折线感） | ⭐⭐ |
| L2 | 速度感知插值 | 1帧 | 好 | ⭐⭐⭐ |
| L3 | Hermite/Catmull-Rom 样条 | 2帧 | 优秀 | ⭐⭐⭐⭐ |
| L4 | 预测+纠正（客户端预测） | 0（本地预测） | 优秀但复杂 | ⭐⭐⭐⭐⭐ |

#### L1：基础线性插值

```csharp
// 最简单的位置插值：延迟一个快照周期
public class NetworkTransform : MonoBehaviour
{
    private Vector3 _prevPos;    // 上一个快照位置
    private Vector3 _targetPos;  // 当前目标快照位置
    private float _elapsed;      // 当前插值进度
    private float _duration = 0.05f; // 快照间隔 50ms

    public void OnSnapshot(Vector3 pos)
    {
        _prevPos = _targetPos;
        _targetPos = pos;
        _elapsed = 0f;
    }

    void Update()
    {
        _elapsed += Time.deltaTime;
        float t = Mathf.Clamp01(_elapsed / _duration);
        // 在 prevPos 和 targetPos 之间插值
        transform.position = Vector3.Lerp(_prevPos, _targetPos, t);
    }
}
```

**问题**：角色加速/减速时会出现明显的"折线感"，转弯时尤其僵硬。

#### L2：速度感知平滑

```csharp
public class SmoothNetworkTransform : MonoBehaviour
{
    private Vector3 _prevPos, _targetPos;
    private Vector3 _velocity;      // 快照携带的速度
    private float _elapsed, _duration = 0.05f;

    public void OnSnapshot(Vector3 pos, Vector3 vel)
    {
        _prevPos = transform.position;  // 用当前渲染位置而非上一个快照位置
        _targetPos = pos;
        _velocity = vel;
        _elapsed = 0f;
    }

    void Update()
    {
        _elapsed += Time.deltaTime;
        float t = Mathf.Clamp01(_elapsed / _duration);

        // 基于速度的插值：减速时自然收敛
        // 使用 Critically Damped Spring（临界阻尼弹簧）
        float dampFactor = 1f - Mathf.Exp(-15f * Time.deltaTime);

        Vector3 predictedPos = _targetPos + _velocity * (_duration - _elapsed);
        Vector3 blendedPos = Vector3.Lerp(
            transform.position,
            predictedPos,
            dampFactor
        );

        transform.position = blendedPos;
    }
}
```

#### L3：Catmull-Rom 样条插值

```csharp
// 保留最近 4 个快照点，用 Catmull-Rom 样条生成平滑曲线
public class SplineInterpolation : MonoBehaviour
{
    private struct Snapshot
    {
        public Vector3 pos;
        public Vector3 vel;
        public float time;
    }

    private readonly List<Snapshot> _buffer = new();
    private float _renderDelay = 0.1f; // 延迟 100ms（2个快照）

    public void OnSnapshot(Vector3 pos, Vector3 vel, float serverTime)
    {
        _buffer.Add(new Snapshot { pos = pos, vel = vel, time = serverTime });
        // 保持缓冲区大小
        if (_buffer.Count > 6) _buffer.RemoveAt(0);
    }

    void Update()
    {
        if (_buffer.Count < 4) return;

        float renderTime = Time.time - _renderDelay;

        // 找到包围 renderTime 的两个快照
        int i = 1;
        while (i < _buffer.Count - 2 && _buffer[i + 1].time < renderTime)
            i++;

        // Catmull-Rom 插值
        Snapshot p0 = _buffer[i - 1];
        Snapshot p1 = _buffer[i];
        Snapshot p2 = _buffer[i + 1];
        Snapshot p3 = _buffer[i + 2];

        float t = (renderTime - p1.time) / (p2.time - p1.time);
        t = Mathf.Clamp01(t);

        transform.position = CatmullRom(p0.pos, p1.pos, p2.pos, p3.pos, t);
    }

    private Vector3 CatmullRom(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t)
    {
        float t2 = t * t;
        float t3 = t2 * t;
        return 0.5f * (
            2f * p1 +
            (-p0 + p2) * t +
            (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2 +
            (-p0 + 3f * p1 - 3f * p2 + p3) * t3
        );
    }
}
```

#### 动画同步：滑步问题

```
问题：网络位置更新了，但角色脚部动画没跟上 → "滑冰"效果

解决方案：
┌─────────────────────────────────────────────────┐
│ 1. RootMotion 驱动                              │
│    └─ 动画本身控制实际位移，网络只做方向修正     │
│    └─ 位置偏差通过缩放动画播放速度来吸收         │
│                                                   │
│ 2. 步幅匹配（Step Matching）                     │
│    └─ 根据网络移动速度动态调整动画速度参数       │
│    └─ animSpeed = networkSpeed / animBaseSpeed   │
│    └─ 限制在 [0.7, 1.3] 范围内避免畸形           │
│                                                   │
│ 3. 停步检测（Stop Detection）                    │
│    └─ 速度低于阈值时强制播放 Stop 动画           │
│    └─ 避免角色"原地踏步"                         │
└─────────────────────────────────────────────────┘
```

#### 动态延迟调节

```csharp
// 根据网络抖动自适应调节插值缓冲深度
public class AdaptiveInterpolationDelay
{
    private float _baseDelay = 0.1f;
    private float _maxDelay = 0.25f;
    private float _jitterEMA = 0f;  // 指数移动平均

    public float OnPacketArrival(float interArrivalTime)
    {
        // interArrivalTime: 相对上一包的到达间隔
        float expectedInterval = 0.05f; // 20Hz
        float jitter = Mathf.Abs(interArrivalTime - expectedInterval);

        // EMA 平滑
        _jitterEMA = 0.9f * _jitterEMA + 0.1f * jitter;

        // 动态调整：延迟 = base + 2σ
        float dynamicDelay = _baseDelay + 2f * _jitterEMA;
        return Mathf.Clamp(dynamicDelay, _baseDelay, _maxDelay);
    }
}
```

### ⚡ 实战经验

- **永远不要用 `transform.position = serverPos` 直接赋值**——这是最常见的新手错误。哪怕是最简单的游戏也需要至少 L1 线性插值，否则角色会像传送一样闪烁
- **转弯是平滑的重灾区**：线性插值在转弯时会产生"切角"效果。如果游戏有大量转向（如 MOBA），至少用 L2 速度感知方案，或直接上样条
- **移动端需要更激进的平滑**：移动网络抖动大但玩家对延迟容忍度低。可以使用更深的缓冲（150ms）配合预测纠正，在 WiFi 切换时避免角色瞬移
- **表现层做减法**：有时候最好的平滑方案是"减少需要平滑的信息"。例如只同步速度方向和大小，位置由客户端自己积分，服务器周期性纠正

### 🔗 相关问题

- Entity Interpolation 的缓冲深度应该设多少？如何平衡延迟和流畅度？
- 客户端预测与服务端纠正冲突时如何平滑过渡（Smooth Correction）？
- 高速运动（如载具、弹道）的网络插值有什么特殊处理？
