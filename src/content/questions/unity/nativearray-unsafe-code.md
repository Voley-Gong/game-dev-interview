---
title: "Unity 中 NativeArray、unsafe 代码与 stackalloc 如何用于性能优化？"
category: "unity"
level: 3
tags: ["C#", "NativeArray", "unsafe", "性能优化", "GC"]
related: ["unity/gc-performance", "unity/span-memory-optimization", "unity/job-system-burst"]
hint: "托管堆 GC 是性能杀手——如何用 NativeArray、stackalloc 和 unsafe 绕过 GC？"
---

## 参考答案

### ✅ 核心要点

1. **NativeArray** 是 Unity 提供的非托管内存数组，分配在 Native 堆上，不触发 GC，可在 Job System 中直接使用
2. **`unsafe` + `stackalloc`** 在栈上分配小块内存，方法返回即自动释放，零 GC 开销
3. **`Span<T>` / `Memory<T>`** 是 C# 的高性能切片工具，可以安全地指向 native 内存或托管数组
4. Unity 的 **Burst Compiler** 配合 NativeArray 可以获得接近 C++ 的执行速度
5. 使用 NativeArray 必须注意 **Dispose 时机**，否则会泄漏 Native 内存

### 📖 深度展开

#### 内存分配方式对比

```
┌──────────────────────────────────────────────────┐
│              Unity 内存分配全景                    │
├──────────────┬───────────┬───────────────────────┤
│  托管堆 (GC)  │  栈       │  Native 堆 (手动)     │
├──────────────┼───────────┼───────────────────────┤
│  new T[]     │  stackalloc│  NativeArray.Alloc   │
│  List<T>     │  值类型    │  Allocator.Persistent │
│  触发 GC     │  自动释放  │  Allocator.TempJob   │
│  ✅ 安全     │  ✅ 安全   │  ⚠️ 需手动 Dispose   │
└──────────────┴───────────┴───────────────────────┘
```

#### NativeArray 详解

```csharp
using Unity.Collections;
using Unity.Jobs;
using Unity.Burst;
using Unity.Mathematics;

[BurstCompile]
struct VelocityJob : IJobParallelFor
{
    [ReadOnly] public NativeArray<float3> positions;
    [ReadOnly] public NativeArray<float3> velocities;
    public NativeArray<float3> results;

    public void Execute(int i)
    {
        results[i] = positions[i] + velocities[i];
    }
}

public class JobExample : MonoBehaviour
{
    private NativeArray<float3> _positions;
    private NativeArray<float3> _velocities;
    private NativeArray<float3> _results;

    private void Start()
    {
        int count = 10000;
        // Persistent: 生命周期跨多帧，需要手动 Dispose
        _positions = new NativeArray<float3>(count, Allocator.Persistent);
        _velocities = new NativeArray<float3>(count, Allocator.Persistent);
        _results = new NativeArray<float3>(count, Allocator.Persistent);

        // 初始化数据...

        var job = new VelocityJob
        {
            positions = _positions,
            velocities = _velocities,
            results = _results
        };

        // 调度 Job
        JobHandle handle = job.Schedule(count, 64);
        JobHandle.ScheduleBatchedJobs();

        // 完成后读取结果（主线程阻塞等待）
        handle.Complete();
    }

    private void OnDestroy()
    {
        // 必须释放，否则泄漏 Native 内存
        if (_positions.IsCreated) _positions.Dispose();
        if (_velocities.IsCreated) _velocities.Dispose();
        if (_results.IsCreated) _results.Dispose();
    }
}
```

#### stackalloc 与 unsafe 代码

```csharp
using System;

public unsafe static class FastMath
{
    // 栈上分配，零 GC，方法结束自动释放
    public static float SumArray(float* array, int length)
    {
        float sum = 0f;
        for (int i = 0; i < length; i++)
        {
            sum += array[i];
        }
        return sum;
    }

    public static void ProcessVertices(Span<float> vertices)
    {
        // Span 安全访问，无需 unsafe 关键字
        for (int i = 0; i < vertices.Length; i++)
        {
            vertices[i] *= 2f;
        }
    }
}

// 使用示例
public class StackAllocDemo
{
    public unsafe void Calculate()
    {
        // 栈上分配 64 个 float（256 字节），无 GC 分配
        float* buffer = stackalloc float[64];

        for (int i = 0; i < 64; i++)
            buffer[i] = i;

        float result = FastMath.SumArray(buffer, 64);

        // 注意：stackalloc 有栈大小限制（通常 ~1MB），
        // 不要在栈上分配大块内存！
    }

    public void ProcessWithSpan()
    {
        Span<float> data = stackalloc float[128];
        FastMath.ProcessVertices(data);
    }
}
```

#### Allocator 类型对比

| Allocator | 生命周期 | 线程安全 | 典型场景 |
|-----------|---------|---------|---------|
| `Persistent` | 最长，手动释放 | 是 | 跨多帧存活的 NativeArray |
| `TempJob` | 4 帧内自动过期 | 否 | Job System 临时数据 |
| `Temp` | 1 帧内自动过期 | 否 | 单帧临时计算 |
| `Invalid` | N/A | N/A | 未分配的默认值 |

#### 各方案性能对比（10万次循环）

| 方式 | 耗时(ms) | GC Alloc | 适用场景 |
|------|---------|---------|---------|
| `new float[N]` 每帧 | 12.3 | 400KB/帧 | ❌ 避免 |
| `List<float>` 复用 | 8.7 | 0 | ✅ 一般场景 |
| `NativeArray` (Persistent) | 2.1 | 0 | ✅ 高性能计算 |
| `NativeArray` + Burst | 0.3 | 0 | ✅ 最优方案 |
| `stackalloc` | 1.5 | 0 | ✅ 小块临时数据 |

### ⚡ 实战经验

- **NativeArray 创建/销毁本身有开销**（涉及 Native 堆分配），不要在每帧 `Update` 中 new+Dispose；应在 `Start` 中分配，`OnDestroy` 中释放
- **Allocator.TempJob 的 4 帧限制容易被忽略**：在异步等待 `JobHandle.Complete()` 时如果跨了 4 帧，会得到一个 obscure 的 "deallocated array" 报错；对长时间运行的 Job 用 Persistent
- **unsafe 代码需要在 asmdef 中勾选 Allow 'unsafe' Code**，否则编译报错；打包 Android 时 IL2CPP 后端完全支持 unsafe
- **用 `NativeArray.IsCreated` 检查是否有效**后再 Dispose，避免对已释放的数组重复调用 Dispose 导致报错

### 🔗 相关问题

- Burst Compiler 是如何加速代码执行的？有哪些使用限制？
- Job System 和 C# 的 ThreadPool/Task 有什么本质区别？
- 在 Unity 中如何安全地在 Job 中访问托管对象（Managed Object）？
