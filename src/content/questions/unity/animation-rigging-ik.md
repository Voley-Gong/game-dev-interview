---
title: "Unity Animation Rigging 和 IK（逆向运动学）的原理是什么？如何实现动态骨骼控制？"
category: "unity"
level: 3
tags: ["动画系统", "Animation Rigging", "IK", "逆向运动学", "程序化动画"]
related: ["unity/animator-state-machine"]
hint: "从 IK 解算原理、Rig Builder 工作流、运行时性能开销三个维度分析动态骨骼控制方案。"
---

## 参考答案

### ✅ 核心要点

1. **IK（Inverse Kinematics）是"给定末端位置反推关节角度"的算法**：与 FK（正向运动学）相反，FK 是"给定骨骼旋转计算末端位置"，IK 让你指定"手要碰到这个点"，引擎自动计算肩膀→手肘→手腕的旋转
2. **Unity 提供多层 IK 方案**：Animator 内置 IK（OnAnimatorIK 回调）、Animation Rigging 包（运行时 Rig）、C# Job 系统 + Burst 编译的自定义 IK
3. **Animation Rigging 的核心是 Rig Builder + Constraint Stack**：每个 Rig 对象挂载一组 Constraint（约束），按顺序解算，在动画播放后、骨骼提交前修改最终骨骼姿态
4. **IK 解算性能敏感**：两节点 IK（如手肘）开销小，FABRIK / CCD（多关节链如脊椎、尾巴）开销较大，需要在 Job 系统中并行化
5. **Animation Rigging 适合"动态精准定位"场景**：脚部贴合不规则地形、手部抓取物体、头部追踪目标、武器瞄准对齐

### 📖 深度展开

#### IK 与 FK 的本质区别

```
FK（正向运动学）:
  上臂旋转 → 前臂旋转 → 手腕位置 = 自动算出
  输入: 各关节角度
  输出: 末端位置
  特点: 直观，动画师在 Maya/Blender 中做关键帧用的就是 FK

IK（逆向运动学）:
  目标位置 → ??? → 上臂/前臂/手腕该转多少度？
  输入: 末端目标位置
  输出: 各关节角度
  特点: 程序化控制，角色脚踩台阶/手抓门把手必用

示例: 角色走在崎岖地形上
  FK: 左脚动画播放到"踩地"帧，但地形高度不同 → 脚穿模或悬空
  IK: 设定左脚 IK Target = 地形碰撞点 → 脚自动贴合台阶
```

#### Unity IK 方案对比

| 方案 | 灵活度 | 性能 | 易用性 | 适用版本 | 适用场景 |
|------|--------|------|--------|---------|---------|
| Animator 内置 IK | ★★ | ★★★★★ | ★★★★ | 全版本 | 简单手脚放置 |
| Animation Rigging | ★★★★ | ★★★ | ★★★★ | 2019.4+ | 生产级动态骨骼 |
| Playable + 自定义 IK | ★★★★★ | ★★★★ | ★★ | 2018+ | 程序化动画系统 |
| Final IK（插件） | ★★★★★ | ★★★★ | ★★★★★ | 全版本 | 商业项目首选 |

#### 方案一：Animator 内置 IK

