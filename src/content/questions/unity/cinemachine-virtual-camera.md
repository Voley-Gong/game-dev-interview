---
title: "Unity Cinemachine 虚拟相机系统的工作原理是什么？如何实现平滑的跟随相机和战斗镜头？"
category: "unity"
level: 2
tags: ["Cinemachine", "相机系统", "游戏玩法", "Unity包"]
related: ["unity/timeline-playables", "unity/dots-ecs"]
hint: "Cinemachine 不是一台相机，而是一组虚拟相机通过优先级和Blend在运行时竞争控制权。"
---

## 参考答案

### ✅ 核心要点

1. **虚拟相机（Virtual Camera）不是真实相机**：它是数据驱动的「相机意图」，多个 vcam 共同竞争一台真实相机的控制权
2. **优先级（Priority）机制**：最高优先级的 vcam 获得 Active 状态，控制真实相机
3. **Body + Aim + Noise 三段管线**：分别控制位置、朝向、震动，可独立组合
4. **Blend 系统**：vcam 切换时通过插值算法平滑过渡（Cut、Ease In Out、Hard 等）
5. **与 Timeline 深度集成**：可在时间轴上精确控制 vcam 的激活和参数动画

### 📖 深度展开

#### Cinemachine 架构总览

```
Brain (CinemachineBrain)
  │  挂在 Main Camera 上，每帧执行:
  │  1. 计算所有 vcam 的优先级
  │  2. 选出 Active vcam
  │  3. 对 Active vcam 的 Body/Aim/Noise 求值
  │  4. 将结果 Blend 到真实相机
  │
  ├── Virtual Camera (vcam_0)  Priority=10  [Player Follow]
  │     ├── Body:   FramingTransposer (屏幕空间跟随)
  │     ├── Aim:    DOF / Composer (构图)
  │     └── Noise:  Perlin Noise (手持震动)
  │
  ├── Virtual Camera (vcam_1)  Priority=20  [Combat Close-up]
  │     ├── Body:   Follow + Position Offset
  │     ├── Aim:    LookAt + Composer
  │     └── Noise:  静止
  │
  └── Virtual Camera (vcam_2)  Priority=5   [Death Cam]
        ├── Body:   固定位置
        └── Aim:    LookAt Player
```

#### Body / Aim / Noise 核心组件

| 管线阶段 | 常用组件 | 作用 | 关键参数 |
|----------|----------|------|----------|
| **Body** | FramingTransposer | 屏幕空间目标跟随 | Dead Zone Width/Height, Damping |
| **Body** | TrackedDolly | 沿轨道移动 | Path Position, Auto-Dolly |
| **Body** | 3rdPersonFollow | 第三人称肩视角 | Shoulder Offset, DampingIntoCollision |
| **Aim** | Composer | 构图目标保持在画面指定区域 | Tracked Object Offset, Dead Zone |
| **Aim** | Group Composer | 多目标构图 | Group Radius, Target Hint |
| **Noise** | Perlin Noise | 自然手持抖动 | Amplitude Gain, Frequency Gain |
| **Noise** | Basic Multi Channel Perlin | 多频段震动 | Noise Profile (ScriptableObject) |

#### 代码示例：运行时切换相机与自定义 Impulse

```csharp
using Cinemachine;
using UnityEngine;

public class CameraManager : MonoBehaviour
{
    [Header("虚拟相机")]
    public CinemachineVirtualCamera followCam;      // 跟随相机
    public CinemachineVirtualCamera combatCam;      // 战斗特写
    public CinemachineVirtualCamera deathCam;       // 死亡镜头

    [Header("震动")]
    public CinemachineImpulseSource impulseSource;

    private CinemachineBrain brain;

    void Start()
    {
        brain = Camera.main.GetComponent<CinemachineBrain>();
        // 默认跟随相机激活
        SetActiveCamera(followCam);
    }

    /// <summary>
    /// 切换到战斗特写（高优先级覆盖）
    /// </summary>
    public void EnterCombat()
    {
        SetActiveCamera(combatCam);
    }

    /// <summary>
    /// 返回跟随相机
    /// </summary>
    public void ExitCombat()
    {
        SetActiveCamera(followCam);
    }

    /// <summary>
    /// 死亡镜头：拉远 + 慢动作
    /// </summary>
    public void TriggerDeathCam()
    {
        SetActiveCamera(deathCam);
        Time.timeScale = 0.3f;
    }

    /// <summary>
    /// 触发屏幕震动（受击/爆炸时调用）
    /// </summary>
    public void Shake(float force = 1f)
    {
        impulseSource.GenerateImpulseWithForce(force);
    }

    private void SetActiveCamera(CinemachineVirtualCamera target)
    {
        // 策略：先全部降为 0，目标设为 100
        followCam.Priority = 0;
        combatCam.Priority = 0;
        deathCam.Priority = 0;
        target.Priority = 100;
    }
}
```

#### Blend 类型与适用场景

| Blend 类型 | 曲线特征 | 适用场景 | 效果 |
|-----------|----------|----------|------|
| **Cut** | 瞬切 | 安全区切换、剧情节点 | 无过渡，硬切 |
| **Ease In Out** | S 曲线 | 默认通用过渡 | 平滑自然 |
| **Ease In** | 减速进入 | 聚焦特写 | 从快到慢 |
| **Ease Out** | 加速离开 | 离开场景 | 从慢到快 |
| **Hard** | 硬线性 | 机械/技术感 | 冷硬过渡 |
| **Custom** | 自定义曲线 | 特殊剧情需求 | 完全可控 |

#### 性能注意事项

```
vcam 数量与开销:
- 10 个以下 vcam: 几乎无开销（Active 的只有 1~2 个在工作）
- 50+ vcam 同帧更新: 需要启用 vcam 后台休眠（CinemachineVirtualCameraBase.m_StandbyUpdate）
- Brain 的 Blend 计算每帧固定 ~0.05ms（可忽略）
- FramingTransposer 的射线碰撞检测是最贵的部分（每帧多次 Physics.Raycast）

优化建议:
- 非活跃 vcam 设置 StandbyUpdate = "Never"（完全不更新）
- 射线碰撞用 LayerMask 限制
- 大量 vcam 场景考虑用 ClearShot 自动管理
```

### ⚡ 实战经验

1. **不要 Destroy/Instantiate vcam**：vcam 应预置在场景中通过 Priority 切换。频繁创建销毁会导致 Blend 异常和 GC 压力。用对象池或 SetActive(false) 管理
2. **Dead Zone 是防抖神器**：FramingTransposer 的 Dead Zone Width/Height 设为 0.3~0.5 可以让角色在小范围内移动而相机不跟随，大幅减少镜头晃动带来的眩晕感
3. **Impulse Source 比 Animator 震动好得多**：用 CinemachineImpulseSource 做受击/爆炸震动，它自动处理衰减、距离衰减和 Channel 过滤，不需要手写 coroutine
4. **CM 3.x 已全面重构**：Unity 2022.2+ 推荐使用 Cinemachine 3.x，它重构了属性命名空间（`Cinemachine.Unity` → `Cinemachine`），原生支持 DOTS/ECS 的相机系统，并与 POLIMI/UniAndy 的相机研究整合

### 🔗 相关问题

- 如何在 Timeline 中编排多机位过场动画？
- 第三人称相机的碰撞检测如何实现（防止穿墙）？
- Cinemachine 与自研相机系统相比有哪些优劣？
