---
title: "C# 高性能编程：Unity 中如何使用 Span<T>、Memory<T> 和 stackalloc 减少 GC 压力？"
category: "unity"
level: 3
tags: ["C#", "性能优化", "GC", "Span", "内存管理"]
related: ["unity/gc-performance", "unity/dots-ecs"]
hint: "从 stackalloc 栈分配、Span 零拷贝切片、NativeArray 与 Burst 编译三个层面理解 Unity 中的高性能内存操作。"
---

## 参考答案

### ✅ 核心要点

1. **`stackalloc` 在栈上分配内存**，不受 GC 管理，方法返回时自动释放，适合小型临时缓冲区
2. **`Span<T>` 是连续内存区域的零拷贝视图**，可以包装数组、栈内存、NativeArray，进行切片操作时不产生新分配
3. **`Memory<T>` 是 Span 的堆可存储版本**，可以存入字段、跨 await 传递，适合异步场景
4. **Unity 中的 `NativeArray<T>` + Span 互操作**：NativeArray 可通过 `AsSpan()` 转为 Span，在 Burst 编译下获得接近 C++ 的性能
5. **核心原则：减少托管堆分配 → 减少 GC 触发 → 减少帧卡顿**

### 📖 深度展开

#### GC 压力的根源与 Span 的解决思路

```
传统 C# 数组操作（产生 GC）：

  int[] array = new int[1000];
  int[] slice = new int[100];      ← new 产生堆分配
  Array.Copy(array, 0, slice, 0, 100);
  // 使用 slice...
  // → slice 最终被 GC 回收（可能引发帧卡顿）

Span<T> 操作（零分配）：

  Span<int> arraySpan = array;
  Span<int> slice = arraySpan.Slice(0, 100);  ← 不分配，只是指针+offset
  // 使用 slice...
  // → 无堆分配，无 GC
```

#### stackalloc 详解

```csharp
using System;
using Unity.Collections;
using UnityEngine;

public class StackAllocDemo : MonoBehaviour
{
    // ❌ 传统写法：每次调用在堆上分配临时数组
    void ProcessDamageBad(int targetCount)
    {
        float[] damages = new float[targetCount]; // GC!
        for (int i = 0; i < targetCount; i++)
            damages[i] = CalculateDamage(i);
        ApplyDamage(damages);
        // damages 等待 GC 回收...
    }

    // ✅ stackalloc 写法：栈分配，方法结束自动释放
    unsafe void ProcessDamageGood(int targetCount)
    {
        // 栈上分配，无 GC 压力
        // 注意：targetCount 不宜过大（一般 < 1KB）
        Span<float> damages = stackalloc float[targetCount];

        for (int i = 0; i < targetCount; i++)
            damages[i] = CalculateDamage(i);

        ApplyDamageSpan(damages);
        // 方法返回时 damages 自动释放，零 GC 负担
    }

    float CalculateDamage(int index) => index * 10f;
    void ApplyDamageSpan(ReadOnlySpan<float> damages)
    {
        foreach (var d in damages)
            Debug.Log($"Damage: {d}");
    }
}
```

#### Span 的核心操作

```csharp
public class SpanOperations : MonoBehaviour
{
    void DemonstrateSpan()
    {
        // 1. 从数组创建 Span
        int[] data = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 };
        Span<int> fullSpan = data.AsSpan();

        // 2. 切片（零拷贝）
        Span<int> left = fullSpan.Slice(0, 5);     // [1,2,3,4,5]
        Span<int> right = fullSpan.Slice(5);        // [6,7,8,9,10]

        // 3. 修改 Span 会修改原数组（共享内存）
        left[0] = 100;  // data[0] 也变成 100

        // 4. Reverse / Fill / CopyTo
        left.Reverse();         // [5,4,3,2,100]
        right.Fill(0);          // [0,0,0,0,0]

        // 5. 与 string 互操作
        string text = "Player:100:85:200";
        ReadOnlySpan<char> textSpan = text.AsSpan();
        int firstColon = textSpan.IndexOf(':');
        ReadOnlySpan<char> name = textSpan.Slice(0, firstColon);
        // name.ToString() 才会产生分配，直接操作不会
    }

    // 在热路径中解析字符串，避免 Split 产生的 string[] 分配
    void ParseStatsEfficient(ReadOnlySpan<char> raw)
    {
        // "HP:100|MP:50|SPD:200"
        while (raw.Length > 0)
        {
            int bar = raw.IndexOf('|');
            ReadOnlySpan<char> segment = bar < 0
                ? raw
                : raw.Slice(0, bar);

            int colon = segment.IndexOf(':');
            var key = segment.Slice(0, colon);
            var value = segment.Slice(colon + 1);

            // 只在需要持久化时 ToString()
            if (key.SequenceEqual("HP".AsSpan()))
            {
                int hp = ParseIntFast(value);
                // ...
            }

            raw = bar < 0 ? ReadOnlySpan<char>.Empty : raw.Slice(bar + 1);
        }
    }

    int ParseIntFast(ReadOnlySpan<char> digits)
    {
        int result = 0;
        foreach (char c in digits)
            result = result * 10 + (c - '0');
        return result;
    }
}
```

