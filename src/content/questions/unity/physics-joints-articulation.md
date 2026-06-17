---
title: "Unity 物理关节系统：Character Joint、Hinge Joint、Articulation Body 的区别与适用场景是什么？"
category: "unity"
level: 2
tags: ["物理引擎", "关节", "Articulation", "PhysX", "布娃娃"]
related: ["unity/physics-raycast"]
hint: "从关节类型、自由度约束、布娃娃系统、Articulation Body 四个层面理解 Unity 物理关节。"
---

## 参考答案

### ✅ 核心要点

1. **Unity 提供 5 种 Joint 组件**：Hinge（铰链）、Fixed（固定）、Spring（弹簧）、Character（角色）、Configurable（可配置），从简单到复杂递增
2. **Character Joint 是布娃娃的核心**：6 自由度中可锁定/限制任意轴，模拟人体关节（肘、膝、脖子等）的旋转范围
3. **Articulation Body 是 Unity 2018+ 引入的新物理关节系统**，基于 PhysX Reduced-Coordinate（缩减坐标） solver，比传统 Joint 更稳定、更少抖动
4. **传统 Joint vs Articulation Body 的根本区别**：传统 Joint 使用 Maximal Coordinate solver（约束求解器），Articulation Body 使用 Reduced Coordinate solver，后者在关节链中能量守恒更好
5. **选型原则**：简单单关节用 Hinge/Spring Joint，人体布娃娃用 Character Joint，机械臂/机器人/精密关节链用 Articulation Body

### 📖 深度展开

#### Joint 类型总览

```
Unity 物理关节体系

├── 传统 Joint（基于 Constraint Solver）
│   ├── Fixed Joint       — 约束两个刚体共同运动
│   ├── Spring Joint      — 弹簧连接，有距离和弹力
│   ├── Hinge Joint        — 单轴旋转（门、车轮）
│   ├── Character Joint   — 6DOF，可限制锥角和扭转角（布娃娃）
│   └── Configurable Joint — 最灵活，全部参数可调（机械臂）
│
└── Articulation Body（基于 Featherstone Algorithm）
    └── 支持的关节类型：
        ├── Fixed          — 锁死
        ├── Prismatic      — 沿轴平移
        ├── Revolute       — 单轴旋转
        └── Spherical      — 球关节（多轴旋转）
```

#### 各关节自由度对比

| 关节类型 | 平移自由度 | 旋转自由度 | 典型用途 |
|---------|-----------|-----------|---------|
| Fixed | 0（全锁） | 0（全锁） | 组合复合刚体 |
| Spring | 3（弹簧约束） | 3（自由） | 绳索、链条、弹簧门 |
| Hinge | 2（锁定平面内） | 1（单轴旋转） | 门、铰链、车轮 |
| Character | 3（锁定） | 3（锥形约束+扭转限制） | 布娃娃（肩、髋、颈） |
| Configurable | 0~3（每轴可设） | 0~3（每轴可设） | 机械臂、精密机构 |
| Articulation Revolute | 2（锁） | 1（单轴） | 机器人关节 |
| Articulation Spherical | 3（锁） | 3（锥形+扭转） | 高质量布娃娃 |

#### Character Joint 详解（布娃娃核心）

```
Character Joint 的自由度模型：

         Twist (扭转轴)
          ↑
          |  Swing Cone (摆动锥角)
          | / \
          |/   \
          ●─────●─────●
         / \     \   /
        /   \     \ /
      
  Swing Axis 1   Swing Axis 2

约束参数:
  ├── Twist Limit:
  │   ├── Low Twist Limit (-180°)
  │   └── High Twist Limit (180°)
  ├── Swing Limit:
  │   └── Swing 1 Limit / Swing 2 Limit (锥角大小)
  └── Enable Projection: true（防止关节拉伸）
```

**布娃娃关节配置示例：**

```csharp
using UnityEngine;

public class RagdollSetup : MonoBehaviour
{
    [Header("关节参数")]
    public float shoulderSwingLimit = 45f;
    public float shoulderTwistLimit = 90f;
    public float elbowSwingLimit = 30f;
    public float elbowTwistLimit = 60f;
    public float kneeSwingLimit = 20f;
    public float kneeTwistLimit = 45f;

    void ConfigureRagdollJoints()
    {
        // 肩膀（多轴旋转）
        var leftShoulder = ConfigureJoint(
            "LeftShoulder",
            swing1Limit: shoulderSwingLimit,
            swing2Limit: shoulderSwingLimit,
            twistLimitLow: -shoulderTwistLimit,
            twistLimitHigh: shoulderTwistLimit
        );

        // 肘部（主要弯曲，限制扭转）
        var leftElbow = ConfigureJoint(
            "LeftElbow",
            swing1Limit: elbowSwingLimit,
            swing2Limit: 0f,  // 锁定一个摆动轴
            twistLimitLow: -elbowTwistLimit,
            twistLimitHigh: elbowTwistLimit
        );

        // 膝盖（只允许单方向弯曲）
        var leftKnee = ConfigureJoint(
            "LeftKnee",
            swing1Limit: kneeSwingLimit,
            swing2Limit: 0f,
            twistLimitLow: 0f,
            twistLimitHigh: kneeTwistLimit
        );
    }

    CharacterJoint ConfigureJoint(string name,
        float swing1Limit, float swing2Limit,
        float twistLimitLow, float twistLimitHigh)
    {
        var go = transform.Find(name);
        if (go == null) return null;

        var joint = go.GetComponent<CharacterJoint>();
        if (joint == null) return null;

        var lm = joint.lowTwistLimit;
        lm.limit = twistLimitLow;
        joint.lowTwistLimit = lm;

        var hm = joint.highTwistLimit;
        hm.limit = twistLimitHigh;
        joint.highTwistLimit = hm;

        var s1 = joint.swing1Limit;
        s1.limit = swing1Limit;
        joint.swing1Limit = s1;

        var s2 = joint.swing2Limit;
        s2.limit = swing2Limit;
        joint.swing2Limit = s2;

        // 开启投影，防止关节在高速碰撞时拉伸
        joint.enableProjection = true;
        joint.projectionDistance = 0.1f;
        joint.projectionAngle = 180f;

        return joint;
    }

    // 切换角色 kinematic / ragdoll 模式
    public void EnableRagdoll(bool enable)
    {
        var rigidbodies = GetComponentsInChildren<Rigidbody>();
        var colliders = GetComponentsInChildren<Collider>();

        foreach (var rb in rigidbodies)
        {
            rb.isKinematic = !enable;
            rb.useGravity = enable;
        }

        foreach (var col in colliders)
        {
            col.enabled = enable;
        }

        // 主控制器关闭，交给物理引擎控制
        GetComponent<Rigidbody>().isKinematic = enable;
    }
}
```

