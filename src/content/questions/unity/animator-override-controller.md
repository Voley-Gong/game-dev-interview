---
title: "Unity Animator Override Controller 如何实现动画复用？多角色共享动画状态机的方案有哪些？"
category: "unity"
level: 2
tags: ["动画系统", "Animator", "动画复用", "AnimatorOverrideController"]
related: ["unity/animator-state-machine", "unity/blend-tree-deep-dive", "unity/animation-event-pitfalls"]
hint: "10 个角色都有跑/跳/攻击，是做 10 套 AnimatorController 还是 1 套？"
---

## 参考答案

### ✅ 核心要点

1. **AnimatorOverrideController（AOC）**：继承自 `AnimatorController`，保留完整的状态机结构，只替换每个状态对应的 AnimationClip——一个状态机模板 + N 套剪辑
2. **适用场景**：大量角色共享相同行为模式（跑、跳、攻击、死亡）但动画不同，如 RPG 中的怪物、格斗游戏中的角色
3. **运行时替换**：AOC 支持运行时动态替换 Clip，可以实现"换装系统""武器切换动画"等功能
4. **性能注意**：AOC 会创建独立的 AnimatorController 运行时实例，虽然共享状态机定义，但动画评估和曲线采样是独立的
5. **替代方案对比**：Playable API + AnimationPlayableGraph 提供更灵活的运行时动画组合，但复杂度更高；Sync Layer 适合时间轴对齐的同步

### 📖 深度展开

#### AnimatorOverrideController 基本用法

```csharp
// 创建 Override Controller
// 方法一：在 Project 窗口右键 Create > Animator Override Controller
// 然后指定 Base AnimatorController，逐个替换 Clip

// 方法二：运行时创建
public AnimatorController baseController;
public AnimationClip[] idleClips;
public AnimationClip[] runClips;

void SetupCharacter(int characterIndex)
{
    var overrideController = new AnimatorOverrideController(baseController);
    
    // 原始 Clip → 替换 Clip 的映射
    overrideController["Idle"] = idleClips[characterIndex];
    overrideController["Run"]  = runClips[characterIndex];
    // key 是原始 AnimationClip 的名称
    
    // 应用到 Animator
    GetComponent<Animator>().runtimeAnimatorController = overrideController;
}
```

#### 状态机复用架构图

```
                    Base AnimatorController
                    ┌─────────────────────────┐
                    │  Idle ──→ Run ──→ Jump  │
                    │   ↑        ↑        ↑   │
                    │  Attack   Hit     Death │
                    └─────────────────────────┘
                              ↑
            ┌─────────────────┼─────────────────┐
            │                 │                  │
    AOC - 战士        AOC - 法师         AOC - 弓箭手
    Idle → 战士Idle    Idle → 法师Idle     Idle → 弓箭手Idle
    Run  → 战士Run     Run  → 法师Run      Run  → 弓箭手Run
    Atk  → 战士挥剑    Atk  → 法师施法     Atk  → 弓箭手射箭
```

#### 运行时动态替换（武器切换示例）

```csharp
public class WeaponAnimationSwitcher : MonoBehaviour
{
    [System.Serializable]
    public class WeaponClipSet
    {
        public AnimationClip idle;
        public AnimationClip attack;
        public AnimationClip reload;
    }

    public AnimatorOverrideController baseAOC;
    public WeaponClipSet swordClips;
    public WeaponClipSet bowClips;
    public WeaponClipSet staffClips;

    private AnimatorOverrideController runtimeAOC;
    private Animator animator;

    void Awake()
    {
        animator = GetComponent<Animator>();
        // 克隆一份，避免修改原始资源
        runtimeAOC = new AnimatorOverrideController(baseAOC);
        animator.runtimeAnimatorController = runtimeAOC;
    }

    public void SwitchWeapon(WeaponType type)
    {
        WeaponClipSet set = type switch
        {
            WeaponType.Sword => swordClips,
            WeaponType.Bow   => bowClips,
            WeaponType.Staff => staffClips,
            _ => swordClips
        };

        // 运行时替换（状态机会保持当前状态，只换 Clip）
        runtimeAOC["Idle_Weapon"] = set.idle;
        runtimeAOC["Attack_Weapon"] = set.attack;
        runtimeAOC["Reload_Weapon"] = set.reload;
    }
}
```

