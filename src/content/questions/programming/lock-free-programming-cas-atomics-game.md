---
title: "无锁编程与CAS原子操作怎么做跨线程通信？音频线程/渲染线程为什么不能用互斥锁"
category: "programming"
level: 3
tags: ["多线程", "无锁编程", "原子操作", "CAS", "并发", "内存序"]
related: ["programming/web-worker-multithreading", "programming/ring-buffer-game", "programming/event-loop-task-scheduling"]
hint: "音频回调里加 mutex 直接爆音——实时线程不能等锁。无锁队列用 CAS 让生产消费零等待。"
---

## 参考答案

### ✅ 核心要点

1. **互斥锁在实时线程上是禁忌**：游戏音频回调（每 5ms 执行一次）、渲染线程（每 16.6ms 一帧）对时序极度敏感。`Mutex.lock()` 可能被操作系统挂起（上下文切换 10-50μs），音频回调一旦超时就爆音/卡顿。规则：**实时线程绝对不能阻塞**——不能加锁、不能 `malloc`、不能 IO、不能系统调用。跨线程通信必须用无锁（lock-free）结构。
2. **CAS 是无锁的基石**：Compare-And-Swap（CAS）是一条 CPU 原子指令——"比较内存值是否等于期望值，相等则写入新值，返回是否成功"。整个操作在硬件层面不可分割。JS 用 `Atomics.compareExchange(arr, index, expected, value)` 调用。所有无锁数据结构（队列、栈、计数器）都靠 CAS 实现"读-改-写"的无冲突更新。
3. **无锁环形队列是跨线程通信的标准方案**：主线程（生产者）往队列塞事件，音频/渲染线程（消费者）取出处理。用 `head` 和 `tail` 两个原子索引 + 定长环形缓冲区，生产者只写 `tail`、消费者只写 `head`，单生产者单消费者（SPSC）场景甚至不需要 CAS（纯原子读写即可），延迟稳定在纳秒级。
4. **ABA 问题是无锁的经典陷阱**：线程 A 读到值 X，准备 CAS 成 Y；线程 B 在此期间把 X 改成 Z 又改回 X；线程 A 的 CAS 依然成功（值"还是"X），但中间的 Z 变化被吞掉。解法是给值附带一个版本号（"代际索引" generational index），每次更新版本号+1，CAS 比较的是 (值, 版本) 二元组。无锁栈/队列必须处理 ABA。
5. **内存序决定可见性与性能**：CPU 乱序执行和缓存一致性让"代码顺序"≠"执行顺序"。`Atomics.load/store` 默认是顺序一致（Sequentially Consistent，最安全最慢）；`Acquire-Release` 语义（读用 acquire、写用 release）保证"release 之前的写对 acquire 之后可见"，性能更好且多数场景够用；`Relaxed` 只保证原子性不保证顺序，最快但只能用于计数器。选错内存序会导致隐蔽的并发 bug。
6. **无锁不是银弹**：① CAS 失败要重试（自旋），高竞争时 CPU 空转比加锁还慢；② 无锁代码极难调试（竞态条件无法稳定复现）；③ 内存回收是无锁最大的难题（消费者正在读的节点不能被生产者释放）。实战中 SPSC 无锁队列用得多，复杂的 MPMC（多生产者多消费者）场景往往还是用锁更可靠。

### 📖 深度展开

**1. SPSC 无锁环形队列：主线程 → 音频线程**

