---
title: "Unity Timeline 与 Playable Director 是怎么工作的？如何用 Playables API 自定义动画系统？"
category: "unity"
level: 3
tags: ["Timeline", "Playable", "动画系统", "过场动画", "引擎架构"]
related: ["unity/animator-state-machine", "unity/animation-rigging-ik"]
hint: "Timeline 不只是过场动画工具——它背后的 Playables API 是一个通用的可组合图求值引擎。"
---

## 参考答案

### ✅ 核心要点

1. **Playables API 是 Unity 动画/媒体求值的核心引擎**：基于有向无环图（DAG），将动画、音频、视频等数据源组合为统一的求值图
2. **Timeline 是 Playables 的可视化编辑层**：通过 PlayableDirector 组件将时间轴上的 Clip 编译为 Playable Graph 驱动运行
3. **PlayableGraph 是运行时核心**：每个节点是一个 `Playable`，通过 `PlayableGraph` 管理生命周期，每帧从根节点开始遍历求值
4. **比 Animator Controller 更灵活**：Playable 支持运行时动态构建、混合权重、自定义数据源，适合程序化动画和 AI 驱动的复杂场景
5. **自定义 Playable 的核心**：继承 `PlayableBehaviour` + `PlayableAsset`，通过 `PlayableBinding` 声明轨道类型

### 📖 深度展开

#### Playables 架构全景

```
┌────────────────────────────────────────────────────────┐
│                    Timeline 资源 (.playable)             │
│  ┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Track │  │ Track    │  │ Track    │  │ Track    │   │
│  │(Anim) │  │(Audio)   │  │(Cinem.)  │  │(Custom)  │   │
│  └──┬───┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│     │           │            │             │           │
│  ┌──┴──┐     ┌──┴──┐      ┌──┴──┐       ┌──┴──┐      │
│  │Clip1│     │Clip1│      │Clip1│       │Clip1│      │
│  │Clip2│     │Clip2│      │Clip2│       │Clip2│      │
│  └─────┘     └─────┘      └─────┘       └─────┘      │
└──────────────────────┬─────────────────────────────────┘
                       │ PlayableDirector 编译
                       ▼
              ┌────────────────┐
              │  PlayableGraph  │  ← 运行时求值引擎
              │  (DAG 有向图)    │
              │                 │
              │    Root Mixer   │
              │    /    |    \  │
              │  Anim  Audio FX │
              │  / \    |      │
              │ C1 C2  C1     C1│
              └────────────────┘
                       │
                       ▼ 每帧 Evaluate
              ┌────────────────┐
              │  Output Targets │
              │  ├── Animator   │
              │  ├── AudioSource│
              │  ├── Camera     │
              │  └── Custom     │
              └────────────────┘
```

#### Timeline 核心概念

| 概念 | 类 | 说明 |
|------|-----|------|
| Timeline 资源 | `TimelineAsset` | 存储轨道和 Clip 的序列化数据 |
| 播放控制器 | `PlayableDirector` | 组件，驱动 Timeline 播放 |
| 轨道 | `TrackAsset` | 一条时间线，管理一组 Clip |
| 片段 | `TimelineClip` / `PlayableAsset` | 轨道上的一个动画/音频/特效片段 |
| 混合 | `Playable` mixer | 同轨道 Clip 之间的过渡混合 |
| 绑定 | `PlayableBinding` | Track 到场景对象的映射关系 |

#### 运行时播放控制

