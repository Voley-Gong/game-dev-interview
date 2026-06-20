---
title: "Unity 中 UnityEngine.Object 与普通 C# 对象有什么区别？为什么 null 比较有坑？"
category: "unity"
level: 2
tags: ["C#", "引擎架构", "生命周期", "内存管理", "UnityEngine.Object"]
related: ["unity/destroy-vs-destroyimmediate-lifecycle", "unity/memory-management-leak", "unity/serialization-system"]
hint: "为什么 GameObject.Destroy(obj) 后 obj != null 仍然为 true？假 null 是什么？"
---

## 参考答案

### ✅ 核心要点

1. **两套对象体系**：Unity 在 C# 托管堆上有一个"壳"对象（wrapper），在 C++ 原生堆上有真正的引擎对象（native object），两者通过指针关联
2. **生命周期不对等**：`Object.Destroy()` 销毁原生对象，但 C# 壳对象不会立即被 GC 回收——直到没有引用后才由垃圾回收器清理
3. **重载的 `==` 和 `!=`**：UnityEngine.Object 重载了相等运算符，会先检查 C++ 对象是否已销毁，所以 `destroyedObj == null` 返回 `true`（"假 null"）
4. **`Object.DestroyImmediate()`** 立即销毁原生对象并标记壳，但不触发 GC——在编辑器中慎用（会破坏序列化引用）
5. **性能陷阱**：重载的 `==` 比普通 C# 引用比较慢约 10-50 倍，在热路径循环中应避免频繁与 null 比较

### 📖 深度展开

#### 双对象模型架构

```
C# 托管堆 (Managed)                    C++ 原生堆 (Native)
┌──────────────────────┐               ┌──────────────────────┐
│  GameObject (wrapper) │ ──m_CachedPtr─→ │  GameObject (native)  │
│  - m_CachedPtr        │               │  - Transform          │
│  - instanceID         │               │  - Components[]       │
│  - fake_null flag     │               │  - Active state       │
└──────────────────────┘               └──────────────────────┘
     ↑ GC 管理                               ↑ Unity 引擎管理
```

**对比表：**

| 维度 | C# 壳对象 (Wrapper) | C++ 原生对象 (Native) |
|------|---------------------|----------------------|
| 存储位置 | 托管堆（GC 管理） | 原生堆（Unity 管理） |
| 创建方式 | `new GameObject()` 同时创建两者 | 引擎内部创建 |
| 销毁方式 | GC 自动回收 | `Object.Destroy()` |
| 销毁时机 | 不确定（GC 决定） | 当前帧末尾（Destroy）或立即（DestroyImmediate） |
| null 含义 | 引用为空 | 原生对象已被销毁 |

#### "假 null" 机制详解

```csharp
GameObject obj = new GameObject("Test");

// 场景：销毁对象
Object.Destroy(obj);

// ⚠️ 同一帧内（Destroy 是延迟的）
Debug.Log(obj == null);        // False！原生对象还没真正销毁（到帧末）

// 下一帧
yield return null; // 等一帧
Debug.Log(obj == null);        // True！原生对象已销毁，重载的 == 返回 true
Debug.Log(ReferenceEquals(obj, null)); // False！C# 引用仍然存在
```

**`==` 重载的内部逻辑（伪代码）：**

```csharp
// UnityEngine.Object 的 == 重载（简化版）
public static bool operator ==(Object x, Object y)
{
    // 1. 快速路径：引用完全相同
    if (ReferenceEquals(x, y)) return true;
    
    // 2. 检查双方的原生指针是否存活
    bool xAlive = x != null && x.m_CachedPtr != IntPtr.Zero && !x.IsNativeNull();
    bool yAlive = y != null && y.m_CachedPtr != IntPtr.Zero && !y.IsNativeNull();
    
    // 3. 如果都死了或都活着且引用相同 → 相等
    return !xAlive && !yAlive;
    // 注意：这里做了跨域调用检查，开销远大于普通引用比较
}
```

#### Destroy vs DestroyImmediate 对比

