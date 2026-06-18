---
title: "Unity Job System 与 Burst Compiler 如何提升性能？"
category: "unity"
level: 3
tags: ["性能优化", "多线程", "Job System", "Burst", "DOTS"]
related: ["unity/dots-ecs", "unity/gc-performance"]
hint: "想想 Unity 为什么不直接用 C# 的 Thread，而要设计一套 Job System？"
---

## 参考答案

### ✅ 核心要点

1. **Job System** 是 Unity 对多线程的封装，基于 **C# JobSystem + 内部线程池**，避免直接操作 `Thread` 的开销与风险
2. **Burst Compiler** 是基于 LLVM 的编译器，专为 Job 中的值类型代码生成高度优化的机器码（SIMD/向量化）
3. 两者配合可实现 **10-100x** 的计算性能提升，尤其适合密集数值计算（AI 寻路、粒子、碰撞检测）
4. **Safety System** 在编译期和运行时检查数据竞争（Race Condition），保证多线程安全
5. Job System 是 DOTS 架构的核心组成之一，与 ECS、Entities.ForEach 深度集成

### 📖 深度展开

#### Job System 架构

```
主线程 (Main Thread)
  ├── 创建 Job
  ├── Schedule() → 分发到 Job Queue
  └── Complete() → 等待完成，取回结果

Worker Threads (内部线程池)
  ├── Worker 0: 执行 Job A
  ├── Worker 1: 执行 Job B
  └── Worker N: 执行 Job C

Safety System (守卫)
  ├── 编译期: NativeContainer 的 ReadOnly/WriteOnly 检查
  ├── 运行时: JobHandle 依赖链验证
  └── 检测到竞争 → 抛 InvalidOperationException
```

#### 三种 Job 类型对比

| Job 类型 | 特点 | 适用场景 |
|----------|------|----------|
| `IJob` | 单个 Job，独立执行 | 一次性大批量计算 |
| `IJobParallelFor` | 并行遍历数组，多 Worker 分担 | 逐元素处理（粒子、顶点） |
| `IJobEntity` (ECS) | 与 Entities 集成，自动遍历组件 | ECS 架构下的批量处理 |
| `IJobChunk` (ECS) | 按 Chunk 遍历 Archetype | 精细控制 ECS 遍历 |

#### 代码示例：IJobParallelFor

```csharp
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;

[BurstCompile(CompileSynchronously = true, FloatMode = FloatMode.Fast, FloatPrecision = FloatPrecision.Standard)]
public struct VelocityUpdateJob : IJobParallelFor
{
    [ReadOnly] public NativeArray<float3> positions;
    [ReadOnly] public NativeArray<float3> velocities;
    public NativeArray<float3> newPositions;
    public float deltaTime;

    public void Execute(int index)
    {
        newPositions[index] = positions[index] + velocities[index] * deltaTime;
    }
}

public class JobExample : MonoBehaviour
{
    private NativeArray<float3> _positions;
    private NativeArray<float3> _velocities;
    private NativeArray<float3> _newPositions;

    void Update()
    {
        var job = new VelocityUpdateJob
        {
            positions = _positions,
            velocities = _velocities,
            newPositions = _newPositions,
            deltaTime = Time.deltaTime
        };

        // Schedule: 分发到工作线程，batchSize 控制每个 Worker 的工作粒度
        JobHandle handle = job.Schedule(_positions.Length, 64);

        // 其他逻辑...

        // Complete: 阻塞主线程直到 Job 完成
        handle.Complete();

        // 使用结果...
    }

    void OnDestroy()
    {
        // NativeArray 必须手动释放，否则内存泄漏
        _positions.Dispose();
        _velocities.Dispose();
        _newPositions.Dispose();
    }
}
```

#### Burst 编译优化原理

```
C# (IL) → Burst → LLVM IR → 优化 Pass → 目标平台机器码

关键优化：
├── SIMD 向量化（AVX2/NEON 自动利用）
├── 循环展开 (Loop Unrolling)
├── 指令重排 (Instruction Scheduling)
├── 分支消除 (Branch Elimination)
└── 数学函数内联 (math.sin → 直接指令)
```

#### Job 依赖链

```csharp
// Job B 依赖 Job A 的结果
JobHandle handleA = jobA.Schedule();
JobHandle handleB = jobB.Schedule(data.Length, 64, handleA); // 第三个参数是依赖
handleB.Complete();
```

```
Job A (计算位置)  →  Job B (计算碰撞)  →  Job C (更新速度)
     ↓                    ↓                    ↓
  Worker 1            Worker 2            Worker 3
                                           (等 B 完成才开始)
```

### ⚡ 实战经验

1. **NativeContainer 内存泄漏是头号陷阱**：`NativeArray`、`NativeList` 等不受 GC 管理，必须在 `OnDestroy` 或合适时机 `Dispose()`。建议用 `Dispose(JobHandle)` 延迟释放避免主线程卡顿
2. **batchSize 选择影响并行效率**：太小（如1）导致调度开销大，太大（如10000）导致负载不均。通常 32-128 是较好区间，需要 Profiler 实测
3. **Burst 不支持所有 C# 特性**：不能用引用类型（string、class）、虚方法调用、反射。写 Job 代码时要有"只做数值计算"的心态，复杂逻辑拆到 Job 外
4. **`[BurstCompile]` 加在 MonoBehaviour 上也有效**：Unity 2021+ 支持 Burst 编译标记的普通方法，不一定非要用 Job

### 🔗 相关问题

- ECS (Entity Component System) 架构是什么？与传统 MonoBehaviour 有何区别？
- C# 的 `async/await` 和 Job System 能否混用？如何协调异步逻辑与 Job 调度？
- Burst Compiler 不支持的 C# 特性有哪些？遇到不支持的功能如何替代？
