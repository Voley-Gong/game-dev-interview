---
title: "游戏客户端多线程架构怎么设计？Job System 和线程池如何选？"
category: "architecture"
level: 4
tags: ["多线程", "Job System", "并行", "线程池", "无锁编程", "架构设计"]
related: ["architecture/ecs-architecture", "architecture/async-programming-architecture", "architecture/object-pool"]
hint: "主线程不仅要跑逻辑、还要提交渲染命令、还要做 IO。核心思路是把'数据并行'的任务拆给 Worker，用 Job System 保证安全和缓存友好，主线程只留轻量同步点。"
---

## 参考答案

### ✅ 核心要点

1. **主线程是稀缺资源**：渲染提交、UI 事件、逻辑 Tick 必须在主线程，能搬走的大数据计算（AI 寻路、物理、粒子）才值得并行
2. **Job System ≠ 线程池**：线程池做任务并行（每个 Task 做不同的事），Job System 做数据并行（同一段逻辑切分后并行处理不同数据块），后者天然缓存友好
3. **安全的三件套**：只读共享（多 Job 并行读）、独占写入（`[WriteOnly]` 保证不冲突）、依赖链（`Dependency` 串行化有先后顺序的 Job）
4. **主线程必须有同步点（Fence）**：每帧在固定位置 `Complete()` 所有 Job，保证帧边界数据一致性，不能让 Job 跨帧
5. **避免锁竞争比避免锁更重要**：用 Double Buffer、Ring Buffer、无锁队列让读写分离，而非 `lock` 套 `lock`

### 📖 深度展开

**游戏客户端多线程架构总览：**

```
                    ┌─────────── 主线程 (Main Thread) ───────────┐
                    │  Input → Logic Tick → Render Submit → Present │
                    │         ↑ 同步点                ↑ 同步点      │
                    └─────────┬─────────────────────┬──────────────┘
                              │ 派发 Job            │ 回收结果
                    ┌─────────▼─────────────────────▼──────────────┐
                    │            Job Queue / 调度器                  │
                    ├────────┬────────┬────────┬────────┬───────────┤
                    │Worker 0│Worker 1│Worker 2│Worker 3│ ...N核     │
                    │寻路切片 │AI 决策  │物理积分  │粒子更新 │           │
                    └────────┴────────┴────────┴────────┴───────────┘
```

**Unity C# Job System + Burst 数据并行示例：**

```csharp
// 1. 定义 Job：一段纯数据逻辑，无托管对象引用
[BurstCompile]                        // Burst 编译为 SIMD 原生码
struct VelocityIntegrateJob : IJobParallelFor {
    public float DeltaTime;
    public NativeArray<float3> Positions;   // 连续内存，非托管
    [ReadOnly] public NativeArray<float3> Velocities;

    // execute(i) 只处理索引 i 的数据，天然无数据竞争
    public void Execute(int i) {
        Positions[i] += Velocities[i] * DeltaTime;
    }
}

// 2. 在 System / Update 中调度
public void OnUpdate() {
    var job = new VelocityIntegrateJob {
        DeltaTime  = Time.DeltaTime,
        Positions  = _positions,      // NativeArray，由调度器自动分块
        Velocities = _velocities,
    };
    // Schedule 自动按 Cache Line 切分，分给所有 Worker 并行执行
    JobHandle handle = job.Schedule(_positions.Length, 64);
    JobHandle.ScheduleBatchedJobs();  // 批量提交，减少调度开销
    handle.Complete();                // ← 帧同步点：主线程阻塞等全部完成
}
```

**任务并行（线程池）—— 适合 IO / 异构任务：**

```csharp
// 自定义工作线程 + 无锁任务队列（ stealing 调度）
public class WorkerThread {
    private readonly ConcurrentQueue<Action> _localQueue = new();
    private readonly WorkerThread[] _allWorkers;   // 用于 work-stealing

    public void Enqueue(Action task) => _localQueue.Enqueue(task);

    void Run() {
        while (_running) {
            if (_localQueue.TryDequeue(out var task))
                task();
            else
                StealFromOthers();  // 自己空闲就从别人的队列尾部偷任务
        }
    }
}

// 业务侧：把寻路请求扔给线程池，完成后回主线程
ThreadPool.QueueUserWorkItem(_ => {
    var path = NavMesh.CalculatePath(start, end);  // 耗时计算在工作线程
    _mainThreadQueue.Enqueue(() => OnPathReady(path));  // 结果回主线程消费
});
```

**三种并行模型对比：**

| 维度 | 线程池 (ThreadPool) | Job System (数据并行) | async/await (协程) |
|------|---------------------|----------------------|---------------------|
| 并行粒度 | 异构任务（不同逻辑） | 同构数据分块 | 单线程内异步等待 |
| 数据安全 | 靠锁/无锁队列，开发者全权负责 | 编译器级 Safety System 检查 | 无竞争（单线程） |
| 缓存友好性 | 差（各线程做不同事） | 好（连续内存 + SIMD） | 不适用 |
| 典型场景 | IO、寻路、文件读取 | 大量同类实体计算 | UI 动画、延迟回调 |
| 开销 | 线程切换 + 锁 | 极低（预分配 Worker） | 几乎为零 |
| 代表 | .NET ThreadPool | Unity C# Job System | C# async / Unity Coroutine |

**无锁设计模式——Double Buffer（双缓冲）消除读写竞争：**

```
帧 N：Worker 线程写 Buffer_A（AI 新状态）
      主线程同时读 Buffer_B（上一帧状态用于渲染）
              ↓ 帧边界交换指针（一次原子操作）
帧 N+1：Worker 写 Buffer_B，主线程读 Buffer_A
```

```csharp
// 双缓冲：读和写永远操作不同的数组，零锁竞争
public class DoubleBuffer<T> {
    private T[] _read, _write;
    public T[] Read => _read;
    public T[] Write => _write;
    public void Swap() => (_read, _write) = (_write, _read);
}
```

### ⚡ 实战经验

- **Job 的数据必须是非托管（unmanaged）的**：`NativeArray` / `struct` 可以，`List<T>` / `string` / 引用类型不行——编译器会直接报错，这是 Safety System 在保护你不写出幽灵 bug
- **警惕 False Sharing（伪共享）**：两个 Worker 各写相邻的 `float`，如果落在同一条 Cache Line（64B），会触发缓存行反复失效。解决：用 `[BurstCompile]` + 合理的 `innerLoopBatchCount`，或手动 padding
- **帧同步点是硬约束**：Job 如果跨帧 Complete，下一帧渲染就会读到半成品数据——必须在每帧的固定位置（如 `LateUpdate` 开头）统一 Complete
- **别拿多线程当万金油**：如果一段逻辑只有几百个对象，开 Job 的调度开销可能比串行还慢。Profile 显示是瓶颈再并行，而非"感觉很慢就开线程"

### 🔗 相关问题

1. ECS 架构为什么天然适合 Job System？Archetype Chunk 和 `IJobChunk` 是怎么配合的？
2. 游戏中的无锁队列怎么实现？`ConcurrentQueue` 和手写 Ring Buffer 各有什么取舍？
3. 如何设计一个 Work-Stealing 任务调度器来均衡各 Worker 负载？
