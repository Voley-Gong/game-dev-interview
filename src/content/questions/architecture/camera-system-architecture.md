---
title: "游戏相机系统架构怎么设计？如何实现平滑跟随、多模式切换和镜头特效？"
category: "architecture"
level: 3
tags: ["相机系统", "Camera", "架构设计", "镜头跟随", "相机混合", "Screen Shake"]
related: ["architecture/game-loop-subsystem", "architecture/fsm-behavior-tree", "architecture/multi-platform-adaptation-architecture"]
hint: "相机不是 transform.position = target.position 那么简单——是状态机驱动的多模式系统，每一帧都在做阻尼、碰撞规避和混合。"
---

## 参考答案

### ✅ 核心要点

1. **相机状态机（Camera FSM）**：跟随 / 自由观察 / 轨道环绕 / 过场演出 / 锁定目标等模式用有限状态机管理。模式间通过 Blend（插值过渡）切换而非瞬切，避免画面跳变引起眩晕。每个状态封装自己的 Update 逻辑和进入/退出过渡参数。
2. **相机骨架（Rig）分层控制**：把相机拆成 Yaw 节点（水平旋转）、Pitch 节点（俯仰）、Distance（距离）、FOV 四层。每层独立设置阻尼系数（Smooth Time），避免单层插值导致的"漂移"和"迟滞"。Unity Cinachine 的 VirtualCamera 本质就是这个分层结构。
3. **帧率无关的平滑跟随**：用 Critically Damped Spring（临界阻尼弹簧）或 `SmoothDamp` 实现跟随，而非简单 `Lerp(pos, target, 0.1f)`。Lerp 的 `t` 参数帧率相关——60fps 和 30fps 下行为不同；`SmoothDamp` 内部用 deltaTime 做积分，保证跨帧率一致。
4. **碰撞规避（Camera Collision）**：每帧从目标到相机发射射线检测障碍物，命中时将相机沿射线方向拉近到碰撞点前方，防止相机穿墙。进阶做法用 SphereCast（球体射线）做体积检测，避免相机边缘穿墙。
5. **镜头特效栈（Effect Stack）**：Screen Shake（衰减噪声震屏）、FOV Kick（冲刺 / 冲撞时拉镜）、Hit Stop（受击瞬间冻结数帧）作为可组合的 Effect。每个 Effect 独立计算偏移量，最终叠加到相机最终 Transform 上。

### 📖 深度展开

**相机骨架（Rig）分层架构：**

```
CameraRig (根节点，跟随 Target 位置)
  ├── Yaw Pivot    （水平旋转，SmoothDamp 跟随目标朝向）
  │     └── Pitch Pivot  （俯仰角，限制 ±60° 防翻转）
  │           └── Camera Body （距离/位置，含碰撞检测）
  │                 └── Main Camera （FOV + 特效偏移）
  │
  每层独立参数:
    YawDampTime = 0.3s    （水平跟随速度，慢→电影感）
    PitchDampTime = 0.2s  （俯仰跟随速度）
    Distance = 5.0m       （相机距离）
    FOV = 60°             （视野角度）

  工作流: Target移动 → Yaw层插值旋转 → Pitch层插值俯仰
         → Body层做碰撞拉近距离 → Camera层叠加Shake偏移
```

**Spring Damper 平滑跟随（帧率无关）：**

```csharp
// 临界阻尼弹簧——最常用的相机平滑算法
// 原理: 弹簧 + 阻尼器，临界阻尼保证最快回到目标且无振荡
public static Vector3 SmoothDamp(
    Vector3 current, Vector3 target,
    ref Vector3 velocity,     // 保留速度状态（帧间连续）
    float smoothTime,         // 目标响应时间，越大越慢（建议 0.1~0.5s）
    float maxSpeed,           // 限速防极端弹射
    float deltaTime)          // 关键：用 deltaTime 做积分
{
    smoothTime = Mathf.Max(0.0001f, smoothTime);
    float omega = 2f / smoothTime;       // 角频率
    float x = omega * deltaTime;          // 无量纲时间
    float exp = 1f / (1f + x + 0.48f * x * x + 0.235f * x * x * x);
    Vector3 change = current - target;
    Vector3 temp = (velocity + omega * change) * deltaTime;
    velocity = (velocity - omega * temp) * exp;
    Vector3 result = target + (change + temp) * exp;
    return result;
}

// ❌ 常见错误: Lerp 帧率相关
// pos = Vector3.Lerp(pos, target, 0.1f);  // 60fps 比 30fps 快一倍！
```

**相机模式状态机：**

```
                    ┌──────────┐
         ┌─────────→│ Follow   │←─────── 默认状态
         │          │ (跟随主角) │
         │          └────┬─────┘
         │     触发过场    │ 玩家手动观察
         │          ┌─────↓─────┐
    过场结束    ┌────┤ Free Look │
         │      │    │ (自由旋转) │
         │      │    └─────┬─────┘
    ┌────↓───┐  │          │ 进入战斗
    │Cutscene│──┘    ┌─────↓─────┐
    │ (演出) │       │ Lock-On   │
    └────────┘       │ (锁定Boss)│
                     └─────┬─────┘
                           │ Boss死亡
                     ┌─────↓─────┐
                     │ Victory   │
                     │ (胜利环绕)│
                     └───────────┘

  每次状态切换: 记录当前 Transform → 新状态用 0.5s Blend 过渡
  Blend 公式: pos = Lerp(oldState.pos, newState.pos, blendProgress)
```