#### 多角色动画复用方案对比

| 方案 | 原理 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|----------|
| **AnimatorOverrideController** | 保留状态机结构，替换 Clip | 简单直观、Editor 可视化 | 状态机修改需改 Base、Clip 数量必须匹配 | 角色多但行为模式相同 |
| **Playable API** | 运行时动态构建动画图 | 极度灵活、无需预定义状态机 | 代码复杂、无 Editor 可视化 | 程序化动画、动态混合 |
| **Sync Layer** | 同步层之间的时间轴 | 跨角色动画同步 | 需要相同状态结构 | 合唱、队列动作 |
| **Avatar Mask + Layers** | 同一 Controller 多层 | 上下半身分离 | 不适合完全不同的角色 | 武器持握、表情 |
| **直接替换 Clip（Editor）** | 手动为每角色建 Controller | 零学习成本 | 维护灾难、不可复用 | 小型项目 |

#### Playable API 实现动画复用（进阶）

```csharp
using UnityEngine.Animations;
using UnityEngine.Playables;

public class DynamicAnimationGraph : MonoBehaviour
{
    public AnimationClip idleClip;
    public AnimationClip runClip;
    
    private PlayableGraph graph;
    private AnimationMixerPlayable mixer;
    private AnimationClipPlayable[] clipPlayables;
    
    void OnEnable()
    {
        Animator animator = GetComponent<Animator>();
        
        graph = PlayableGraph.Create("DynamicAnim");
        graph.SetTimeUpdateMode(DirectorUpdateMode.GameTime);
        
        var output = AnimationPlayableOutput.Create(graph, "AnimOutput", animator);
        mixer = AnimationMixerPlayable.Create(graph, 2);
        
        clipPlayables = new AnimationClipPlayable[2];
        clipPlayables[0] = AnimationClipPlayable.Create(graph, idleClip);
        clipPlayables[1] = AnimationClipPlayable.Create(graph, runClip);
        
        graph.Connect(clipPlayables[0], 0, mixer, 0);
        graph.Connect(clipPlayables[1], 0, mixer, 1);
        output.SetSourcePlayable(mixer);
        
        graph.Play();
    }
    
    public void SetBlend(float moveAmount)
    {
        mixer.SetInputWeight(0, 1f - moveAmount); // Idle
        mixer.SetInputWeight(1, moveAmount);       // Run
    }
    
    void OnDisable()
    {
        graph.Destroy();
    }
}
```

**Playable API 优势**：无需 AnimatorController 资源，完全代码驱动，可以动态混入任意数量的 Clip。

#### 性能考量

```
角色数量 vs 方案选择：

1-5 个角色：  直接为每角色建独立 AnimatorController（最简单）
5-20 个角色： AnimatorOverrideController（维护成本低）
20+ 个角色：  Playable API + 动画数据驱动（最灵活）
所有角色同屏： 考虑 GPU Skinning / Instanced Skinning
```

### ⚡ 实战经验

1. **AOC 的 Clip 必须与 Base 完全匹配**：如果 Base 状态机有 8 个 Clip 槽位，AOC 也必须填满 8 个（可以为 null，但状态运行时会报 Warning）。在 Editor 中会列出所有需要替换的 Clip，方便检查
2. **运行时频繁替换 Clip 有 GC 风险**：`AnimatorOverrideController["ClipName"]` 每次调用会查找 Clip，应缓存 name 为 `AnimationClip` 引用，或使用 `GetOverrides()` 批量操作。高频切换（如每帧混合）应改用 Playable API
3. **Override 不影响 Animator 的参数和 Transition 条件**：AOC 只替换 Clip，不改变状态之间的跳转逻辑、参数条件、过渡时间。这是它的核心优势——修改一次 Base 状态机，所有角色自动同步
4. **多个角色使用同一 Base 时注意 Avatar**：不同体型（人类、四足兽、矮人）需要不同的 Avatar 和骨骼层级。AOC 替换的是 Clip 而非 Avatar，如果骨骼结构不同需要 Retargeting 或 Humanoid 动画

### 🔗 相关问题

- Unity Animator 的状态机 Transition 中 Has Exit Time 和 Interruption Source 如何影响动画流？
- 如何使用 Playable API 实现运行时动画混合，替代 Animator 状态机？
- Humanoid 和 Generic 动画类型的 Retargeting 原理是什么？
