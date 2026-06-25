---
title: "航位推测（Dead Reckoning）在游戏网络同步中如何应用？从 DIS 标准到现代 FPS 的演进"
category: "network"
level: 3
tags: ["Dead Reckoning", "航位推测", "DR模型", "带宽优化", "网络同步"]
related: ["network/entity-interpolation", "network/client-side-prediction", "network/adaptive-update-rate"]
hint: "为什么军事仿真中 1000 个实体只需要 1Hz 的发送频率？秘密在于接收端用物理模型'外推'出中间帧。"
---

## 参考答案

### ✅ 核心要点

1. **核心思想**：发送端不每帧发送完整状态，而是发送"运动模型参数"（位置、速度、加速度、角速度），接收端据此自行计算中间帧的位置——大幅降低带宽
2. **DR 模型（Dead Reckoning Model）**：定义外推公式，最常见的是匀速/匀加速直线运动模型，接收端用公式推算实体在任意时刻 T 的位置
3. **阈值触发更新（Threshold-Based Update）**：当实体真实位置与 DR 模型预测位置的偏差超过阈值时，才发送新的更新包——大多数时间不需要发包
4. **源于 DIS（Distributed Interactive Simulation）**：美国国防部 DIS 标准最早系统化定义了 DR 机制，用于大规模军事仿真中数千实体的实时同步
5. **与现代插值/预测的关系**：DR 是"外推"（Extrapolation），Entity Interpolation 是"内插"（Interpolation），CSP 是"预测+纠正"——三者经常组合使用

### 📖 深度展开

#### DR 模型分类

DIS 标准定义了 9 种 DR 模型（Entity Coordinate / World Coordinate × 静止/匀速/匀加速/带角速度），游戏中最常用的有 3 种：

| DR 模型 | 公式 | 适用场景 | 带宽节省 |
|---------|------|----------|----------|
| Static | `P(t) = P₀` | 站立的 NPC / 建筑 | ~99% |
| Constant Velocity | `P(t) = P₀ + V₀·Δt` | 直线移动的载具 / 怪物巡逻 | ~90% |
| Constant Acceleration | `P(t) = P₀ + V₀·Δt + ½·a·Δt²` | 加速/减速的赛车 / 弹道 | ~80% |

> **Δt** = 当前时间 t - 上次更新时间 t₀

#### 阈值更新机制（Threshold-Based Update）

```
发送端逻辑（每帧执行）：
┌─────────────────────────────────────────┐
│  1. 更新实体真实状态（物理模拟）          │
│  2. 用 DR 模型计算"接收端认为的位置"       │
│  3. 计算偏差 = |真实位置 - DR预测位置|    │
│  4. if 偏差 > 阈值:                      │
│        发送状态更新包（位置+速度+加速度）   │
│        更新 DR 基准点 = 当前真实状态       │
│  5. else: 不发包（带宽节省！）             │
└─────────────────────────────────────────┘

接收端逻辑（每帧执行）：
┌─────────────────────────────────────────┐
│  1. 收到更新包 → 用新参数刷新 DR 基准      │
│  2. 未收到更新 → 用 DR 模型外推当前位置     │
│      P(now) = P₀ + V₀·Δt + ½·a·Δt²      │
│  3. 渲染 DR 预测的位置                    │
└─────────────────────────────────────────┘
```

#### 阈值的艺术

阈值是 DR 的核心调参点，直接影响带宽与准确度的权衡：

```
                    帯宽消耗 ↑
                    │
        高阈值 ────┼──── 低带宽，高偏差
        (10cm+)    │     远程实体"飘"得明显
                    │
        低阈值 ────┼──── 高带宽，低偏差
        (1cm)      │     接近逐帧同步的精度
                    │
        最优阈值 ──┼──── 人眼不可察觉的偏差
        (2-5cm)    │     网游中的甜蜜点
                    ↓
                    同步精度 ↑
```

**实际项目中阈值通常是自适应的**：
- 近处实体：阈值小（玩家看得清）→ 更频繁更新
- 远处实体：阈值大（看不清细节）→ 节省带宽
- 高速运动实体：阈值可稍大（运动模糊掩盖偏差）

