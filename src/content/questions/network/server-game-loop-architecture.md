---
title: "游戏服务器主循环（Server Game Loop）如何设计？Tick 调度与多线程模型详解"
category: "network"
level: 3
tags: ["服务器架构", "Game Loop", "Tick调度", "多线程", "固定时间步"]
related: ["network/tick-rate-vs-network-rate", "network/protocol-layer-architecture", "network/snapshot-delta-sync"]
hint: "游戏服务器每帧要处理输入、模拟物理、广播快照——这个循环怎么组织？多线程下如何避免数据竞争？"
---

## 参考答案

### ✅ 核心要点

1. **固定时间步（Fixed Timestep）**：服务器以固定频率（如 20Hz/30Hz）推进模拟，保证所有客户端看到一致的逻辑结果，是帧同步和状态同步的共同基础
2. **Tick 三阶段结构**：每帧分为 Input Sampling（收集输入）→ Simulation（逻辑模拟）→ Broadcast（发送快照），阶段之间通过双缓冲隔离读写
3. **网络与逻辑分离**：网络 I/O 线程只负责收发原始数据包，逻辑线程在 Tick 中统一处理——避免锁竞争和时序混乱
4. **快照广播是最大瓶颈**：每 Tick 需要为每个客户端构建并序列化快照，AOI 过滤 + Delta 压缩 + 批量发送是三大利器
5. **Reactor 模式 + 逻辑线程池**：主流 MMO 架构使用 I/O 多路复用（epoll/kqueue）收包，投递到逻辑线程队列，逻辑线程按 Tick 节奏消费

### 📖 深度展开

#### 单线程 Tick 架构（适合 FPS/MOBA，≤100 人）

```
┌─────────────── 单线程 Game Loop ───────────────┐
│                                                │
│  while (running) {                             │
│    ┌────────────────────────────────────┐      │
│    │ 1. NetPoll (epoll, 最多阻塞 frameTime)  │      │
│    │    → 收集所有客户端输入到 InputQueue     │      │
│    └────────────────────────────────────┘      │
│    ┌────────────────────────────────────┐      │
│    │ 2. ProcessInputs                    │      │
│    │    → 按序列号排序，应用到各实体        │      │
│    └────────────────────────────────────┘      │
│    ┌────────────────────────────────────┐      │
│    │ 3. Simulate (物理/AI/技能/碰撞)      │      │
│    │    → 固定时间步推进                   │      │
│    └────────────────────────────────────┘      │
│    ┌────────────────────────────────────┐      │
│    │ 4. BuildSnapshots                   │      │
│    │    → AOI过滤 + Delta + 序列化         │      │
│    └────────────────────────────────────┘      │
│    ┌────────────────────────────────────┐      │
│    │ 5. Broadcast                        │      │
│    │    → 发送快照到各客户端               │      │
│    └────────────────────────────────────┘      │
│    ┌────────────────────────────────────┐      │
│    │ 6. Sleep (剩余时间)                  │      │
│    │    → 保证固定 Tick 间隔              │      │
│    └────────────────────────────────────┘      │
│  }                                             │
└────────────────────────────────────────────────┘
```

```csharp
public class GameServer
{
    private const float TICK_RATE = 30f;          // 30 Hz
    private const float TICK_DELTA = 1f / TICK_RATE; // 33.3ms
    private const float MAX_FRAME_TIME = 0.1f;    // 最大帧时间（防螺旋死亡）

    private bool _running = true;
    private double _accumulator = 0;
    private double _lastTime = 0;

    public void Run()
    {
        _lastTime = GetTimeSeconds();

        while (_running)
        {
            double now = GetTimeSeconds();
            double frameTime = now - _lastTime;
            _lastTime = now;

            // 防止螺旋死亡（如果某帧卡了很久，不要试图追回所有时间）
            if (frameTime > MAX_FRAME_TIME)
                frameTime = MAX_FRAME_TIME;

            _accumulator += frameTime;

            // 固定时间步：可能执行多次 Tick（追上逻辑时间）
            while (_accumulator >= TICK_DELTA)
            {
                Tick();
                _accumulator -= TICK_DELTA;
            }

            // 如果还有剩余时间，睡眠到下一个 Tick
            double sleepTime = TICK_DELTA - _accumulator;
            if (sleepTime > 0.001)
                Thread.Sleep((int)(sleepTime * 1000));
        }
    }

    private void Tick()
    {
        // 阶段1：收集输入
        var inputs = _netLayer.CollectInputs();

        // 阶段2：应用输入
        foreach (var input in inputs)
            _world.ApplyInput(input);

        // 阶段3：模拟（固定步）
        _world.Simulate(TICK_DELTA);

        // 阶段4：构建快照
        var snapshots = _replicationLayer.BuildSnapshots();

        // 阶段5：广播
        _netLayer.Broadcast(snapshots);
    }
}
```

#### 多线程 Reactor 架构（适合 MMO，1000+ 人）