**镜头特效栈实现：**

```csharp
// 特效基类——所有特效计算偏移量，最终叠加
public abstract class CameraEffect {
    public abstract (Vector3 posOffset, float fovOffset, float roll) Evaluate(float dt);
    public abstract bool IsAlive { get; }  // 衰减完毕返回 false
}

// Screen Shake: Perlin 噪声 + 指数衰减
public class ScreenShake : CameraEffect {
    private float amplitude;  // 初始幅度（如 0.3m）
    private float duration;   // 持续时间（如 0.25s）
    private float elapsed = 0f;

    public override (Vector3, float, float) Evaluate(float dt) {
        elapsed += dt;
        float t = elapsed / duration;
        float decay = Mathf.Exp(-4f * t);       // 指数衰减
        float nx = Mathf.PerlinNoise(elapsed * 30f, 0f) * 2f - 1f;
        float ny = Mathf.PerlinNoise(0f, elapsed * 30f) * 2f - 1f;
        Vector3 offset = new Vector3(nx, ny, 0) * amplitude * decay;
        float roll = nx * amplitude * decay * 5f; // 轻微滚转
        return (offset, 0f, roll);
    }
    public override bool IsAlive => elapsed < duration;
}

// Effect Stack 管理: 每帧遍历所有活跃 Effect，累加偏移
public class CameraEffectStack {
    private List<CameraEffect> effects = new();
    public void Add(CameraEffect e) => effects.Add(e);
    public void Update(Camera cam) {
        Vector3 totalPos = Vector3.zero; float totalFov = 0; float totalRoll = 0;
        for (int i = effects.Count - 1; i >= 0; i--) {
            var (p, f, r) = effects[i].Evaluate(Time.deltaTime);
            totalPos += p; totalFov += f; totalRoll += r;
            if (!effects[i].IsAlive) effects.RemoveAt(i);
        }
        cam.transform.localPosition += totalPos;
        cam.fieldOfView += totalFov;
        cam.transform.localRotation *= Quaternion.Euler(0, 0, totalRoll);
    }
}
```

**三种平滑跟随算法对比：**

| 算法 | 原理 | 帧率无关 | 过冲/振荡 | 适用场景 |
|------|------|---------|----------|---------|
| `Lerp(t=0.1)` | 线性插值 | ❌ 否 | 无 | UI 动画、简单跟随 |
| `SmoothDamp` | 临界阻尼弹簧 | ✅ 是 | 无（临界阻尼） | ✅ 通用首选 |
| `Spring(t, ζ)` | 二阶弹簧（可调阻尼比） | ✅ 是 | 有（ζ<1 时弹性） | 需要弹性手感（赛车/弹跳） |
| `Critically Damped` | ω=2/t，阻尼比=1 | ✅ 是 | 无 | 电影感镜头 |

### ⚡ 实战经验

- **阻尼参数差异巨大**：Yaw 设 0.3s 给电影感慢跟随，Pitch 设 0.15s 更灵敏。某 ARPG 项目把 Yaw 和 Pitch 都设成 0.1s，镜头抖动到眩晕；改成 0.35/0.15 后舒适度评分从 3.2→4.5（满分 5）。
- **相机穿墙用 SphereCast 不用 Raycast**：Raycast 只检测一条线，相机"边缘"仍能穿墙。改用 SphereCast（半径 0.3~0.5m），检测体积碰撞。实测某第三人称项目走廊拐角穿墙率从 ~15% 降到 0。
- **Screen Shake 幅度超过 0.5m 会引起 3D 眩晕投诉**：手雷爆炸 Shake 设 0.8m 时，测试组 3 人报眩晕；降到 0.3m + 衰减加快后消失。移动端建议上限 0.15m，且提供"减少动态效果"开关。
- **Cinemachine vs 自研的取舍**：中小项目用 Cinachine 省时间（状态机、Blender、Collider 全内置），但大型 MMO 或特殊视角（如 2.5D 俯视固定角度）自研更可控。某项目因 Cinemachine 的 Priority 切换有 1 帧延迟导致 Boss 战镜头闪烁，最终替换为自研 FSM。

### 🔗 相关问题

1. Unity Cinemachine 的 VirtualCamera 和 Brain 各自负责什么？Priority 混合的原理是什么？
2. 如何在帧同步（Lockstep）游戏中保证相机的确定性？（提示：相机逻辑通常是客户端本地计算，不参与同步）
3. 第一人称相机的 Head Bob（视角晃动）如何做到自然而不眩晕？（提示：用 Perlin 噪声 + 频率分离水平/垂直晃动）
