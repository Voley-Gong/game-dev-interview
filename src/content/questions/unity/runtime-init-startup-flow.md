---
title: "Unity 的启动流程是怎样的？RuntimeInitializeOnLoadMethod、PlayerLoop 和场景加载的执行顺序是什么？"
category: "unity"
level: 2
tags: ["引擎架构", "启动流程", "生命周期", "PlayerLoop"]
related: ["unity/monobehaviour-lifecycle", "unity/scene-management-additive", "unity/scriptableobject-architecture"]
hint: "从 Player 进程启动到第一帧渲染，Unity 引擎内部经历了哪些阶段？RuntimeInitializeOnLoadMethod 在哪个时机执行？"
---

## 参考答案

### ✅ 核心要点

1. **引擎启动阶段顺序**：Native Player 启动 → 加载 Player Settings → 初始化子系统（渲染、物理、音频）→ 执行 `RuntimeInitializeOnLoadMethod` → 加载首个场景 → Awake → OnEnable → Start → 首帧渲染
2. **RuntimeInitializeOnLoadMethod** 在场景加载之前执行，分 `BeforeSceneLoad` 和 `AfterSceneLoad` 两个时机，是做全局初始化的最佳位置
3. **PlayerLoop API**（2019.3+）允许向 Unity 主循环注入自定义回调，可以在 Update、LateUpdate 等阶段前后插入逻辑
4. **Splash Screen 和首帧**：Unity 在第一个场景的 Start 执行完毕后，才会隐藏 Splash Screen 并渲染首帧，首场景的初始化耗时直接影响启动白屏时间
5. **脚本执行顺序**：不同脚本的 Awake/Start 顺序默认不确定，可通过 Script Execution Order 设置或 `[DefaultExecutionOrder]` 特性控制

### 📖 深度展开

#### 完整启动流程图

```
Unity Player 进程启动
  │
  ├── 1. Native 引擎初始化
  │     ├── 加载 Boot.config（平台配置）
  │     ├── 初始化图形上下文（Vulkan/Metal/GLES）
  │     ├── 初始化物理引擎（PhysX）
  │     ├── 初始化音频系统
  │     └── 加载 Player Settings
  │
  ├── 2. 托管域加载（Managed Domain）
  │     ├── 加载所有程序集（Assembly.Load）
  │     ├── 运行 IL2CPP / JIT 初始化
  │     └── 执行静态构造函数（Type initializer）
  │         ⚠️ 注意：静态构造函数执行顺序不确定
  │
  ├── 3. RuntimeInitializeOnLoadMethod(BeforeSceneLoad)
  │     ├── 按程序集加载顺序执行
  │     ├── 适合：全局管理器创建、配置加载、SDK 初始化
  │     └── 此时场景尚未加载，无法访问场景中的对象
  │
  ├── 4. 加载首个场景（Build Settings 中 index 0）
  │     ├── 反序列化场景中所有 GameObject 和 Component
  │     ├── 激活场景（SetActive）
  │     └── 执行 Awake() ← 按不确定顺序
  │
  ├── 5. RuntimeInitializeOnLoadMethod(AfterSceneLoad)
  │     ├── 场景已加载但首帧尚未渲染
  │     └── 适合：场景初始化、依赖场景对象的注册
  │
  ├── 6. OnEnable()（所有激活的组件）
  │
  ├── 7. Start()（所有激活的组件）
  │     └── 首次 Update 之前必定执行完毕
  │
  ├── 8. 隐藏 Splash Screen
  │
  └── 9. 进入主循环（PlayerLoop）
        ┌─────────────────────────┐
        │ EarlyUpdate             │
        │   ├── Physics           │
        │   └── Input             │
        ├─────────────────────────┤
        │ Update                  │
        │   ├── MonoBehaviour.Update │
        │   └── Coroutine         │
        ├─────────────────────────┤
        │ LateUpdate              │
        │   └── MonoBehaviour.LateUpdate │
        ├─────────────────────────┤
        │ PreLateUpdate           │
        │   └── Render            │
        └─────────────────────────┘
```

#### RuntimeInitializeOnLoadMethod 详解

```csharp
public class GameBootstrap : MonoBehaviour
{
    // ✅ 场景加载前执行 —— 全局初始化
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void InitBeforeScene()
    {
        // 创建持久化管理器
        var managerObj = new GameObject("[GameManager]");
        DontDestroyOnLoad(managerObj);
        
        // 加载配置
        var config = LoadRemoteConfig();
        GameManager.Instance.Initialize(config);
        
        // 初始化 SDK
        AnalyticsSDK.Init();
        AdSDK.Init();
    }

    // ✅ 场景加载后执行 —— 依赖场景对象
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void InitAfterScene()
    {
        // 此时可以访问场景中的对象
        var entryPoint = FindObjectOfType<SceneEntryPoint>();
        entryPoint?.OnSceneReady();
        
        // 注册到事件总线
        EventBus.Subscribe<GameStartEvent>(OnGameStart);
    }

    // ⚠️ 多个 RuntimeInitializeOnLoadMethod 之间没有确定顺序
    // 如需顺序控制，用静态构造函数 + 标志位 或统一管理器
}
```