```typescript
// 单生产者单消费者无锁队列：主线程推事件，音频线程消费，零阻塞
class LockFreeSPSCQueue<T> {
  private buffer: T[];                 // 定长环形缓冲区
  private head = new Int32Array(1);    // 消费者读位置（仅消费者写）
  private tail = new Int32Array(1);    // 生产者写位置（仅生产者写）
  private mask: number;                // 容量掩码（容量必须是2的幂）

  constructor(capacity: number) {
    const cap = Math.pow(2, Math.ceil(Math.log2(capacity))); // 向上取整到2的幂
    this.buffer = new Array(cap);
    this.mask = cap - 1;               // 用位运算 & 代替 % 取模（更快）
  }

  // 生产者调用（主线程）：非阻塞，满则丢弃/返回false
  push(item: T): boolean {
    const t = Atomics.load(this.tail, 0);
    const next = (t + 1) & this.mask;
    if (next === Atomics.load(this.head, 0)) return false;  // 队列满
    this.buffer[t] = item;             // ★ 先写数据
    Atomics.store(this.tail, 0, next); // ★ 再发布tail（release语义保证顺序）
    return true;
  }

  // 消费者调用（音频线程）：非阻塞，空则返回null
  pop(): T | null {
    const h = Atomics.load(this.head, 0);
    if (h === Atomics.load(this.tail, 0)) return null;      // 队列空
    const item = this.buffer[h];       // ★ 先读数据
    Atomics.store(this.head, 0, (h + 1) & this.mask);       // ★ 再推进head
    return item;
  }
}
// 关键：push/pop 都不用 CAS（SPSC下 head/tail 各只有一个写者）
// 纯 Atomics.load/store 即可，延迟 < 100ns，音频线程零阻塞
```

**2. CAS 原子计数器：多线程统计在线人数**

```
❌ 非原子操作（竞态条件）：
  线程A: read count(=99) → +1 → write 100
  线程B: read count(=99) → +1 → write 100   ← 同时读99，覆盖丢失！
  结果：实际+2人，count只+1

✅ CAS 自旋重试（无锁原子更新）：
  do {
    old = Atomics.load(count, 0);        // 读当前值
    next = old + 1;                       // 计算新值
  } while (!Atomics.compareExchange(count, 0, old, next));
  //        ↑ CAS：如果 count 仍是 old，写入 next，返回 true
  //                如果被别的线程改了，返回 false，重试

✅ 更简单：Atomics.add(count, 0, 1)  ← 单条原子指令，无需自旋
```

```typescript
// MPMC 无锁栈：用 CAS 处理多生产者，必须带版本号防 ABA
class LockFreeStack<T> {
  private slots: { value: T; next: number; version: number }[];
  // head 打包 (索引, 版本) 到一个 64 位整数，CAS 一次比较两者
  private head = new BigInt64Array(1);  // 高32位=版本, 低32位=索引

  push(value: T): void {
    const newNode = this.allocSlot(value);
    let oldHead: bigint;
    do {
      oldHead = Atomics.load(this.head, 0);
      const oldIdx = Number(oldHead & 0xFFFFFFFFn);
      this.slots[newNode].next = oldIdx;
      const newHead = (BigInt(this.slots[newNode].version) << 32n) | BigInt(newNode);
      // CAS 比较整个 (索引,版本) 二元组，ABA 时版本号不同 → CAS 失败 → 重试
    } while (!Atomics.compareExchange(this.head, 0, oldHead, /*newHead*/ 0n));
  }
}
```

**3. 同步机制对比**

| 机制 | 阻塞？ | 公平性 | 实时安全 | 吞吐（低竞争） | 吞吐（高竞争） | 适用场景 |
|------|--------|--------|---------|--------------|--------------|---------|
| **Mutex（互斥锁）** | ✅ 阻塞 | 可配 | ❌ | 中 | 高（内核调度） | 通用临界区 |
| **Spinlock（自旋锁）** | 自旋 | 无 | ⚠️ | 高 | 极低（空转） | 极短临界区 |
| **CAS 无锁（SPSC队列）** | ❌ | — | ✅ | 极高 | 极高 | 实时线程通信 |
| **CAS 无锁（MPMC）** | ❌ | 无 | ✅ | 高 | 中（重试开销） | 多线程统计/池 |
| **Atomics.add/load** | ❌ | — | ✅ | 极高 | 高 | 原子计数器 |
| **SharedArrayBuffer** | ❌ | — | ✅ | 极高 | 高 | Worker 间共享内存 |