#### Articulation Body 详解

```
传统 Joint 的问题（Maximal Coordinate）：
  每个关节独立求解 → 关节链产生累积误差 → 抖动/拉伸

Articulation Body 的优势（Reduced Coordinate）：
  Featherstone 算法 → 整条关节链统一求解 → 能量守恒 → 无抖动

布娃娃对比：
  ┌──────────────────┬───────────────┬──────────────────┐
  │                  │ 传统 Joint    │ Articulation     │
  ├──────────────────┼───────────────┼──────────────────┤
  │ 关节稳定性       │ ⚠️ 有抖动     │ ✅ 非常稳定       │
  │ 关节链计算量     │ O(n)          │ O(n) 但常数更大   │
  │ 高速碰撞行为     │ 关节可能拉伸  │ 关节不会拉伸      │
  │ 精密机械臂       │ ❌ 不适合     │ ✅ 适合           │
  │ 设置复杂度       │ 中等          │ 较高              │
  │ 移动端性能       │ ✅ 好         │ ⚠️ 较重           │
  └──────────────────┴───────────────┴──────────────────┘
```

**Articulation Body 关节链结构：**

```
Articulation Body 层级（机械臂示例）：

  Base (Fixed Root)
    └── Joint 1 (Revolute, Y轴旋转)
        └── Joint 2 (Revolute, X轴旋转)
            └── Joint 3 (Prismatic, Z轴平移)
                └── Gripper (Fixed)
                    ├── Finger L (Revolute)
                    └── Finger R (Revolute)

驱动方式:
  articulationBody.SetDriveTargets(...)
  → 使用关节力矩驱动而非直接设置位置
  → 更真实但需要 PID 控制或力控算法
```

```csharp
using UnityEngine;

public class ArticulationArmController : MonoBehaviour
{
    [Header("机械臂关节")]
    public ArticulationBody joint1; // 基座旋转
    public ArticulationBody joint2; // 大臂俯仰
    public ArticulationBody joint3; // 小臂俯仰

    [Header("PD 控制参数")]
    public float stiffness = 1000f;
    public float damping = 50f;
    public float driveForce = 5000f;

    void ConfigureDrives()
    {
        ConfigureDrive(joint1);
        ConfigureDrive(joint2);
        ConfigureDrive(joint3);
    }

    void ConfigureDrive(ArticulationBody body)
    {
        var drive = body.xDrive; // 或 yDrive / zDrive，取决于旋转轴
        drive.stiffness = stiffness;
        drive.damping = damping;
        drive.forceLimit = driveForce;
        body.xDrive = drive;
    }

    // 设置目标角度
    public void SetTargetAngle(ArticulationBody body, float targetDegrees)
    {
        var drive = body.xDrive;
        drive.target = targetDegrees;
        body.xDrive = drive;
    }

    // 获取当前关节角度
    public float GetCurrentAngle(ArticulationBody body)
    {
        // ArticulationBody 的关节角度获取方式
        float[] positions = new float[1];
        body.GetJointPositions(positions);
        return positions[0] * Mathf.Rad2Deg;
    }
}
```

### ⚡ 实战经验

- **布娃娃权重调试是最耗时的环节**：关节的 Swing/Twist 限制值直接影响观感，建议在 Inspector 中实时调试，极端值会导致关节反向折叠（手肘朝外翻），生产环境要结合美术设定约束范围
- **传统 Character Joint 布娃娃务必开 Projection**：`enableProjection = true` 可以在碰撞冲击时快速纠正关节偏差，代价是少量额外 CPU 开销，但不开启的话角色摔落时手脚会像橡皮筋一样拉伸
- **Articulation Body 的学习曲线陡峭**：需要理解 reduced coordinate 概念、drive 系统（stiffness/damping/force limit 相当于内置 PD 控制器），团队如果不需要精密机械臂，传统 Joint 足够用
- **Fixed Timestep 影响关节稳定性**：默认 0.02s（50Hz），如果布娃娃关节严重抖动，可以降到 0.0166（60Hz）或 0.01（100Hz），但会增加 CPU 开销，移动端要权衡

### 🔗 相关问题

- 如何实现角色死亡后自动从动画状态切换到布娃娃物理状态（Active Ragdoll）？
- Unity 的 Wheel Collider 和 Hinge Joint 有什么区别？车辆物理用哪个更好？
- PhysX 中的 Continuous Collision Detection（CCD）对关节稳定性有什么影响？