```csharp
using UnityEngine.Playables;
using UnityEngine.Timeline;

public class CutsceneController : MonoBehaviour
{
    [SerializeField] private PlayableDirector _director;
    [SerializeField] private TimelineAsset _introCutscene;

    public void PlayIntro()
    {
        // 设置 Timeline 资源
        _director.playableAsset = _introCutscene;

        // 绑定场景对象到 Track
        foreach (var binding in _introCutscene.outputs)
        {
            if (binding.streamName == "Animation Track")
            {
                var player = GameObject.Find("Player");
                _director.SetGenericBinding(binding.sourceObject, player.GetComponent<Animator>());
            }
            else if (binding.streamName == "Camera Track")
            {
                var mainCam = Camera.main;
                _director.SetGenericBinding(binding.sourceObject, mainCam);
            }
        }

        // 注册完成回调
        _director.stopped += OnCutsceneFinished;

        // 播放
        _director.Play();
    }

    private void OnCutsceneFinished(PlayableDirector director)
    {
        Debug.Log("[Cutscene] 播放完毕，恢复游戏控制");
        GameManager.Instance.ResumeGameplay();
        director.stopped -= OnCutsceneFinished;
    }

    // 跳过过场动画
    public void SkipCutscene()
    {
        // 方式1：直接跳到末尾
        _director.time = _director.duration;

        // 方式2：快速播放（2x 速度直到结束）
        // _director.playableGraph.GetRootPlayable(0).SetSpeed(4f);
    }
}
```

#### 自定义 Playable：程序化动画混合

这是 Playables API 最强大的能力——运行时动态构建动画混合图，不依赖 Animator Controller：

```csharp
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

[RequireComponent(typeof(Animator))]
public class DynamicAnimationMixer : MonoBehaviour
{
    [SerializeField] private AnimationClip _idleClip;
    [SerializeField] private AnimationClip _walkClip;
    [SerializeField] private AnimationClip _runClip;

    private PlayableGraph _graph;
    private AnimationMixerPlayable _mixer;
    private AnimationClipPlayable _idle;
    private AnimationClipPlayable _walk;
    private AnimationClipPlayable _run;

    private void Start()
    {
        var animator = GetComponent<Animator>();

        // 创建 PlayableGraph
        _graph = PlayableGraph.Create("DynamicAnimMixer");
        _graph.SetTimeUpdateMode(DirectorUpdateMode.GameTime);

        // 创建 AnimationClipPlayable（输入源）
        _idle = AnimationClipPlayable.Create(_graph, _idleClip);
        _walk = AnimationClipPlayable.Create(_graph, _walkClip);
        _run = AnimationClipPlayable.Create(_graph, _runClip);

        // 创建混合器（3 个输入端口）
        _mixer = AnimationMixerPlayable.Create(_graph, 3);
        _graph.Connect(_idle, 0, _mixer, 0);
        _graph.Connect(_walk, 0, _mixer, 1);
        _graph.Connect(_run, 0, _mixer, 2);

        // 创建输出 → 连接到 Animator
        var output = AnimationPlayableOutput.Create(_graph, "Output", animator);
        output.SetSourcePlayable(_mixer);

        _graph.Play();
    }

    // 根据移动速度动态调整三个动画的权重
    public void UpdateBlend(float speed)
    {
        // speed: 0 = idle, 1-3 = walk, 3+ = run
        float idleWeight = Mathf.Clamp01(1f - speed / 2f);
        float runWeight = Mathf.Clamp01((speed - 2f) / 3f);
        float walkWeight = Mathf.Clamp01(1f - idleWeight - runWeight);

        _mixer.SetInputWeight(0, idleWeight);
        _mixer.SetInputWeight(1, walkWeight);
        _mixer.SetInputWeight(2, runWeight);
    }

    private void OnDestroy()
    {
        // PlayableGraph 必须手动销毁，否则泄漏
        if (_graph.IsValid())
            _graph.Destroy();
    }
}
```

#### 自定义 Timeline Track：对话系统

