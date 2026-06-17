---
title: "Unity 中协程（Coroutine）和 async/await 有什么区别？各自适用什么场景？"
category: "unity"
level: 2
tags: ["脚本编程", "Coroutine", "async/await", "C#"]
related: ["unity/monobehaviour-lifecycle", "unity/gc-performance"]
hint: "两者都能处理异步逻辑，但底层机制、生命周期绑定和异常处理完全不同。"
---

## 参考答案

### ✅ 核心要点

1. **协程是 Unity 引擎层概念**：通过 `StartCoroutine` 启动，本质是迭代器模式（`IEnumerator`），由引擎每帧驱动
2. **async/await 是 C# 语言层特性**：基于状态机编译 + `Task`/`UniTask`，不依赖 Unity 引擎驱动
3. **生命周期绑定**：协程与 MonoBehaviour 绑定，GameObject 销毁则协程停止；async/await 不自动跟随
4. **性能差异**：协程每帧产生少量开销；async/await 配合 UniTask 几乎零分配（struct 状态机）
5. **异常处理**：协程中的异常难以 try-catch 捕获；async/await 支持标准 try-catch

### 📖 深度展开

#### 协程（Coroutine）原理

协程本质是一个 **迭代器（Iterator）**，通过 `yield return` 暂停执行，引擎在下一帧或指定条件后恢复：

```csharp
// 经典协程：延迟执行
IEnumerator DelayedAction(float delay)
{
    yield return new WaitForSeconds(delay);
    Debug.Log("延迟执行完毕");

    yield return new WaitForEndOfFrame();
    Debug.Log("帧末执行");

    // 协程内部异常无法被外部 try-catch 捕获
    // 会直接中断协程并打印错误日志
}

void Start()
{
    StartCoroutine(DelayedAction(2f));
    // 停止：StopCoroutine("DelayedAction") 或保存引用停止
}
```

**常用 yield 指令：**

| 指令 | 恢复时机 | 典型用途 |
|------|---------|---------|
| `null` | 下一帧 Update 之后 | 帧间等待 |
| `WaitForSeconds(t)` | t 秒后（缩放时间） | 计时器 |
| `WaitForSecondsRealtime(t)` | t 秒后（真实时间） | UI 不受 TimeScale 影响 |
| `WaitForEndOfFrame()` | 当前帧渲染完毕后 | 截屏、读取渲染结果 |
| `WaitForFixedUpdate()` | 下一次 FixedUpdate 后 | 物理时序等待 |
| `WaitUntil(predicate)` | 条件为 true 时 | 等待状态就绪 |
| `WaitWhile(predicate)` | 条件为 false 时 | 反向等待 |

#### async/await 原理

C# 编译器将 `async` 方法编译为 **状态机**，`await` 处暂停并返回调用者，任务完成后通过回调恢复：

```csharp
// 使用 UniTask（推荐 Unity 项目使用）
using Cysharp.Threading.Tasks;

async UniTaskVoid FadeOutAsync(Image image, float duration)
{
    try
    {
        float elapsed = 0f;
        Color original = image.color;

        while (elapsed < duration)
        {
            elapsed += Time.deltaTime;
            image.color = Color.Lerp(
                original,
                new Color(original.r, original.g, original.b, 0f),
                elapsed / duration
            );
            await UniTask.Yield(); // 等一帧，零分配
        }

        image.gameObject.SetActive(false);
    }
    catch (System.OperationCanceledException)
    {
        // 任务被取消时的清理
        Debug.Log("淡出被取消");
    }
}

void Start()
{
    FadeOutAsync(GetComponent<Image>(), 1.5f).Forget();
    // Forget() 表示不等待结果（fire-and-forget）
}
```

#### 核心对比

```
┌─────────────────────────────────────────────────┐
│              执行模型对比                         │
├──────────────┬──────────────────────────────────┤
│   协程        │       async/await               │
├──────────────┼──────────────────────────────────┤
│ 引擎每帧调用   │ TaskScheduler / UniTask 调度     │
│ IEnumerator   │ 编译器生成的状态机                 │
│ 值类型 yield   │ struct 状态机（UniTask 零分配）   │
│ 绑定 MonoBehaviour │ 可绑定 CancellationToken     │
│ 无返回值       │ 可有返回值 (UniTask<T>)          │
│ 异常难捕获     │ 标准 try-catch                  │
│ 无法 await    │ 可任意嵌套 await                 │
│ Unity 专有    │ C# 标准生态                      │
└──────────────┴──────────────────────────────────┘
```

#### CancellationToken — 生命周期安全

async/await 的关键优势是 **可取消 + 可绑定 GameObject 生命周期**：

```csharp
using Cysharp.Threading.Tasks;

public class EnemyAI : MonoBehaviour
{
    private CancellationTokenSource cts;

    async UniTaskVoid PatrolAsync()
    {
        var token = this.GetCancellationTokenOnDestroy();
        // ↑ GameObject 销毁时自动取消，无需手动管理

        while (!token.IsCancellationRequested)
        {
            await MoveToNextWaypoint(token);
            await UniTask.Delay(1000, cancellationToken: token);
            ScanForTargets();
        }
    }

    void OnEnable() => cts = new CancellationTokenSource();
    void OnDisable() => cts?.Cancel();
}
```

### ⚡ 实战经验

- **新项目首选 async/await + UniTask**：零 GC、可取消、可返回值、异常可捕获，全面优于协程
- **协程的隐藏陷阱**：`WaitForSeconds` 每次 yield 都会 new 一个对象，高频使用产生 GC 垃圾，应缓存复用或改用 `UniTask.Delay`
- **不要在协程里 try-catch**：Unity 的协程调度器会吞掉异常，bug 极难排查；需要异常处理的场景一律用 async/await
- **混合使用注意**：在协程中 `await` 一个 UniTask 需要 `UniTask.ToCoroutine()` 适配，反之亦然

### 🔗 相关问题

- UniTask 是什么？为什么比标准 Task 更适合 Unity？
- 如何在 async 方法中正确处理 GameObject 销毁导致的空引用？
- Unity 的 `Invoke` / `InvokeRepeating` 和协程相比有什么局限？