```
游戏线程架构中的无锁通信：
  ┌─────────────┐    SPSC无锁队列     ┌─────────────┐
  │  主线程     │ ────事件──────→   │  音频线程    │  ← 不能加锁！
  │  (16.6ms)   │                   │  (5ms回调)   │     加锁直接爆音
  └─────────────┘ ←──状态快照──────  └─────────────┘
         ↑    SPSC无锁队列                ↑
         │                               │
  ┌─────────────┐    SPSC无锁队列     ┌─────────────┐
  │  渲染线程   │ ←──渲染命令──────  │  逻辑线程    │
  │  (16.6ms)   │ ───帧完成信号──→  │  (固定步长)  │
  └─────────────┘                   └─────────────┘
```

### ⚡ 实战经验

- **音频回调里 malloc 导致周期性爆音**：音频回调每 5ms 执行一次，里面偷偷调了 `new Float32Array(512)` 做临时缓冲。大部分时候没事，但 GC 触发时回调延迟从 1ms 飙到 18ms，玩家听到周期性"咔哒"声。根因：GC 暂停世界。修复：回调里所有缓冲区预分配成成员变量，回调内零分配，爆音消失。
- **ABA 问题导致渲染命令丢失**：无锁渲染命令队列没加版本号，主线程 push 命令 A（槽位 #3）→ 渲染线程消费 → 主线程又 push 命令 B 复用槽位 #3 → CAS 误判"还是 #3"成功，命令 A 被覆盖。表现为画面偶发闪烁（1-2 帧错乱），QA 难复现。加 16 位版本号后彻底消失。
- **内存序选错引发幽灵 bug**：SPSC 队列的 `push` 用了 `Atomics.store(tail, next)`（默认 SeqCst，安全）后改成普通赋值 `tail = next`（非原子），立刻出现"数据写了但 tail 没更新"或"tail 更新了但数据还没写"的乱序，消费到未初始化数据。教训：跨线程共享变量必须用 Atomics，别图省事用普通赋值，内存序的代价远小于 debug 成本。
- **JS 单线程下 Atomics 仅 Worker 间有意义**：主线程内用 `Atomics.compareExchange` 操作普通数组毫无意义（单线程无竞态），反而比普通操作慢 5 倍。Atomics 必须配合 `SharedArrayBuffer` 用于 Worker 间共享内存。曾把单线程的事件计数器改成 Atomics"为将来多线程准备"，性能反而下降，纯属过度设计。
- **无锁 MPMC 队列在高竞争下不如锁**：8 个 Worker 同时 push 任务到无锁队列，CAS 冲突率 70%，大量自旋浪费 CPU（占用率从 200% 飙到 800% 但吞吐反而下降）。改成细粒度分片锁（每个 Worker 一个带锁子队列）后吞吐提升 3 倍。无锁适合低竞争/实时场景，高竞争下分片锁更优——别迷信"无锁一定快"。

### 🔗 相关问题

1. `SharedArrayBuffer` 在浏览器中默认被禁用（Spectre 漏洞），需要 `Cross-Origin-Opener-Policy` 和 `Cross-Origin-Embedder-Policy` 头才能启用。游戏 Web 端如何处理这个限制？是否只能退回 `postMessage` 拷贝通信？
2. C++ 的 `std::memory_order_relaxed/acquire/release/seq_cst` 四种内存序在具体硬件（x86 vs ARM）上的实际行为差异是什么？为什么 x86 天然是强序模型而 ARM 是弱序模型，这对移植游戏引擎有什么影响？
3. 无锁数据结构的内存回收是世界级难题（Hazard Pointer、Epoch-Based Reclamation、Quiescent-State）。JS/TS 有 GC 自动回收，是否意味着无锁结构在 JS 里不存在内存回收问题？什么场景下仍会内存泄漏？
