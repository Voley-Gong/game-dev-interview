---
title: "Unity NativeContainer（NativeArray/NativeHashMap/NativeList）的底层原理与使用场景？"
category: "unity"
level: 3
tags: ["NativeContainer", "Collections", "Job System", "内存安全"]
related: ["unity/job-system-burst", "unity/span-memory-optimization"]
hint: "为什么 NativeArray 比 List<T> 快？想想托管堆、GC、内存布局……"
---

## 参考答案

### ✅ 核心要点

1. **NativeContainer 是非托管内存的包装器**：数据存储在 C++ 堆上，不受 C# GC 管理，零 GC 开销
2. **核心类型**：`NativeArray<T>`（定长数组）、`NativeList<T>`（可变长）、`NativeHashMap<K,V>`、`NativeMultiHashMap<K,V>`、`NativeQueue<T>`
3. **与 Job System 配合**：NativeContainer 是 Job 之间共享数据的唯一安全方式
4. **Safety System**：Unity 通过 `DisposeSentinel` 和 `AtomicSafetyHandle` 实现内存安全检查，防止 Job 未完成时访问数据
5. **Allocator 类型**：`Allocator.Temp`（单帧）、`Allocator.TempJob`（Job 生命周期）、`Allocator.Persistent`（手动管理）

### 📖 深度展开

#### 内存布局对比

```
C# 托管堆 (managed heap)
┌────────────────────────┐
│ List<Vector3>           │
│  ├── _items: Vector3[]  │ ← 引用数组，GC 可移动
│  │   ┌───┬───┬───┐     │
│  │   │V3 │V3 │V3 │     │ ← 托管数组，可能被 GC 压缩/移动
│  │   └───┴───┴───┘     │
│  └── _size: int         │
└────────────────────────┘
  缺点：GC 压力、引用间接、内存不连续

NativeContainer (unmanaged heap)
┌────────────────────────┐
│ NativeArray<Vector3>    │
│  ┌───┬───┬───┬───┬───┐ │
│  │V3 │V3 │V3 │V3 │V3 │ │ ← 连续内存，无 GC
│  └───┴───┴───┴───┴───┘ │
│  ↑ 直接指针访问           │
└────────────────────────┘
  优点：零 GC、缓存友好、SIMD 友好
```

#### Allocator 生命周期

```csharp
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;

// Allocator.Temp: 最短生命周期，函数返回前必须释放
// 通常用于临时计算
using (var temp = new NativeArray<float>(1024, Allocator.Temp))
{
    // 使用 temp...
} // 自动 Dispose

// Allocator.TempJob: Job 生命周期
// 在 Job 完成后由 Safety System 检查
var jobData = new NativeArray<float>(1024, Allocator.TempJob);
var handle = new MyJob { Data = jobData }.Schedule();
jobData.Dispose(handle); // Job 完成后自动释放

// Allocator.Persistent: 持久化，类似 C 的 malloc
// 必须手动 Dispose，否则内存泄漏
var persistent = new NativeList<int>(256, Allocator.Persistent);
try
{
    // 跨多帧使用
}
finally
{
    persistent.Dispose();
}
```

#### NativeHashMap 并发安全模式

在 Job System 中，多个 Job 可以并行读写同一个 `NativeMultiHashMap`：

```csharp
// 并行写入：每个 Job 写不同 bucket
var hashMap = new NativeMultiHashMap<int, Entity>(1024, Allocator.TempJob);

var jobHandle = new PopulateHashJob
{
    HashMap = hashMap.AsParallelWriter() // ← 并行写入器
}.Schedule(entityCount, 64);

// 并行读取：foreach 同时读
var readJobHandle = new ReadHashJob
{
    HashMap = hashMap // 只读模式
}.ScheduleParallel(jobHandle, 64);

readJobHandle.Complete();
hashMap.Dispose();
```

**关键点**：`AsParallelWriter()` 返回一个线程安全的写入视图，但同一 key 的写入仍需注意冲突。

#### Safety System 工作原理

```
NativeContainer 创建时:
  1. 分配非托管内存 (UnsafeUtility.Malloc)
  2. 创建 AtomicSafetyHandle (引用计数 + 版本号)
  3. 创建 DisposeSentinel (GC 检查器)

Job.Schedule() 时:
  1. Safety System 锁定所有传入的 NativeContainer
  2. 版本号 +1，标记为 "Job 使用中"
  3. 主线程访问 → 抛 InvalidOperationException

Job.Complete() 时:
  1. 版本号恢复
  2. NativeContainer 解锁，主线程可访问

未 Dispose 时:
  DisposeSentinel 在 GC 时检测到
  → 报错: "A Native Collection has not been disposed"
```

#### 性能基准对比

```
场景: 对 100,000 个 Vector3 做排序

List<Vector3> (主线程):
  ├─ 分配: 0.8ms (GC alloc)
  ├─ 排序: 4.2ms
  └─ GC 回收: 1.5ms (触发 Minor GC)
  总计: ~6.5ms + GC 压力

NativeArray<Vector3> + IJobParallelFor + Burst:
  ├─ 分配: 0.01ms (无 GC)
  ├─ 排序: 0.3ms (Burst + SIMD + 多核)
  └─ 无 GC 回收
  总计: ~0.3ms (约 20 倍提升)
```

#### 自定义 NativeContainer

```csharp
// 简化版 NativeStack 实现
[NativeContainer]
public unsafe struct NativeStack<T> : IDisposable
    where T : unmanaged
{
    [NativeDisableUnsafePtrRestriction]
    private T* _buffer;
    private int _count;
    private int _capacity;

    private Allocator _allocator;

    public NativeStack(int capacity, Allocator allocator)
    {
        _buffer = (T*)UnsafeUtility.Malloc(
            sizeof(T) * capacity,
            UnsafeUtility.AlignOf<T>(),
            allocator);
        _capacity = capacity;
        _count = 0;
        _allocator = allocator;
    }

    public void Push(T item)
    {
        if (_count >= _capacity)
            throw new InvalidOperationException("Stack overflow");
        _buffer[_count++] = item;
    }

    public T Pop()
    {
        if (_count == 0)
            throw new InvalidOperationException("Stack empty");
        return _buffer[--_count];
    }

    public void Dispose()
    {
        if (_buffer != null)
        {
            UnsafeUtility.Free(_buffer, _allocator);
            _buffer = null;
        }
    }
}
```

### ⚡ 实战经验

- **泄漏排查利器**：`JobsDebugger.SetLeakDetectionMode(LeakDetectionMode.Enabled)` 可以精确定位未 Dispose 的 NativeContainer 创建栈
- **Allocator.Temp 的隐藏规则**：Temp 分配的内存属于 "frame allocator"，如果跨帧持有会导致数据被覆盖，看似不报错但数据已损坏
- **NativeList 的并行写入陷阱**：`NativeList.AsParallelWriter()` 要求每个 Job 写入索引不重叠，否则数据会被覆盖且无错误提示
- **不要忽视 `[NativeDisableUnsafePtrRestriction]`**：在自定义 NativeContainer 中可能需要此特性绕过 Safety System，但意味着你自己负责安全检查

### 🔗 相关问题

- Job System 的 Schedule 和 ScheduleParallel 有什么区别？什么时候用哪个？
- Burst Compiler 是如何做到接近 C++ 性能的？
- Span<T> 和 NativeArray<T> 有什么区别？各自适用什么场景？
