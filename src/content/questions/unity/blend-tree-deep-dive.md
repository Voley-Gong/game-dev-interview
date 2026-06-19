---
title: "Unity Blend Tree 的原理是什么？1D/2D/Direct Blend Tree 各适合什么场景？"
category: "unity"
level: 2
tags: ["动画系统", "Blend Tree", "Animator", "Motion Matching"]
related: ["unity/animator-state-machine", "unity/animation-rigging-ik"]
hint: "Blend Tree 不是状态切换，而是在多个动画片段间做加权混合——理解插值算法是核心。"
---

## 参考答案

### ✅ 核心要点

1. **Blend Tree 本质**：在同一个 Animator 状态中对多个 AnimationClip 做加权插值，而非状态跳转
2. **1D Blend Tree**：沿单一参数轴混合，适合前后走→跑的过渡
3. **2D Blend Tree**：两种类型——Cartesian（笛卡尔，自由方向移动）和 Directional（方向型，输入为角度+速度）
4. **Direct Blend Tree**：直接控制每个动画权重，适合叠加层（Layer）或手工混合方案
5. **阈值（Threshold）与权重计算**是性能和表现的关键，错误的阈值分布会导致滑步或抖动

### 📖 深度展开

#### Blend Tree 的类型对比

| 类型 | 参数维度 | 适用场景 | 优点 | 缺点 |
|------|----------|----------|------|------|
| **1D** | 单参数 | 前后移动（走→跑）、瞄准俯仰角 | 简单直观，计算量最小 | 无法表达侧向移动 |
| **2D Cartesian** | 双参数（X/Y） | 8方向移动、游戏手柄摇杆 | 自由映射任意方向 | 需要较多动画样本（5~9方向） |
| **2D Directional** | 角度+速度 | 固定模式的方向移动 | 数据量较少（3~5方向即可） | 灵活性低，转弯不够顺滑 |
| **Direct** | 每个Clip独立权重 | 上半身叠加、混合表情 | 完全手工控制 | 管理复杂，不适合角色移动 |

#### 2D Cartesian 权重计算原理

Unity 的 2D Cartesian Blend Tree 使用 **重心坐标（Barycentric）或最近邻插值** 来计算各动画的权重：

```
输入: (inputX, inputY) 在 [-1, 1] 范围
动画样本点: P0, P1, ..., Pn（每个动画对应一个 2D 坐标）

算法:
1. 找到输入点所在的三角形（由三个最近样本点组成）
2. 计算重心坐标 (w0, w1, w2)，使 input = w0*P0 + w1*P1 + w2*P2
3. 权重归一化: Σwi = 1.0

如果输入点在三角形外部:
  → 投影到最近的边，外部点权重为 0
```

```
        P_forward (0, 1)
           / \
          /   \
         /  *  \     ← 输入点 (0.3, 0.5)
        /       \
P_left /____+____\ P_right
(-1,0)   P_back    (1,0)
         (0,-1)
```

#### 代码示例：运行时动态修改 Blend Tree 参数

```csharp
public class LocomotionController : MonoBehaviour
{
    private Animator animator;
    private CharacterController controller;

    [Header("移动参数")]
    public float walkSpeed = 1.5f;
    public float runSpeed = 5.0f;
    public float rotationSmooth = 10f;

    private static readonly int SpeedHash = Animator.StringToHash("Speed");
    private static readonly int DirectionXHash = Animator.StringToHash("DirectionX");
    private static readonly int DirectionYHash = Animator.StringToHash("DirectionY");

    void Awake()
    {
        animator = GetComponent<Animator>();
        controller = GetComponent<CharacterController>();
    }

    void Update()
    {
        Vector2 input = new Vector2(
            Input.GetAxisRaw("Horizontal"),
            Input.GetAxisRaw("Vertical")
        );

        // 根据输入强度决定走/跑
        float normalizedSpeed = input.magnitude >= 0.5f ? 1f : input.magnitude * 2f;

        // 将输入映射到 Blend Tree 参数
        if (input.magnitude > 0.01f)
        {
            Vector2 dir = input.normalized * normalizedSpeed;
            animator.SetFloat(DirectionXHash, dir.x, 0.1f, Time.deltaTime);
            animator.SetFloat(DirectionYHash, dir.y, 0.1f, Time.deltaTime);
        }
        else
        {
            // 平滑回到 Idle（Speed=0）
            animator.SetFloat(DirectionXHash, 0f, 0.1f, Time.deltaTime);
            animator.SetFloat(DirectionYHash, 0f, 0.1f, Time.deltaTime);
        }
    }
}
```

#### Blend Tree 性能开销

```
单层 Blend Tree 的采样成本 ≈ N 个 AnimationClip 采样 + N 次插值

规则:
- 1D Blend Tree: 只采样参数轴两侧最近的 2 个 Clip
- 2D Blend Tree: 采样最近的 3~4 个 Clip（三角形/四边形顶点）
- Direct Blend Tree: 采样所有 Clip（开销最大，慎用！）

实测参考（中端手机）:
- 2D Cartesian, 9方向动画: ~0.3ms/帧
- Direct, 5个叠加层: ~0.8ms/帧
- 同层叠 3 个 Blend Tree: ~1.2ms/帧
```

### ⚡ 实战经验

1. **阈值不要均匀分布**：走→跑的过渡区间（0.5~0.8）应该占更大比例，避免「突然开始跑」的视觉跳变。推荐使用动画事件（Animation Event）在脚步落地的瞬间标记触发起跑
2. **2D Cartesian 需要 9 方向动画（含对角线）**：只有前后左右 4 方向会导致对角线移动严重滑步。如果美术资源有限，至少补 4 个对角线方向
3. **慎用 Direct Blend Tree 做角色移动**：它每帧采样所有子动画，移动端可能直接吃掉 1ms+。只在叠加层（如上半身瞄准）使用 Direct
4. **Motion Matching 是趋势**：3A 项目越来越多用 Motion Matching 替代 Blend Tree，它通过搜索动画数据库中最匹配的帧片段来播放，过渡更自然，但需要大量动画数据和更高 CPU 开销

### 🔗 相关问题

- Animator 状态机和 Blend Tree 应该如何配合使用？
- 如何用 Animation Rigging 实现运行时 IK 修正 Blend Tree 的脚步？
- Motion Matching 相比 Blend Tree 有哪些优劣势？