#### PlayerLoop API 注入自定义更新

```csharp
using UnityEngine.LowLevel;
using UnityEngine.PlayerLoop;

public static class CustomPlayerLoop
{
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void Inject()
    {
        var playerLoop = PlayerLoop.GetCurrentPlayerLoop();
        var customUpdate = new PlayerLoopSystem
        {
            type = typeof(CustomPlayerLoop),
            updateDelegate = CustomUpdate
        };

        // 在 Update 子系统中插入自定义回调
        for (int i = 0; i < playerLoop.subSystemList.Length; i++)
        {
            if (playerLoop.subSystemList[i].type == typeof(Update))
            {
                var updateSystems = playerLoop.subSystemList[i].subSystemList;
                var newSubSystems = new PlayerLoopSystem[updateSystems.Length + 1];
                System.Array.Copy(updateSystems, newSubSystems, updateSystems.Length);
                newSubSystems[^1] = customUpdate;
                playerLoop.subSystemList[i].subSystemList = newSubSystems;
                break;
            }
        }

        PlayerLoop.SetPlayerLoop(playerLoop);
    }

    static void CustomUpdate()
    {
        // 每帧 Update 阶段最后执行
        TickManager.OnFrame();
    }
}
```

#### Script Execution Order 机制

| 方式 | 用法 | 优先级 |
|------|------|--------|
| Script Execution Order 窗口 | Edit → Project Settings → Script Execution Order | 全局，按数字从小到大 |
| `[DefaultExecutionOrder]` 特性 | `[DefaultExecutionOrder(-100)]` 标注在类上 | 等价于窗口设置，适合库/插件 |
| 手动控制 | 在 Awake 中注册，在 Start 中执行依赖逻辑 | 最灵活，推荐用于复杂依赖 |

```csharp
// 方式一：Inspector 设置（优先级数字，越小越早）
// Edit → Project Settings → Script Execution Order
// 添加脚本，设置 -100 ~ 100

// 方式二：特性标注
[DefaultExecutionOrder(-200)] // 比大多数脚本先执行
public class GameManager : MonoBehaviour { ... }

// 方式三：推荐 —— 注册 + 延迟初始化
public class LevelManager : MonoBehaviour
{
    void Awake()
    {
        ServiceLocator.Register(this); // 只注册引用
    }
    
    void Start()
    {
        // 此时所有 Awake 已执行完毕，依赖对象都已注册
        ServiceLocator.Get<GameManager>().Init();
    }
}
```

#### 启动性能优化关键

| 阶段 | 常见耗时 | 优化手段 |
|------|---------|---------|
| 程序集加载 | 200-800ms | 减少程序集数量（合并 asmdef）、IL2CPP 优化 |
| 静态构造函数 | 50-200ms | 避免在 `static()` 中做重逻辑 |
| BeforeSceneLoad | 100-500ms | 延迟非关键 SDK 初始化 |
| 场景反序列化 | 200-2000ms | 减少首场景对象数量、使用 Prefab 减少数据量 |
| Awake/Start | 100-500ms | 分帧初始化（StartCoroutine 延迟） |

### ⚡ 实战经验

- **首场景越轻越好**：首个场景只放一个 Bootstrapper + 基础 UI，其余逻辑用代码动态加载。移动端首场景超过 2MB 序列化数据基本就是启动卡顿
- **SDK 初始化分层**：必须在首帧前完成的（崩溃上报、性能监控）放 `BeforeSceneLoad`；可以延迟的（广告、社交）放到首场景 Start 之后用协程延迟 1-3 秒初始化
- **静态构造函数是雷区**：不要在 `static()` 中调用 Unity API（如 `Resources.Load`），因为执行时机在托管域加载阶段，Unity 可能尚未完全初始化。正确做法是放在 `RuntimeInitializeOnLoadMethod` 中
- **用 Profiler 验证启动耗时**：连接 Deep Profiler 启动一次，检查 "PlayerStartTime" 到首帧的时间分布。Android 上可用 `adb logcat | grep Unity` 看 Unity 引擎日志中的阶段时间戳

### 🔗 相关问题

- MonoBehaviour 生命周期中 Awake、OnEnable、Start 的执行顺序和调用次数是什么？
- Unity 场景异步加载（LoadSceneAsync）的过程中，各阶段回调的时机是什么？
- 如何用 Addressables 实现场景预加载，减少场景切换卡顿？
