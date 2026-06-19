---
title: "Unity 中 UniTask 是什么？为什么比 Task 和协程更适合 Unity 异步编程？"
category: "unity"
level: 2
tags: ["UniTask", "异步编程", "C#", "性能优化"]
related: ["unity/coroutine-async-await", "unity/gc-performance"]
hint: "UniTask 用 struct 替代 class，基于 PlayerLoop 驱动，实现零 GC 异步。"
---

## 参考答案

### ✅ 核心要点

1. **UniTask 是专为 Unity 设计的零分配异步框架**，替代标准 `Task` / `ValueTask`，彻底消除异步的 GC 开销
2. **协程（Coroutine）的致命缺陷**：返回值只能是 IEnumerator、无法捕获异常、绑定 MonoBehaviour 生命周期、回调地狱
3. **UniTask 基于 Unity PlayerLoop 驱动**，不依赖 .NET ThreadPool，在 Unity 主线程上下文中无缝运行
4. **支持 CancellationToken、超时、进度报告**等完整的异步控制流，API 设计与原生 Task 对齐
5. **与 Addressables、UnityWebRequest 等系统集成**，提供直接的 UniTask 扩展方法

### 📖 深度展开

#### 为什么标准 Task 在 Unity 中不好用？

| 问题维度 | `Task` (System.Threading) | `Coroutine` (UnityEngine) | `UniTask` |
|---------|--------------------------|--------------------------|-----------|
| **GC 分配** | 每次创建 Task 对象，有 GC | 每次 yield 有少量分配 | **零分配**（struct + 对象池） |
| **线程模型** | 依赖 ThreadPool，可能切线程 | 主线程驱动 | 主线程驱动（PlayerLoop） |
| **异常处理** | try-catch 正常工作 | 异常只打日志，无法捕获 | try-catch 正常工作 |
| **返回值** | `Task<T>` | 无（只能 yield） | `UniTask<T>` |
| **取消支持** | CancellationToken | 手动 Stop/StopAll | CancellationToken |
| **生命周期** | 与 MonoBehaviour 无关 | 绑定 MonoBehaviour | 可绑定 GameObject |

#### UniTask 的零分配原理

```csharp
// 标准Task: 堆分配
public async Task<int> GetHpAsync() {
    await Task.Delay(1000);
    return 100;  // Task<int> 是引用类型 → GC
}

// UniTask: 栈分配（struct）
public async UniTask<int> GetHpAsync() {
    await UniTask.Delay(1000);
    return 100;  // UniTask<int> 是 readonly struct → 无 GC
}
```

UniTask 底层通过 **状态机 + AsyncMethodBuilder** 实现零分配：
```csharp
// 编译器生成的状态机使用 UniTaskMethodBuilder
// 它内部维护一个静态的 Awaiter 池，避免重复分配
[AsyncMethodBuilder(typeof(UniTaskAsyncMethodBuilder))]
public readonly struct UniTask {
    internal readonly int token;
    // ... 没有引用类型字段
}
```

#### 实际使用模式

**1. 替代协程——延迟与动画等待**
```csharp
// 旧协程方式
IEnumerator DelayAndFire() {
    yield return new WaitForSeconds(2f);
    FireEvent();
}
StartCoroutine(DelayAndFire());

// UniTask 方式
async UniTaskVoid DelayAndFire() {
    await UniTask.Delay(TimeSpan.FromSeconds(2f));
    FireEvent();
}
DelayAndFire().Forget();  // Forget() 表示不等待结果（fire-and-forget）
```

**2. 加载流程——串行/并行**
```csharp
// 并行加载多个资源，全部完成后继续
var (character, weapon, effect) = await UniTask.WhenAll(
    Addressables.LoadAssetAsync<GameObject>("Character"),
    Addressables.LoadAssetAsync<GameObject>("Weapon"),
    Addressables.LoadAssetAsync<GameObject>("Effect")
);

// 串行加载（有依赖关系）
var map = await LoadMapAsync();
var npcs = await LoadNpcsAsync(map.npcIds);
var triggers = await LoadTriggersAsync(map.triggerIds);
```

**3. CancellationToken 与超时**
```csharp
public class EnemyAI : MonoBehaviour {
    CancellationTokenSource cts;

    async UniTaskVoid AILoop(CancellationToken token) {
        while (!token.IsCancellationRequested) {
            var target = FindNearestPlayer();
            if (target != null) {
                await MoveToAsync(target.position, token);
                await AttackAsync(token);
            }
            await UniTask.Delay(500, cancellationToken: token);
        }
    }

    void OnEnable() {
        cts = new CancellationTokenSource();
        // GetCancellationTokenOnDestroy() 自动绑定生命周期
        AILoop(this.GetCancellationTokenOnDestroy()).Forget();
    }

    void OnDisable() => cts.Cancel();
}
```

**4. 进度报告**
```csharp
async UniTask LoadLevelAsync(IProgress<float> progress) {
    var handle = Addressables.LoadAssetAsync<GameObject>("Level3");
    while (!handle.IsDone) {
        progress.Report(handle.PercentComplete);
        await UniTask.Yield();
    }
    progress.Report(1f);
}

// 调用
await LoadLevelAsync(Progress.Create<float>(p => {
    loadingBar.value = p;
}));
```

#### PlayerLoop 集成

UniTask 通过注入 Unity PlayerLoop 实现主线程调度：

```
Unity PlayerLoop
├── Initialization
├── EarlyUpdate
├── FixedUpdate        ← UniTask 可在此阶段继续
├── Update             ← UniTask 默认在此阶段继续
├── LateUpdate         ← UniTask.Yield(LateUpdate) 可指定
├── PreLateUpdate
└── PostLateUpdate
```

`UniTask.Yield(PlayerLoopTiming.FixedUpdate)` 可以精确控制 continuation 在哪个阶段执行，这是标准 Task 做不到的。

### ⚡ 实战经验

1. **不要 `await` 忘记 `Forget()`**：`async UniTaskVoid` 方法必须调用 `.Forget()`，否则整个异步链不会执行——这是从协程迁移时最常犯的错误
2. **正确绑定取消令牌**：用 `this.GetCancellationTokenOnDestroy()` 而非手动管理 CTS，可以避免 GameObject 销毁后异步回调还在执行导致的「MissingReferenceException」
3. **避免在热路径中使用 `UniTask.Run`**：`UniTask.Run` 会切换到 ThreadPool，频繁调用会引入线程切换开销；CPU 密集型任务优先考虑 Job System 而非 UniTask.Run
4. **与第三方库集成时检查兼容性**：很多老插件只返回 `Task` 或使用回调，可以通过 `.AsUniTask()` 扩展方法桥接，但注意线程上下文差异

### 🔗 相关问题

- UniTask 和 UniRx（Reactive Extensions）有什么关系？项目中该选哪个？
- UniTask 的 `UniTaskVoid` 和 `UniTask` 有什么区别？什么时候用哪个？
- 如何实现一个自定义的 `IUniTaskSource`（比如封装第三方 SDK 的回调）？
