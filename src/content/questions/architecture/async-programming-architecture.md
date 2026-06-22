---
title: "游戏中的异步编程：协程、回调、Task、UniTask 该怎么选？"
category: "architecture"
level: 3
tags: ["异步编程", "协程", "UniTask", "async/await", "架构设计"]
related: ["architecture/dependency-injection-lifecycle", "architecture/game-loop-subsystem"]
hint: "异步方案选型本质是在「可读性、性能、生命周期绑定、异常处理」之间权衡。"
---

## 参考答案

### ✅ 核心要点

1. **回调（Callback）**：最原始，控制流散落、易形成「回调地狱」，但无额外开销，适合简单一次性通知
2. **协程（Coroutine）**：Unity 专属、生命周期绑 GameObject、可用 `yield` 直观表达时序，但无法返回值、不支持 `try/catch`、必须 `StartCoroutine` 驱动
3. **`Task` / `async-await`**：C# 原生、可返回值、可异常处理、可组合，但默认跑在主线程同步上下文上，且会产生 GC（Task 对象 + 状态机闭包）
4. **UniTask**：为零分配设计的替代品，`UniTask` 是值类型（struct），无 GC、无需同步上下文，写法等同 async/await，是手游的高性能首选
5. **生命周期是最大陷阱**：异步操作常比发起它的对象「活得更久」，协程用 `MonoBehaviour` 销毁自动停，而 Task/UniTask 不会自动停——必须配合 `CancellationToken`

### 📖 深度展开

**四种方案的演进与本质：**

```
回调（散落） → 协程（线性化时序）→ async/await（语言级线性化 + 可组合）→ UniTask（同上但零 GC）
```

async/await 的核心价值是把「异步时序」写成「同步代码的样子」——用编译器生成的状态机替你把回调展开成线性的代码流。

**协程：直观但有硬伤：**

```csharp
IEnumerator DelayedAttack() {
    yield return new WaitForSeconds(1f);     // 无法 try/catch 这一行
    yield return SpawnEffect();
    Enemy.TakeDamage(10);                     // 无法返回值给调用方
}

void Start() {
    StartCoroutine(DelayedAttack());          // 必须绑定在 MonoBehaviour 上
}
// GameObject 销毁 → 协程自动停止（这是协程最大的优点之一）
```

协程的三个硬伤：① 不能 `return` 值；② `yield` 处不能 `try/catch`（异常无法跨 yield 边界）；③ 绑死在 `MonoBehaviour` 上，纯 C# 逻辑类无法用。

**async/await + UniTask：现代标准写法：**

```csharp
// UniTask 写法和原生 Task 几乎一样，但零 GC、可 PlayerLoop 驱动
public async UniTaskVoid PlaySkillFlow(CancellationToken ct) {
    try {
        await PlayAnim("cast", ct);          // 可 try/catch
        await UniTask.Delay(500, cancellationToken: ct);
        var hit = await CastRay(ct);          // 可返回值
        hit.TakeDamage(SkillConfig.Damage);
    } catch (OperationCanceledException) {
        // 取消是预期行为，吞掉即可
    }
}

void OnCast() {
    _cts = new CancellationTokenSource();     // 取消令牌
    PlaySkillFlow(_cts.Token).Forget();       // Forget() 表示「fire and forget」
}

void OnInterrupt() => _cts.Cancel();          // 技能被打断 → 立即取消整条链
```

`CancellationToken` 是处理「玩家中途打断」「切场景」「角色死亡」的关键：传一个 token 进去，调用 `Cancel()` 后整条 await 链立刻短路，不再继续执行后续逻辑。

**方案对比：**

| 维度 | 回调 | 协程 Coroutine | Task/async-await | UniTask |
|------|------|----------------|------------------|---------|
| 可读性 | 差（嵌套） | 好（线性） | 最好（线性+组合） | 最好 |
| 返回值 | ✗ | ✗ | ✅ | ✅ |
| 异常处理 | 手动 | 跨 yield 不支持 | ✅ try/catch | ✅ try/catch |
| GC 开销 | 闭包 | 较少 | Task 对象+状态机 | **零分配（值类型）** |
| 生命周期绑定 | 手动 | 绑 GameObject（自动停） | 不自动停，需 Token | 不自动停，需 Token |
| 纯 C# 类可用 | ✅ | ✗（需 MonoBehaviour） | ✅ | ✅ |

**`UniTask` 为什么零分配：** `UniTask` 本身是 `struct`（值类型），await 时由编译器生成的状态机直接持有这个 struct 字段，不再在堆上 new 对象。而 `Task` 是引用类型，每次 await 都可能产生 Task 实例和闭包分配，在每帧高频调用的游戏循环里会累积成 GC 压力。

**Cocos Creator / 前端的异步（TypeScript）：** 用 `Promise` + `async/await`，思想一致。游戏特有的「帧延迟」用 `await new Promise(r => scheduleOnce(r, dt))` 包装。

### ⚡ 实战经验

- **协程生命周期是双刃剑**：它绑 GameObject 是优点（自动停），但也意味着切场景时若忘了协程正在跑、而依赖的对象已被卸载，会触发 NRE。重要逻辑尽量用 Token 显式管理
- **别在 Update 里高频 await 分配**：原生 `Task` 在热路径（每帧/每子弹）上会产生可观 GC，高频逻辑改用 UniTask 或对象池化的回调
- **`Forget()` 不是万能**：fire-and-forget 的 UniTask 丢了引用，内部异常会被吞掉、无法取消。对有副作用的流程（改数据、发网络）务必保留引用或接 Token
- **`WaitUntil`/协程轮询是性能隐患**：`yield return new WaitUntil(...)` 每帧都判定一次，大量挂起时累积开销；高频条件改用事件驱动，等待方注册监听而非轮询

### 🔗 相关问题

- 协程为什么不能在 `yield` 处用 `try/catch`？底层是怎么实现的？
- `CancellationToken` 在场景切换时如何统一取消所有挂起的异步任务？
- 高频异步（如技能系统每帧判定）下，如何避免 async/await 的 GC 压力？
