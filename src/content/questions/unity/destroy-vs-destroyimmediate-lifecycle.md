---
title: "Unity 中 Destroy、DestroyImmediate 和 SetActive(false) 有什么区别？对象销毁的完整生命周期是什么？"
category: "unity"
level: 2
tags: ["引擎架构", "对象生命周期", "内存管理", "面试高频"]
related: ["unity/monobehaviour-lifecycle", "unity/gameobject-component-model", "unity/gc-performance"]
hint: "Destroy 是延迟销毁，DestroyImmediate 是立即销毁，SetActive 只是隐藏——但背后的引擎行为远比表面复杂。"
---

## 参考答案

### ✅ 核心要点

1. **Destroy(obj)** 在当前帧结束后安全销毁对象，是运行时的标准做法
2. **DestroyImmediate(obj)** 立即销毁，主要给编辑器模式使用，运行时慎用
3. **SetActive(false)** 不销毁对象，只是禁用组件执行和渲染，对象仍在内存中
4. 销毁后引用不会自动置 null（C# 层仍有指针），但 Unity 重载了 `==` 运算符使其表现得像 null
5. 真正的内存回收依赖 GC，Destroy 只释放引擎侧的 Native 内存

### 📖 深度展开

#### 三者行为对比

| 维度 | Destroy | DestroyImmediate | SetActive(false) |
|------|---------|-------------------|-------------------|
| 执行时机 | 帧末（延迟） | 立即（同步） | 立即（同步） |
| 对象状态 | 标记销毁，帧末释放 | 即时销毁 | 禁用但存活 |
| 内存释放 | 引擎侧立即标记，C# 侧等 GC | 同左 | 不释放 |
| Awake 重新触发 | ❌ 不可逆 | ❌ 不可逆 | ✅ 重新 SetActive(true) 不触发 Awake |
| OnEnable/OnDisable | 触发 OnDestroy | 触发 OnDestroy | 触发 OnDisable |
| 安全性 | ✅ 运行时安全 | ⚠️ 可能破坏迭代 | ✅ 安全 |
| 适用场景 | 运行时销毁 | Editor 脚本、Asset 清理 | UI 隐藏、对象池 |

#### Destroy 的执行时间线

```
调用 Destroy(obj)
    ↓
obj 被标记为 "待销毁"（m_Destroying = true）
    ↓
当前帧继续执行（obj 仍然存在，但 isAlive == false）
    ↓
帧末：引擎执行实际销毁
    ├── 触发 OnDestroy() 回调
    ├── 释放 Native 内存（C++ 侧）
    ├── 从场景树中移除
    └── C# 包装器变为 "fake null"
    ↓
后续 GC 回收 C# 侧托管内存
```

#### "Fake Null" 机制

Unity 在 C++ 层销毁对象后，C# 的引用仍然存在。为了防止空指针崩溃难以调试，Unity 重载了 `UnityEngine.Object` 的 `==` 和 `!=` 运算符：

```csharp
// 看起来是 null，实际上 C# 引用还在
GameObject obj = new GameObject("Test");
Destroy(obj);

// 这一帧内，obj != null 仍然为 true（对象还没真正销毁）
// 下一帧，obj == null 返回 true（fake null 生效）

// ⚠️ 性能注意：与 null 比较时，Unity 的重载运算符比原生 C# null 检查慢约 10-50 倍
// 在热路径中避免频繁与 UnityEngine.Object 做 null 检查
```

#### DestroyImmediate 为什么危险

```csharp
// ❌ 危险示例：在 foreach 中立即销毁
foreach (Transform child in transform)
{
    DestroyImmediate(child.gameObject); // 可能跳过元素或崩溃
}

// ✅ 正确做法：倒序遍历或先收集再销毁
for (int i = transform.childCount - 1; i >= 0; i--)
{
    Destroy(transform.GetChild(i).gameObject);
}
```

DestroyImmediate 的核心问题：
- **破坏迭代器**：在遍历集合时立即修改集合，导致跳过元素或抛异常
- **触发同步回调**：OnDestroy 在当前调用栈中同步执行，可能引发重入问题
- **Editor 专用**：在 Editor 脚本中，Destroy 无法立即移除资产引用，必须用 DestroyImmediate

#### SetActive 与组件生命周期

```csharp
// SetActive(false) 触发的回调链
gameObject.SetActive(false);
// → OnDisable()
// → 如果是子物体，子物体也被禁用（但不会触发各自 OnDisable，除非父级之前是 active）

gameObject.SetActive(true);
// → OnEnable()
// → 不会重新触发 Awake() / Start()
```

#### 对象池的正确姿势

```csharp
public class GameObjectPool
{
    private readonly Queue<GameObject> pool = new();
    private readonly GameObject prefab;

    public GameObject Spawn(Vector3 pos)
    {
        GameObject obj = pool.Count > 0 ? pool.Dequeue() : Object.Instantiate(prefab);
        obj.transform.position = pos;
        obj.SetActive(true); // 触发 OnEnable
        return obj;
    }

    public void Despawn(GameObject obj)
    {
        obj.SetActive(false); // 触发 OnDisable，不销毁
        pool.Enqueue(obj);
    }

    // ⚠️ 注意：池化对象内部的 Awake 只执行一次（首次 Instantiate）
    // 每次 Spawn/Despawn 只触发 OnEnable/OnDisable
    // 不要在 OnEnable 中做重型初始化
}
```

### ⚡ 实战经验

- **运行时永远用 Destroy**，DestroyImmediate 留给编辑器扩展。混用是 Bug 的温床
- **对象池中用 SetActive(false) 而非 Destroy**，频繁 Instantiate/Destroy 会触发大量 GC 和内存碎片
- **注意 Destroy 的延迟特性**：调用 Destroy 后，如果同帧代码继续访问该对象，可能拿到半失效状态。必要时用 `if (obj == null) return;` 做保护
- **在 OnDestroy 中不要依赖其他 GameObject**：销毁顺序不确定，被引用的对象可能已经先销毁了。用 `if (otherObj != null)` 保护或使用 `Application.isPlaying` 判断

### 🔗 相关问题

- MonoBehaviour 生命周期的完整顺序是什么？哪些回调可以重复触发？
- 对象池在什么场景下反而降低性能？（提示：频繁SetActive 的重建开销）
- Unity 的 fake null 机制对性能有多大影响？如何规避？