```csharp
using UnityEngine;

[RequireComponent(typeof(Animator))]
public class FootIK : MonoBehaviour
{
    [SerializeField] private LayerMask groundMask;
    [SerializeField] private float footHeight = 0.1f;  // 脚部偏移
    [SerializeField] private float lerpSpeed = 10f;

    private Animator animator;
    private float leftFootWeight;
    private float rightFootWeight;

    void Awake() => animator = GetComponent<Animator>();

    // OnAnimatorIK 在动画更新后、骨骼提交前调用
    void OnAnimatorIK(int layerIndex)
    {
        // 左脚 IK
        leftFootWeight = Mathf.Lerp(leftFootWeight, 1f, Time.deltaTime * lerpSpeed);
        animator.SetIKPositionWeight(AvatarIKGoal.LeftFoot, leftFootWeight);
        animator.SetIKRotationWeight(AvatarIKGoal.LeftFoot, leftFootWeight);

        // 射线检测脚下地形
        RaycastHit hit;
        Vector3 leftFootPos = animator.GetIKPosition(AvatarIKGoal.LeftFoot);

        if (Physics.Raycast(leftFootPos + Vector3.up * 0.5f, Vector3.down, out hit, 1f, groundMask))
        {
            animator.SetIKPosition(AvatarIKGoal.LeftFoot, hit.point + Vector3.up * footHeight);
            animator.SetIKRotation(AvatarIKGoal.LeftFoot,
                Quaternion.LookRotation(transform.forward, hit.normal));
        }

        // 右脚同理...
        // animator.SetIKPositionWeight(AvatarIKGoal.RightFoot, ...);
    }
}
```

**局限**：只能在 `OnAnimatorIK` 回调中设置权重和位置，不支持自定义约束链，IK 解算器类型不可定制。

#### 方案二：Animation Rigging（推荐方案）

```
角色 GameObject（带 Animator + Rig Builder）
├── Animator（播放基础动画）
├── Rig Builder（IK 约束管理器）
│     └── Rig 0
│           └── Constraints
│                 ├── Two Bone IK Constraint（手脚 IK）
│                 ├── Multi-Aim Constraint（头部追踪）
│                 ├── DampedTransform（披风/尾巴弹簧）
│                 └── Override Transform（强制骨骼位置）
└── Rig Targets（空物体作为 IK 目标）
      ├── LeftFootTarget
      ├── RightFootTarget
      └── LookAtTarget
```

```csharp
using UnityEngine.Animations.Rigging;

// 运行时动态切换 IK 目标（如：角色拿取不同武器时调整手部位置）
public class DynamicIKController : MonoBehaviour
{
    [SerializeField] private RigBuilder rigBuilder;
    [SerializeField] private TwoBoneIKConstraint leftHandIK;
    [SerializeField] private TwoBoneIKConstraint rightHandIK;

    // 武器握把 Transform
    public void SetHandTarget(bool isLeftHand, Transform target, float weight = 1f)
    {
        var constraint = isLeftHand ? leftHandIK : rightHandIK;
        constraint.data.target = target;
        constraint.data.targetPositionWeight = weight;
        constraint.data.targetRotationWeight = weight;

        // 重建 Rig（权重或目标变化时需要调用）
        rigBuilder.Build();
    }

    // 平滑切换 IK 权重（如：拿武器时逐渐举起手）
    public Coroutine BlendIKWeight(TwoBoneIKConstraint constraint, float targetWeight, float duration)
    {
        return StartCoroutine(BlendIKRoutine(constraint, targetWeight, duration));
    }

    private System.Collections.IEnumerator BlendIKRoutine(
        TwoBoneIKConstraint constraint, float targetWeight, float duration)
    {
        float startWeight = constraint.data.targetPositionWeight;
        float elapsed = 0f;

        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;
            float t = elapsed / duration;
            float w = Mathf.Lerp(startWeight, targetWeight, t);
            constraint.data.targetPositionWeight = w;
            constraint.data.targetRotationWeight = w;
            yield return null;
        }

        constraint.data.targetPositionWeight = targetWeight;
        constraint.data.targetRotationWeight = targetWeight;
    }
}
```

#### IK 解算算法对比