```csharp
// ✅ 运行时标准做法：延迟到帧末销毁
Object.Destroy(go);
// 本帧内 go 仍然可用（组件可访问）
// 下一帧开始时 go 真正被销毁

// ⚠️ 立即销毁（主要用于编辑器脚本）
Object.DestroyImmediate(go);
// 调用后 go 立即变为"假 null"
// 任何后续访问都会报 MissingReferenceException

// 编辑器中销毁资源（Asset）必须用 DestroyImmediate
#if UNITY_EDITOR
    DestroyImmediate(materialAsset, true); // allowDestroyingAssets = true
#endif
```

| 特性 | `Object.Destroy()` | `Object.DestroyImmediate()` |
|------|--------------------|-----------------------------|
| 销毁时机 | 当前帧结束后 | 立即 |
| 安全性 | 运行时安全 | 可能破坏内部引用链 |
| 适用场景 | 游戏运行时 | 编辑器脚本、测试 |
| 性能影响 | 可忽略（延迟批量处理） | 较高（同步操作） |
| 序列化影响 | 不影响 | 可能破坏 Prefab/序列化引用 |

#### 性能陷阱：热路径中的 null 检查

```csharp
// ❌ 慢：每帧每元素都做重载的 == 检查
void Update()
{
    for (int i = 0; i < items.Length; i++)
    {
        if (items[i] == null) continue; // 跨域调用，10-50x 开销
        items[i].DoSomething();
    }
}

// ✅ 快：使用自定义标记 + 普通引用比较
class ItemSlot
{
    public bool isAlive = true;      // 自管理标志位
    public MonoBehaviour component;  // 引用
}

void Update()
{
    for (int i = 0; i < slots.Length; i++)
    {
        if (!slots[i].isAlive) continue;  // 纯 C# 字段读取
        slots[i].component.DoSomething();
    }
}
```

**Benchmark 大致数据（万次循环）：**

| 比较方式 | 耗比（相对） | 说明 |
|----------|-------------|------|
| `obj == null`（UnityEngine.Object 重载） | 1x | 跨 C#/C++ 边界 |
| `ReferenceEquals(obj, null)` | ~0.02x | 纯 C# 引用比较 |
| `(object)obj == null` | ~0.02x | 绕过重载，同上 |
| 自管理 `bool flag` | ~0.01x | 最快 |

#### C# 9 pattern matching 的坑

```csharp
// C# 9+ 的 is not null pattern
if (obj is not null) { ... }

// ⚠️ 对于 UnityEngine.Object，这用的是 ReferenceEquals 语义！
// 不会检查原生对象是否存活，可能通过判断但实际对象已销毁
// 正确写法：
if (obj != null) { ... }  // 使用重载的 !=
// 或
if (obj is not null && obj) { ... } // 运算符重载版（implicit bool）
```

### ⚡ 实战经验

1. **缓存引用而非频繁 GetComponent**：UnityEngine.Object 的 null 检查比普通 C# 对象慢 10-50 倍，在万级循环中应使用对象池 + 自管理 flag，而非依赖 `== null`
2. **编辑器中清理临时对象用 `DestroyImmediate`**：运行时用 `DestroyImmediate` 会导致同一帧内的其他代码拿到"假 null"引用，产生难以排查的 MissingReferenceException
3. **`Object.Destroy` 后立即将引用置 null**：`Destroy(go); go = null;` 是好习惯，虽然 `go != null` 在当前帧仍然为 true，但至少下一帧不会误用已销毁对象
4. **使用 `is not null` pattern matching 要格外小心**：C# 9 的 `is not null` 走的是 `ReferenceEquals`，对 UnityEngine.Object 不安全——使用传统的 `!= null` 或显式 `is not null && this != null`

### 🔗 相关问题

- Unity 的 GC 和 C++ 原生对象回收之间的关系是什么？
- `Resources.UnloadUnusedAssets()` 何时调用？它的原理是什么？
- 如何在对象池中安全地"销毁"和"复活" GameObject？