#### 与现代同步技术的关系

```
┌──────────────┬──────────────┬──────────────┐
│ Entity       │ Dead         │ Client-Side  │
│ Interpolation│ Reckoning    │ Prediction   │
│              │              │              │
│ 内插(过去)    │ 外推(未来)    │ 预测+纠正    │
│              │              │              │
│ 延迟换平滑    │ 带宽换精度    │ 延迟换即时性 │
│              │              │              │
│ 快照同步常用  │ 大规模实体   │ 本地玩家常用 │
│ (MMO/FPS观察)│ (RTS/军事)   │ (FPS本地角色)│
└──────────────┴──────────────┴──────────────┘

现代游戏通常组合使用：
  本地玩家 → CSP（预测+纠正）
  附近实体 → Entity Interpolation（内插）
  远处实体 → Dead Reckoning（外推+阈值更新）
```

#### 代码示例：基础 DR 实现

```csharp
// DR 模型状态
public struct DRState
{
    public Vector3 Position;
    public Vector3 Velocity;
    public Vector3 Acceleration;
    public float   AngularVelocity; // Y轴角速度
    public float   Timestamp;       // 上次更新时间
}

// 发送端：阈值检测
public class DRSender
{
    const float Threshold = 0.03f; // 3cm 阈值
    
    DRState lastSent; // 上次发送的 DR 基准
    Entity  entity;   // 真实实体
    
    public void Tick(float currentTime)
    {
        // 计算接收端当前会用 DR 算出的位置
        Vector3 predicted = Extrapolate(lastSent, currentTime);
        
        // 真实位置 vs DR 预测位置的偏差
        float error = Vector3.Distance(entity.Position, predicted);
        
        if (error > Threshold)
        {
            // 偏差超阈值，发送更新
            var update = new DRState
            {
                Position     = entity.Position,
                Velocity     = entity.Velocity,
                Acceleration = entity.Acceleration,
                AngularVelocity = entity.AngularVelocity,
                Timestamp    = currentTime
            };
            Network.Send(update);
            lastSent = update;
        }
    }
}

// 接收端：DR 外推
public class DRReceiver
{
    DRState latest;
    
    public void OnUpdate(DRState state)
    {
        latest = state; // 刷新 DR 基准
    }
    
    public Vector3 GetRenderPosition(float currentTime)
    {
        return Extrapolate(latest, currentTime);
    }
    
    static Vector3 Extrapolate(DRState s, float now)
    {
        float dt = now - s.Timestamp;
        // P(t) = P₀ + V₀·t + ½·a·t²
        return s.Position 
             + s.Velocity * dt 
             + s.Acceleration * (0.5f * dt * dt);
    }
}
```

### ⚡ 实战经验

1. **"弹出"问题（Popping/Snap）**：当阈值触发时，接收端渲染位置会从 DR 预测值瞬间跳到新更新值——必须加平滑过渡（Lerp/Slerp 100-200ms），否则玩家看到实体"瞬移"
2. **转弯场景是 DR 的噩梦**：匀速直线模型在转弯时偏差极大，项目中常给载具使用"带角速度的 DR 模型"，或者在转弯时临时降低阈值增大发送频率
3. **不要对受击/碰撞实体使用 DR**：碰撞是离散事件，DR 是连续模型——碰撞后立即发送强制更新（Forced Update），不走阈值判断
4. **RTS 游戏是 DR 的最佳应用场景**：《星际争霸》《帝国时代》中几百个单位如果逐帧同步会爆带宽，DR + 阈值更新可将网络流量降低 95% 以上

### 🔗 相关问题

- Entity Interpolation 和 Dead Reckoning 能否同时使用？如何组合？
- 在帧同步游戏中，DR 有用武之地吗？（提示：确定性模拟不需要 DR，但观战/回放可以用）
- DR 的阈值如何做自适应？不同距离、不同运动状态下阈值如何动态调整？