```
Two-Bone IK（两骨骼 IK，最常用）
  适用: 手臂(肩→肘→腕)、腿部(髋→膝→踝)
  算法: 解析解（余弦定理直接算角度），O(1) 复杂度
  优点: 速度极快，结果确定性强
  缺点: 只支持 3 节点（2 段骨骼），不适用于多关节链

FABRIK（Forward And Backward Reaching Inverse Kinematics）
  适用: 脊椎(5+节骨骼)、尾巴、绳子、触手
  算法: 迭代法，从末端向根、再从根向末端反复调整
  优点: 支持任意长度骨骼链，自然弯曲
  缺点: 迭代次数影响精度和性能（通常 5-10 次）

CCD（Cyclic Coordinate Descent）
  适用: 类似 FABRIK 的多关节链
  算法: 从末端向根逐关节旋转，使末端逼近目标
  优点: 实现简单
  缺点: 收敛速度不如 FABRIK，容易产生不自然弯曲
```

#### 性能优化：多角色 IK 并行

```csharp
using Unity.Collections;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine.Animations;

// 使用 Job 系统并行计算多个角色的 IK
[BurstCompile]
public struct TwoBoneIKJob : IJobParallelFor
{
    [ReadOnly] public NativeArray<float3> rootPositions;
    [ReadOnly] public NativeArray<float3> midPositions;
    [ReadOnly] public NativeArray<float3> tipPositions;
    [ReadOnly] public NativeArray<float3> targetPositions;
    [ReadOnly] public NativeArray<float3> hintPositions; // 肘部/膝盖方向提示

    public NativeArray<float3> resultRoot;
    public NativeArray<float3> resultMid;
    public NativeArray<float3> resultTip;

    public void Execute(int index)
    {
        // 解析解 Two-Bone IK（余弦定理）
        float3 root = rootPositions[index];
        float3 mid = midPositions[index];
        float3 tip = tipPositions[index];
        float3 target = targetPositions[index];
        float3 hint = hintPositions[index];

        float a = math.distance(root, mid);   // 上臂长度
        float b = math.distance(mid, tip);    // 前臂长度
        float c = math.distance(root, target); // 根到目标距离

        // 余弦定理求中间关节角度
        float angleA = math.acos(math.clamp((b * b + c * c - a * a) / (2 * b * c), -1f, 1f));
        // ... 计算旋转并输出结果
    }
}

// 调度: 100 个角色的 IK 同时计算
// var job = new TwoBoneIKJob { ... };
// var handle = job.Schedule(100, 32); // batchCount=32
// JobHandle.Complete(handle);
```

### ⚡ 实战经验

1. **Animation Rigging 的 `Rig Builder.Build()` 是隐藏的性能炸弹**。每调用一次会重建整个 Rig 层级。正确做法是：在初始化时 Build 一次，之后只用 `constraint.data.targetPositionWeight` 调整权重，不要频繁重建。如果必须动态添加 Constraint，批量操作后再 Build 一次
2. **IK Target 的 SmoothDamp 比直接赋值效果好 10 倍**。直接把鼠标位置赋给 IK Target，角色手臂会"抖动"（因为鼠标每帧位置变化大）。用 `Vector3.SmoothDamp` 做插值，移动平滑且角色动作自然。FPS 游戏的手部 IK 尤其需要这个技巧
3. **FABRIK 的迭代次数要和骨骼链长度匹配**。5 节脊椎用 3-5 次迭代足够，15 节触手需要 10-15 次。迭代次数不够会导致末端无法到达目标（"够不着"），迭代次数过多浪费 CPU。用 Profiler 观察不同迭代次数的 IK Solve 耗时来调参
4. **移动端慎用 Animation Rigging**。中端手机上每个角色带 3-4 个 Constraint（双手 IK + 头部追踪 + 脚部 IK）大约耗时 0.3-0.5ms，超过 10 个同屏角色就开始吃力。方案：只对主角和重要 NPC 启用 Rigging，普通 NPC 用 Animator 内置 IK 或预烘焙动画

### 🔗 相关问题

- Animation Rigging 和 Final IK 插件各有什么优劣？如何选择？
- 如何实现角色在斜坡上脚部自然贴合地面（含脚尖旋转）？
- Playable API + 自定义 IK 与 Animation Rigging 相比，灵活度和性能分别如何？