```csharp
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.Timeline;

// ── 1. 数据载体：PlayableBehaviour ──
public class DialogueBehaviour : PlayableBehaviour
{
    public string speaker;
    [TextArea] public string dialogue;
    public float typingSpeed = 30f;

    private bool _played;

    // 每帧调用
    public override void ProcessFrame(
        Playable playable, FrameData info, object playerData)
    {
        if (_played) return;

        double progress = playable.GetTime() / playable.GetDuration();
        var ui = playerData as DialogueUI;

        if (ui != null && progress > 0.01f)
        {
            ui.ShowDialogue(speaker, dialogue, typingSpeed);
            _played = true;
        }
    }
}

// ── 2. 资产：PlayableAsset（Timeline Clip 的数据） ──
public class DialogueClip : PlayableAsset, ITimelineClipAsset
{
    public string speaker = "NPC";
    [TextArea] public string dialogue = "...";
    public float typingSpeed = 30f;

    public ClipCaps clipCaps => ClipCaps.None;

    public override Playable CreatePlayable(
        PlayableGraph graph, GameObject owner)
    {
        var behaviour = new DialogueBehaviour
        {
            speaker = speaker,
            dialogue = dialogue,
            typingSpeed = typingSpeed
        };
        return ScriptPlayable<DialogueBehaviour>.Create(graph, behaviour);
    }
}

// ── 3. 轨道：TrackBindingType 绑定场景对象 ──
[TrackBindingType(typeof(DialogueUI))]
[TrackClipType(typeof(DialogueClip))]
public class DialogueTrack : TrackAsset
{
    public override Playable CreateTrackMixer(
        PlayableGraph graph, GameObject go, int inputCount)
    {
        return ScriptPlayable<DialogueMixer>.Create(graph, inputCount);
    }
}
```

#### Timeline vs Animator Controller 对比

| 维度 | Timeline + Playables | Animator Controller |
|------|---------------------|---------------------|
| 编辑方式 | 时间轴可视化 | 状态机 + 过渡连线 |
| 运行时构建 | ✅ 动态创建/修改 | ❌ 预编译为主 |
| 混合模式 | 任意层数 mixer | 有限 Layer + Blend Tree |
| 多对象编排 | ✅ 一个 Timeline 控制多个对象 | ❌ 每个 Animator 独立 |
| 适用场景 | 过场动画、Boss战阶段、事件序列 | 角色 locomotion、战斗状态切换 |
| 学习成本 | 中高 | 中 |
| 性能开销 | 图遍历 + 混合 | 状态机评估 + 混合 |
| Unity 官方推荐 | 复杂序列动画 | 简单角色动画 |

**最佳实践：两者混用**——角色移动/战斗用 Animator Controller，过场动画/Boss阶段切换用 Timeline 驱动 Animator 参数。

### ⚡ 实战经验

1. **PlayableGraph 泄漏是隐蔽的坑**：每次 `PlayableGraph.Create()` 创建的图**必须手动 `Destroy()`**，否则会泄漏原生内存。在 MonoBehaviour 的 `OnDestroy` 中务必检查 `_graph.IsValid()` 再销毁。Timeline 的 PlayableDirector 会在自己销毁时自动清理，但手动创建的图不会
2. **Timeline 的 `Update Method` 影响暂停行为**：默认使用 `GameTime`，游戏暂停（`Time.timeScale = 0`）时 Timeline 也暂停。如果需要 Timeline 不受时间缩放影响（如 UI 动画），切到 `UnscaledTime`
3. **Clip 的 ` extrapolation`（外推）很有用但容易忽略**：Clip 前后空白区域的行为由 extrapolation 控制（None/Hold/Loop/Continue）。常见的「动画跳回 T-Pose」问题就是 Clip 尾部没有 Hold 导致的
4. **大规模使用 Timeline 时注意序列化体积**：每个 Timeline 资源包含完整的轨道和 Clip 序列化数据，复杂过场可能有数百 KB。移动端项目建议将非关键 Timeline 做成 Addressables 按需加载，而不是全量打进包体

### 🔗 相关问题

- 如何在 Timeline 中实现条件分支（根据玩家选择走不同的过场路径）？
- Playables API 如何与 DOTS/ECS 体系结合使用？
- 多个 PlayableDirector 同时播放会有什么问题？如何管理优先级？
