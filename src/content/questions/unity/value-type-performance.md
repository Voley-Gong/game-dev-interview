---
title: "C# 值类型性能优化：Unity 中如何正确使用 readonly struct、in 参数和 ref struct？"
category: "unity"
level: 3
tags: ["C#", "值类型", "性能优化", "GC"]
related: ["unity/span-memory-optimization", "unity/gc-performance"]
hint: "struct 装箱、拷贝开销、ref struct 限制——你在 Unity 中用对了吗？"
---

## 参考答案

### ✅ 核心要点

1. **struct 是值类型**，赋值和传参时会产生拷贝，大 struct 的拷贝开销不可忽略
2. **`readonly struct`** 告诉编译器该结构体不可变，避免防御性拷贝（defensive copy）
3. **`in` 参数** 按引用只读传递，避免拷贝，配合 `readonly struct` 使用效果最佳
4. **`ref struct`** 必须栈分配，不能装箱、不能作为类字段，是 `Span<T>` 的基础
5. 在 Unity 中，合理使用值类型可以显著减少 GC 压力和内存分配

### 📖 深度展开

#### 值类型的隐式开销

```csharp
// ❌ 看起来无害，但每次调用都拷贝整个 struct（16 bytes）
public struct Bounds
{
    public Vector3 center;  // 12 bytes
    public Vector3 size;    // 12 bytes
}

public bool Contains(Bounds bounds, Vector3 point)
{
    // bounds 是传入参数的副本
    return bounds.Contains(point);
}
```

#### readonly struct 解决防御性拷贝

```csharp
// ❌ 普通 struct 在 readonly 上下文中会产生防御性拷贝
public readonly struct BoundsReadOnly
{
    public readonly Vector3 center;
    public readonly Vector3 size;
    
    public BoundsReadOnly(Vector3 center, Vector3 size)
    {
        this.center = center;
        this.size = size;
    }
    
    // 在 readonly struct 中，方法自动隐含 readonly，无防御性拷贝
    public bool Contains(Vector3 point)
    {
        var min = center - size * 0.5f;
        var max = center + size * 0.5f;
        return point.x >= min.x && point.x <= max.x
            && point.y >= min.y && point.y <= max.y
            && point.z >= min.z && point.z <= max.z;
    }
}
```

#### in 参数：按引用只读传递

```csharp
// ✅ in 参数：传递引用而非拷贝，编译器保证不可修改
public bool Intersects(in BoundsReadOnly a, in BoundsReadOnly b)
{
    // 使用 in 传递，24 bytes 的 struct 不再被拷贝
    // ...
    return true;
}

// 调用时无需修改调用方式
var bounds1 = new BoundsReadOnly(Vector3.zero, Vector3.one);
var bounds2 = new BoundsReadOnly(Vector3.forward, Vector3.one);
Intersects(bounds1, bounds2); // 引用传递，零拷贝
```

#### ref struct：强制栈分配

```csharp
// ref struct 不能装箱、不能作为 class 字段、不能在 async 方法中使用
public ref struct TempArray<T>
{
    private Span<T> _data;
    
    public TempArray(Span<T> data) => _data = data;
    
    public ref T this[int index] => ref _data[index];
    public int Length => _data.Length;
}

// 在 Unity 组件中使用
public class MeshProcessor : MonoBehaviour
{
    private void ProcessMesh()
    {
        // ✅ 合法：ref struct 在栈上使用
        var vertices = mesh.vertices;
        var temp = new TempArray<Vector3>(vertices);
        
        for (int i = 0; i < temp.Length; i++)
        {
            temp[i] *= 2f; // 就地修改
        }
        mesh.vertices = vertices;
    }
    
    // ❌ 编译错误：ref struct 不能作为 class 的字段
    // private TempArray<Vector3> _temp; 
}
```

#### 对比总结

| 特性 | `struct` | `readonly struct` | `ref struct` |
|------|----------|--------------------|---------------|
| 可变性 | 可变 | 不可变 | 取决于字段 |
| 装箱 | 可以 | 可以 | ❌ 不可以 |
| 作为 class 字段 | ✅ | ✅ | ❌ |
| async/await 中使用 | ✅ | ✅ | ❌ |
| 防御性拷贝 | 可能产生 | 不产生 | N/A |
| 传递建议 | `ref` / `in` | `in`（最佳搭档） | 始终栈传递 |
| 典型用例 | 小型数据容器 | 数学类型、几何体 | Span、临时缓冲区 |

#### Unity 实战：批量物理检测优化

```csharp
// ❌ 每帧创建数组，产生 GC
void BadUpdate()
{
    var hits = Physics.SphereCastAll(transform.position, 5f, transform.forward);
    foreach (var hit in hits)
    {
        // 处理碰撞
    }
    // hits 数组在堆上分配，下次 GC 时回收
}

// ✅ 使用预分配的数组 + in 参数零分配
private static readonly RaycastHit[] HitBuffer = new RaycastHit[32];

void GoodUpdate()
{
    int count = Physics.SphereCastNonAlloc(
        transform.position, 5f, transform.forward, HitBuffer);
    
    for (int i = 0; i < count; i++)
    {
        ProcessHit(in HitBuffer[i]); // in 传递，避免 struct 拷贝
    }
}

// in 参数配合 readonly 使用
void ProcessHit(in RaycastHit hit)
{
    // 零拷贝访问碰撞信息
    var point = hit.point;
    var normal = hit.normal;
}
```

### ⚡ 实战经验

- **Unity 版本注意**：`readonly struct` 和 `in` 需要 C# 7.2+，Unity 2018.4+ 已支持；`ref struct` 同样可用
- **Burst Compiler 友好**：`readonly struct` 和 `in` 参数能让 Burst 生成更优的机器码，因为编译器能确定数据不会被修改
- **避免大 struct 装箱**：将 struct 传入 `object` 参数（如 `Debug.Log`、`string.Format`）会触发装箱分配，高频调用路径需注意
- **IL2CPP 下的表现**：IL2CPP 会为 `in` 参数生成引用传递的 C++ 代码，但对小 struct（≤ 8 bytes）可能反而直接拷贝更优，需要 Benchmark 区分

### 🔗 相关问题

- `Span<T>` 和 `Memory<T>` 有什么区别？各自适用什么场景？（→ Span/Memory 优化）
- Unity 中如何减少 GC.Alloc？常见的高频分配陷阱有哪些？（→ GC 性能优化）
- record struct 和 readonly struct 有什么区别？Unity 中应该用哪个？