```
┌──────────────────────────────────────────────────────┐
│                    游戏服务器架构                       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ I/O 线程1  │  │ I/O 线程2  │  │ I/O 线程N  │          │
│  │ epoll #1  │  │ epoll #2  │  │ epoll #N  │          │
│  │ 收发原始包  │  │ 收发原始包  │  │ 收发原始包  │          │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘          │
│        │              │              │                │
│        ▼              ▼              ▼                │
│  ┌─────────────────────────────────────────┐         │
│  │        Input Queue（无锁队列）            │         │
│    │                │         │
│  └─────────┬────────────────┴────────────────┘         │
│            │                                          │
│            ▼                                          │
│  ┌─────────────────────────────────────────┐         │
│  │         Logic Thread（单线程）            │         │
│  │                                         │         │
│  │  while True:                            │         │
│  │    Tick:                                │         │
│  │      1. Drain InputQueue               │         │
│  │      2. Simulate                       │         │
│  │      3. BuildSnapshots                 │         │
│  │      4. Push to OutputQueue             │         │
│  │      5. Sleep until next tick           │         │
│  │                                         │         │
│  └─────────────────────┬───────────────────┘         │
│                        │                              │
│                        ▼                              │
│  ┌─────────────────────────────────────────┐         │
│  │       Output Queue（无锁队列）            │         │
│  └─────┬──────────────┬─────────────────────┘         │
│        ▼              ▼              ▼                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ I/O 线程1  │  │ I/O 线程2  │  │ I/O 线程N  │          │
│  │ 发送快照    │  │ 发送快照    │  │ 发送快照    │          │
│  └──────────┘  └──────────┘  └──────────┘           │
└──────────────────────────────────────────────────────┘
```

```csharp
// 无锁队列实现要点（简化版）
public class LockFreeQueue<T> where T : class
{
    private Node<T> _head;
    private Node<T> _tail;

    public LockFreeQueue()
    {
        _head = _tail = new Node<T>(default);
    }

    public void Enqueue(T item)
    {
        var node = new Node<T>(item);
        while (true)
        {
            Node<T> tail = _tail;
            Node<T> next = tail.Next;
            if (tail == _tail)
            {
                if (next == null)
                {
                    if (Interlocked.CompareExchange(
                        ref tail.Next, node, next) == next)
                    {
                        Interlocked.CompareExchange(ref _tail, node, tail);
                        return;
                    }
                }
                else
                {
                    Interlocked.CompareExchange(ref _tail, next, tail);
                }
            }
        }
    }

    public bool TryDequeue(out T item)
    {
        item = default;
        while (true)
        {
            Node<T> head = _head;
            Node<T> tail = _tail;
            Node<T> next = head.Next;
            if (head == _head)
            {
                if (head == tail)
                {
                    if (next == null) return false; // 空
                    Interlocked.CompareExchange(ref _tail, next, tail);
                }
                else
                {
                    item = next.Value;
                    if (Interlocked.CompareExchange(
                        ref _head, next, head) == head)
                        return true;
                }
            }
        }
    }
}
```

#### Tick 调度策略对比

| 策略 | 描述 | 适用场景 | 代表 |
|------|------|---------|------|
| **固定 30Hz** | 每帧 33.3ms，简单一致 | FPS/MOBA | CS2、LoL |
| **固定 20Hz** | 每帧 50ms，降低服务器压力 | 大厅/社交 | MMORPG 社交区 |
| **可变 Tick** | 关键实体 30Hz，远处 10Hz | MMO 大地图 | WoW（动态更新频率） |
| **Tick + 子步** | 逻辑 20Hz，物理子步 60Hz | 高精度物理 | 赛车、格斗 |

#### 定时器管理：Token Bucket vs Time Wheel

```csharp
// 时间轮（Timing Wheel）——适合大量定时器
public class TimingWheel
{
    private const int WHEEL_SIZE = 256;
    private const long TICK_MS = 50; // 每格50ms
    private LinkedList<TimerCallback>[] _slots;
    private int _currentIndex = 0;

    public TimingWheel()
    {
        _slots = new LinkedList<TimerCallback>[WHEEL_SIZE];
        for (int i = 0; i < WHEEL_SIZE; i++)
            _slots[i] = new LinkedList<TimerCallback>();
    }

    public void AddTimer(long delayMs, TimerCallback callback)
    {
        int ticks = (int)(delayMs / TICK_MS);
        int slot = (_currentIndex + ticks) % WHEEL_SIZE;
        _slots[slot].AddLast(callback);
    }

    public void Tick()
    {
        _currentIndex = (_currentIndex + 1) % WHEEL_SIZE;
        var callbacks = _slots[_currentIndex];
        foreach (var cb in callbacks)
            cb();
        callbacks.Clear();
    }
}
```

### ⚡ 实战经验

1. **螺旋死亡（Spiral of Death）**：当服务器负载过高导致帧时间超过 Tick 间隔时，accumulator 不断累积，Tick 连续执行不睡眠，负载进一步恶化。必须设 `MAX_FRAME_TIME` 截断，宁可丢几帧逻辑也不要陷入死循环
2. **Logic Thread 必须是单线程**：即使整体是多线程架构，逻辑模拟（技能、移动、碰撞）必须在同一线程上串行执行。多线程并行模拟世界状态几乎不可能做对（数据依赖太复杂）。I/O 并行 + 逻辑串行是黄金法则
3. **Tick 粒度的 RPC 处理**：客户端发来的 RPC（如使用道具、交易请求）不要在收到时立即处理，应放入队列，在 Tick 的 ProcessInputs 阶段统一处理。这样保证操作的时序一致性
4. **快照构建是优化重点**：Profile 数据通常显示，Tick 中 40-60% 的时间花在 BuildSnapshots（序列化 + Delta + AOI）。优化方向：脏标记（Dirty Flag）、增量 Delta、可见性过滤、SIMD 序列化

### 🔗 相关问题

- 服务器的 Tick Rate 和客户端的网络更新频率如何配合？
- 如何在多区域（Zone）服务器之间做跨区消息传递？
- 帧同步服务器的 Game Loop 和状态同步服务器有什么不同？
