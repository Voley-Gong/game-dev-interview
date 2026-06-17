---
title: "Unity Animator 状态机和 Blend Tree 的原理是什么？如何优化动画系统性能？"
category: "unity"
level: 2
tags: ["动画系统", "Animator", "Blend Tree", "状态机", "性能优化"]
related: ["unity/drawcall-batching"]
hint: "从 Animator Controller 结构、Blend Tree 插值原理、运行时性能开销三个层面分析。"
---

## 参考答案

### ✅ 核心要点

1. **Animator Controller 是一个有限状态机（FSM）**，通过 Transition（过渡条件）在 Animation State 之间切换，参数（Parameter）驱动状态变化
2. **Blend Tree 用于混合多个动画**，按速度方向（2D）或单一参数（1D）进行插值，实现走/跑/侧移的自然过渡
3. **动画系统的性能瓶颈通常在 CPU 侧**：骨骼计算（Skinning）、状态机评估、动画层同步开销
4. **关键优化手段**：使用 Avatar Mask + Animation Layer 分离上下半身、Optimal GameObject 限制、按需启用/禁用 Animator 组件
5. **Playable API 是更底层的方案**：灵活度远超 Animator Controller，适合程序化动画构建和 AI 驱动动画

### 📖 深度展开

#### Animator Controller 状态机架构

```
Base Layer (全身动画)
┌──────────────────────────────────────────────┐
│                                              │
│   ┌──────┐  isMoving=true   ┌──────┐         │
│   │ Idle │ ───────────────→ │ Walk │         │
│   │      │ ←─────────────── │      │         │
│   └──────┘  speed<0.1       └──────┘         │
│      │                          │            │
│      │ jumpTrigger              │ jumpTrigger │
│      ↓                          ↓            │
│   ┌──────┐  exitTime=0.5  ┌──────┐          │
│   │ Jump │ ────────────── │ Jump │          │
│   └──────┘               └──────┘          │
│                                              │
│   Parameters:                                │
│     float speed         ← 运动速度            │
│     bool  isMoving      ← 是否移动            │
│     trigger jumpTrigger ← 跳跃触发            │
└──────────────────────────────────────────────┘
```

#### Transition 过渡条件

过渡由 Parameters 驱动，可以组合多个条件：

```
Transition: Idle → Walk
  Conditions: speed > 0.1 (AND) isMoving == true
  HasExitTime: false     ← 不等待当前动画播完
  TransitionDuration: 0.2s
  InterruptionSource: Next State ← 允许被打断
```

#### Blend Tree 工作原理

Blend Tree 将多个 AnimationClip 按参数空间插值：

**1D Blend Tree（按速度混合 Idle→Walk→Run）：**

```
速度轴:  0 -------- 0.5 -------- 1.0
         |           |            |
      Idle Clip   Walk Clip    Run Clip

插值示例: speed = 0.7
  → Walk 权重 0.6, Run 权重 0.4
  → 最终动画 = Walk * 0.6 + Run * 0.4
```

**2D Cartesian Blend Tree（按移动方向混合）：**

```
                  Forward (0, 1)
                     ↗ RunFwd
                    /
  ←———(0,0)———→
  WalkLeft  Idle   WalkRight
                    \
                     ↘ RunBack
                  Backward (0, -1)

输入: (InputX, InputY) = (0.3, 0.8)
→ 在四个方向动画间进行双线性插值
```

#### 代码控制 Animator

```csharp
public class CharacterAnimationController : MonoBehaviour
{
    private Animator animator;
    private static readonly int SpeedHash = Animator.StringToHash("Speed");
    private static readonly int IsMovingHash = Animator.StringToHash("IsMoving");
    private static readonly int JumpHash = Animator.StringToHash("JumpTrigger");

    void Awake()
    {
        animator = GetComponent<Animator>();
    }

    void Update()
    {
        float speed = new Vector2(Input.GetAxis("Horizontal"),
                                   Input.GetAxis("Vertical")).magnitude;

        // 使用 StringToHash 避免每次字符串查找
        animator.SetFloat(SpeedHash, speed, 0.1f, Time.deltaTime);
        animator.SetBool(IsMovingHash, speed > 0.1f);

        if (Input.GetKeyDown(KeyCode.Space))
        {
            animator.SetTrigger(JumpHash);
        }
    }
}
```

#### Playable API 替代方案

对于复杂程序化动画（如 AI 驱动、物理驱动），Playable API 提供了更灵活的控制：

```csharp
using UnityEngine.Playables;
using UnityEngine.Animations;

public class PlayableAnimationDemo : MonoBehaviour
{
    public AnimationClip clipA;
    public AnimationClip clipB;
    private PlayableGraph graph;
    private AnimationMixerPlayable mixer;

    void Start()
    {
        graph = PlayableGraph.Create("CustomAnimGraph");
        var playableA = AnimationClipPlayable.Create(graph, clipA);
        var playableB = AnimationClipPlayable.Create(graph, clipB);
        mixer = AnimationMixerPlayable.Create(graph, 2);
        graph.Connect(playableA, 0, mixer, 0);
        graph.Connect(playableB, 0, mixer, 1);

        var output = AnimationPlayableOutput.Create(graph, "Output",
            GetComponent<Animator>());
        output.SetSourcePlayable(mixer);

        graph.Play();
    }

    void Update()
    {
        // 程序化控制混合权重
        float blend = Mathf.Sin(Time.time) * 0.5f + 0.5f;
        mixer.SetInputWeight(0, 1f - blend);
        mixer.SetInputWeight(1, blend);
    }

    void OnDestroy()
    {
        graph.Destroy(); // 必须手动释放
    }
}
```

#### Animator 性能优化检查表

| 优化手段 | 效果 | 适用场景 |
|---------|------|---------|
| 禁用远处角色 Animator | 省 CPU | NPC 管理系统 |
| 降低 Animator Update Mode | Fixed/Unscaled | 根据项目需求选择 |
| Avatar Mask + Layer | 避免全身重算 | 上下半身分离 |
| Write Defaults 关闭 | 减少 VRAM 写入 | 大量角色场景 |
| 使用 Animation Rigging | 运行时 IK | 精确控制少量角色 |
| GPU Skinning | GPU 计算骨骼 | 百人同屏 |
| 简化骨骼（< 50 bones） | 降低计算量 | 移动端角色 |

### ⚡ 实战经验

- **StringToHash 是基本功**：`animator.SetFloat("Speed", x)` 每帧都做字符串哈希查找，角色多时性能损失显著，务必预计算 `Animator.StringToHash`
- **Write Defaults 陷阱**：默认 Animator 会将所有未播放动画的属性写入默认值，在大量角色场景下关闭 Write Defaults 可减少 20%~30% CPU 开销，但可能导致动画状态残留，需测试
- **不要在 Update 里频繁 SetTrigger**：如果同一帧多个脚本都对同一参数 SetTrigger，只会触发一次，导致逻辑混乱。建议用一个 AnimationController 集中管理动画参数
- **GPU Skinning 是终极大杀器**：大规模同屏角色（如割草游戏）可以用 GPU Skinning 将骨骼计算移到 GPU，配合 Compute Shader 处理动画采样，能从 CPU 侧省下大量性能

### 🔗 相关问题

- Animator Controller 和 Timeline 是什么关系？如何配合使用？
- 如何实现运行时动态加载和切换 AnimationClip（不依赖 Animator Controller 预设）？
- Unity Animation Rigging 包的 IK 实现原理是什么？性能如何？