#### NativeArray + Span + Burst（Unity 高性能组合）

```csharp
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;
using Unity.Mathematics;

[BurstCompile(CompileSynchronously = true)]
struct DamageJob : IJobParallelFor
{
    public NativeArray<float> damages;
    [ReadOnly] public NativeArray<float> baseValues;
    public float multiplier;

    public void Execute(int index)
    {
        damages[index] = baseValues[index] * multiplier;
    }
}

public class BurstSpanDemo : MonoBehaviour
{
    void Update()
    {
        int count = 1000;

        // NativeArray 在 C++ 堆分配，不受 C# GC 管理
        var baseValues = new NativeArray<float>(count, Allocator.TempJob);
        var damages = new NativeArray<float>(count, Allocator.TempJob);

        // 在主线程通过 Span 操作 NativeArray
        Span<float> baseSpan = baseValues.AsSpan();
        for (int i = 0; i < count; i++)
            baseSpan[i] = UnityEngine.Random.Range(10f, 50f);

        // 调度 Burst 编译的 Job
        var job = new DamageJob
        {
            baseValues = baseValues,
            damages = damages,
            multiplier = 1.5f
        };
        JobHandle handle = job.Schedule(count, 64);
        JobHandle.ScheduleBatchedJobs();

        // 在其他地方 Complete 并读取结果
        handle.Complete();

        Span<float> resultSpan = damages.AsSpan();
        float totalDamage = 0f;
        foreach (float d in resultSpan)
            totalDamage += d;

        Debug.Log($"Total Damage: {totalDamage}");

        baseValues.Dispose();
        damages.Dispose();
    }
}
```

#### 性能对比表

| 操作方式 | 分配位置 | GC 压力 | 速度（相对） | 适用场景 |
|---------|---------|--------|-------------|---------|
| `new int[N]` | 托管堆 | ⚠️ 高 | 1×（基准） | 普通业务逻辑 |
| `stackalloc` | 栈 | ✅ 无 | ~1.2× | 小型临时缓冲（< 1KB） |
| `NativeArray` (TempJob) | C++ 堆 | ✅ 无 | ~1.1× | Job System / Burst |
| `NativeArray` + Burst | C++ 堆 | ✅ 无 | ~5~20× | 大规模数值计算 |
| `new NativeList<T>` | C++ 堆 | ✅ 无 | ~1.1× | 大小未知的临时集合 |

#### Unity C# 8.0 可用性

```
Unity 2021.2+ → C# 9.0（部分支持）
Unity 2022.2+ → C# 9.0（完整）
Unity 6 (2023+) → C# 9.0

Span<T> 可用版本：
  ├── .NET Standard 2.1+（Unity 2021+ 默认）
  ├── 需要在 Player Settings 中启用 "Unsafe Code"
  └── stackalloc 需要在 .cs 文件中标记 unsafe 块
```

### ⚡ 实战经验

- **不要在 Update 里 `new` 数组**：这是最常见的隐形 GC 源，100 个敌人每帧各 new 一个 `float[4]` 就产生 400 字节的堆碎片，几分钟就能触发一次 GC 卡顿。用 `stackalloc` 或缓存为类成员
- **Span 不能存为字段**：`Span<T>` 是 ref-like type，不能作为 async 方法的局部变量也不能存字段。需要跨方法/异步传递时用 `Memory<T>`，使用时再 `.Span` 转回
- **NativeArray 必须 Dispose**：忘了 Dispose 会造成 C++ 堆内存泄漏，且 Unity 会在控制台报 leak warning。推荐用 `using` 模式：`using var arr = new NativeArray<float>(N, Allocator.TempJob);`
- **Span 的 IndexOf/SequenceEqual 比 string 操作快 3-5×**：在解析网络协议、处理 CSV 数据、解析配置表时，用 `ReadOnlySpan<char>` 替代 `string.Split` + `string.Equals` 组合，能显著降低帧内分配

### 🔗 相关问题

- Unity 的 GC 模式（Boehm vs SGC）对 Span 优化策略有什么影响？
- `ReadOnlySpan<T>` 和 `Span<T>` 的区别是什么？为什么只读场景必须用前者？
- 在 Burst 编译的 Job 中能否直接使用 C# 的 Span？有什么限制？
