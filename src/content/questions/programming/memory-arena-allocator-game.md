---
title: "游戏中的自定义内存分配器（Arena/Stack/Pool/Region）怎么设计？为什么 malloc 是热路径杀手？"
category: "programming"
level: 3
tags: ["内存管理", "内存分配器", "Arena", "性能优化", "内存碎片"]
related: ["programming/object-pool-game", "programming/memory-gc-optimization", "programming/data-oriented-design-soa"]
hint: "不是 malloc 本身慢——是频繁 malloc/free 的系统调用开销和堆碎片化在每帧上万次分配时致命。Arena 一次申请大块、bump 分配 O(1)、批量释放。"
---

## 参考答案

游戏引擎是"内存分配密集型"应用：每帧渲染、物理、AI、特效都在反复创建销毁临时对象。把这种高频分配交给通用的 `malloc`/`free`，会引入系统调用开销、堆碎片化和不可预测的延迟尖刺。自定义内存分配器的核心目标就是**把分配从"全局共享堆"局部化到"专用连续块"**，用牺牲灵活性（生命周期受限、块大小受限）换取确定性性能。下面从 malloc 的开销分析入手，逐层拆解 Arena、Stack、Pool、Region 四种主流设计。

### ✅ 核心要点

1. **malloc/free 的三重开销**：① 系统调用开销（brk/mmap 用户态↔内核态切换约 1-10μs）；② 每块 16-32 字节 heap header 元数据；③ 外部碎片化（总内存够但无连续大块→分配失败）。游戏每帧上万次分配时，三者叠加成为瓶颈，实测 malloc 占帧时间 20-40%。这不是单次 malloc 慢，而是高频调用放大了系统调用与锁竞争成本。
2. **Arena Allocator（区域分配器）**：预先申请一大块连续内存，内部用 bump pointer 线性推进分配 O(1)，不逐个 free 而是整块重置。适合"生命周期一致"的批量对象——一关的所有特效、一帧的临时字符串、一次战斗的所有伤害事件。零碎片、零元数据开销，且分配路径无分支判断，对 CPU 分支预测友好。
3. **Stack/Linear Allocator（栈式分配器）**：Arena 的增强版，支持 LIFO 释放（push marker / pop to marker）。帧开始时 push 一个 marker，帧中任意分配，帧末 pop 到 marker 一键回收。是"帧级临时内存"（Frame Allocator / Scratch Pad）的标准实现，让一帧内的临时对象像栈变量一样自动回收。
4. **Pool Allocator（池分配器）**：固定大小内存块 + 自由链表（free list）。分配/释放均 O(1)，零外部碎片（每块等大）。是对象池的底层实现，适合子弹、粒子、场景节点等同类型大量对象。块大小固定意味着无法处理变长请求，但换来的是可预测的内存布局与缓存友好的访问模式。
5. **Region/Scope-based Allocation（作用域分配）**：内存绑定到逻辑作用域（关卡 region、战斗 session、UI 面板），作用域结束时统一释放所有分配。RAII 式自动管理——开发者只需在作用域开始时拿一个 arena 句柄，结束自动回收，不用记住每个 free。这把"内存泄漏"从单点问题降级为"作用域划分是否合理"的结构问题。
6. **内存对齐（alignment）是分配器的硬性要求**：SIMD 指令（SSE/AVX/NEON）要求数据 16/32/64 字节对齐，未对齐访问轻则性能减半（跨缓存行）、重则直接 bus error crash。bump pointer 分配时必须按 alignment 向上 padding，池分配器块大小要 rounding up 到 alignment 的倍数。对齐还要考虑 false sharing：多线程场景下 64 字节对齐可避免缓存行乒乓。

### 📖 深度展开

#### 1. 四种分配器的 TypeScript 实现

下面用 TypeScript 模拟 C++ 内存分配器的核心逻辑。真实引擎中这些是裸指针操作，这里用 ArrayBuffer offset 模拟指针语义：

```typescript
// Arena: bump pointer 线性分配，整块重置
class ArenaAllocator {
  private buffer: ArrayBuffer;
  private view: Uint8Array;
  private offset = 0;  // bump pointer
  constructor(size: number) {
    this.buffer = new ArrayBuffer(size);
    this.view = new Uint8Array(this.buffer);
  }
  alloc(size: number, align = 8): number {  // 返回 offset（模拟指针）
    const aligned = Math.ceil(this.offset / align) * align;  // 对齐 padding
    if (aligned + size > this.buffer.byteLength) throw new Error("Arena overflow");
    this.offset = aligned + size;
    return aligned;
  }
  reset(): void { this.offset = 0; }  // ★ 整块"释放"——O(1)，不逐个 free
  get used(): number { return this.offset; }
}

// Stack Allocator: 支持 push/pop marker
class StackAllocator extends ArenaAllocator {
  private marks: number[] = [];
  pushMark(): number { const m = this["offset"]; this.marks.push(m); return m; }
  popMark(): void { this["offset"] = this.marks.pop()!; }  // 回收到 marker
}

// Pool Allocator: 固定块 + free list
class PoolAllocator {
  private buffer: ArrayBuffer;
  private blockSize: number;
  private freeList: number[] = [];  // 空闲块的 offset 栈
  constructor(blockSize: number, count: number, align = 8) {
    this.blockSize = Math.ceil(blockSize / align) * align;
    this.buffer = new ArrayBuffer(this.blockSize * count);
    for (let i = 0; i < count; i++) this.freeList.push(i * this.blockSize);  // 初始全空闲
  }
  alloc(): number { return this.freeList.pop()!; }  // O(1)
  free(offset: number): void { this.freeList.push(offset); }  // O(1)
}
```

注意 Arena 的 `alloc` 中没有 free 操作——释放只能通过 `reset()` 整块回收，这是它 O(1) 分配的根本原因。Pool 的 `freeList` 用栈实现，保证刚释放的块优先被复用（时间局部性好，缓存命中率高）。

四种分配器对比表：

| 分配器 | 分配复杂度 | 释放方式 | 碎片 | 块大小 | 典型游戏场景 |
|--------|-----------|---------|------|--------|-------------|
| Arena | O(1) | 整块 reset | 零 | 变长 | 关卡特效、战斗事件批量对象 |
| Stack | O(1) | LIFO pop 到 marker | 零 | 变长 | 帧级临时内存、函数作用域 |
| Pool | O(1) | 单块 free list | 零（内部碎片可接受） | 固定 | 子弹、粒子、节点对象池 |
| malloc | O(n) 最坏 | 逐块 free | 严重外部碎片 | 任意 | 不应出现在热路径 |

#### 2. 帧级临时内存（Frame Allocator）—— 消灭 GC 的利器

Frame Allocator 是引擎中最实用的分配器形态。它的核心思想是：所有"只活一帧"的临时数据（字符串拼接、临时数组、日志）统一从一个 bump arena 分配，帧末 reset，无需任何 free 或 GC 参与。

```
双缓冲 Frame Allocator（消除帧间数据依赖）：
  ┌───────── Frame N (正在使用) ─────────┐  ┌───── Frame N-1 (可读取) ─────┐
  │ offset →▓▓▓▓▓░░░░░░░░░░░░░░░░░░░    │  │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░    │
  │  ↑ 本帧新分配的区域（bump forward）   │  │  ↑ 上一帧的数据仍可安全读取    │
  │  帧末 reset() → offset 归零           │  │    （渲染线程可能还在用）       │
  └──────────────────────────────────────┘  └──────────────────────────────┘
                    ↓ 帧切换时 swap 两个 buffer ↓

  典型用法：伤害飘字字符串拼接、临时数学向量、日志格式化
  每帧分配数千次但 ZERO malloc / ZERO GC，因为只是 bump pointer 前进
```

```typescript
class DoubleBufferedFrameArena {
  private buffers: [ArenaAllocator, ArenaAllocator];
  private index = 0;  // 当前写入 buffer 下标
  constructor(size: number) {
    this.buffers = [new ArenaAllocator(size), new ArenaAllocator(size)];
  }
  // 本帧写入 buffer（主线程逻辑用）
  getWriteBuffer(): ArenaAllocator { return this.buffers[this.index]; }
  // 上一帧读取 buffer（渲染线程可能仍在读）
  getReadBuffer(): ArenaAllocator { return this.buffers[1 - this.index]; }
  // 帧末调用：先确保读 buffer 已被渲染消费完，再 swap
  swap(): void {
    this.getReadBuffer().reset();    // 清空上一帧（此时确认已无人读）
    this.index = 1 - this.index;     // 切换写指针
  }
}
```

双缓冲的关键是**读写分离**：逻辑线程写 N，渲染线程读 N-1，帧末同步后 swap，避免一帧内读写竞争同一块内存。单缓冲版本在单线程场景下也有效——只要所有临时数据在帧内用完即弃，帧末 reset 即可。GC 语言（JS/C#）用 Frame Allocator 的额外收益是消除 GC 压力：临时对象不再进堆，minor GC 频率大幅下降。

#### 3. 碎片化分析——为什么 malloc 最终会"内存够但分配失败"

外部碎片是 malloc 的致命伤：长期分配释放后，空闲内存被切割成大量不连续的小块，总空闲量足够却无法满足一次较大的连续请求。这在长时间运行的服务型游戏（MMO、抽卡）中尤其严重。

```
堆内存碎片化演进（8MB 堆，已用 4MB 但无法分配 2MB 连续块）：

  初始：[▓▓▓▓▓▓▓▓░░░░░░░░]  8MB 空闲连续
  分配释放若干次后：
        [▓░▓▓░▓░░▓░▓░▓░░▓░]  8MB 中 4MB 空闲，但最大连续空闲块只有 512KB！
        ↑ 空闲块被已分配块切割，无法满足 2MB 连续请求 → OOM

  Arena/Pool 的解法：
    Arena: 永不碎片化（bump 线性推进，reset 归零，无中间空洞）
    Pool:  永不碎片化（等大块，free 回到 free list，无切割）
    Stack:  理论无碎片（LIFO 释放保证无空洞），但乱序 free 会破坏
```

关键洞察：Arena/Pool 从设计上根除了外部碎片——Arena 不切割内存（线性推进），Pool 每块等大（不产生空洞）。这是它们相对 malloc 的结构性优势，而非仅仅是"更快"。

碎片化后果对比表：

| 分配器 | 外部碎片 | 内部碎片(padding) | 碎片化趋势 | 碎片导致的后果 |
|--------|---------|------------------|-----------|---------------|
| malloc/free | 严重 | 无 | 随运行时间恶化 | 长时间运行后 OOM、分配延迟尖刺 |
| Arena | 无 | 对齐 padding（小） | 恒定 | 仅需预分配足够容量，reset 后干净 |
| Stack | 无 | 对齐 padding（小） | 恒定 | 乱序 pop 会破坏 LIFO 假设 |
| Pool | 无 | 块内 padding（固定） | 恒定 | 大小不匹配导致内部碎片浪费 |

注意 malloc 的外部碎片是"随时间恶化"的——这就是为什么很多游戏跑几个小时后开始卡顿，重启就流畅。Arena 方案的代价是内存利用率不是 100%（reset 后整块空闲但未归还 OS），但在固定内存预算的客户端游戏里这是可接受的取舍。

> **设计哲学小结**：自定义分配器本质上是"用结构换取确定性"——Arena 用"固定生命周期"换"零碎片 O(1) 分配"，Pool 用"固定块大小"换"零外部碎片"，Stack 用"LIFO 约束"换"作用域自动回收"。选择哪种取决于对象的**生命周期模式**：同生共死选 Arena，逐个回收选 Pool，函数作用域选 Stack。没有万能分配器，引擎通常组合使用（Frame Arena + 多档 Pool + 关卡 Arena），各司其职。

### ⚡ 实战经验

以下五条均来自真实项目踩坑，数据为复现时的典型值（不同机型/引擎会有差异），核心目的是说明"分配器选错/用错的代价有多大"：

1. **伤害飘字字符串拼接的 malloc 风暴**：每帧约 3000 次伤害飘字，每次用 `+` 拼接格式化字符串（"暴击 12345"），触发 V8 频繁分配短生命周期字符串。Chrome DevTools Memory 显示每秒 18 万次分配，minor GC 每 3 帧触发一次，帧时间 P99 从 6ms 飙到 14ms。改用 256KB Frame Arena 预分配 + 手动写入 Uint8Array（模拟 bump allocate），分配次数降到 0，帧时间稳定 5ms。
2. **关卡切换释放卡顿**：旧关卡有 3000+ 游戏对象，逐个 `delete` 触发 3000 次 free，释放耗时 42ms（可感知卡顿，玩家看到"冻结"一帧）。改用 Arena 统一管理整关内存，关卡切换时一次 `arena.reset()`，释放耗时降到 0.1ms。代价：所有关卡内对象必须从 arena 分配（需要统一分配接口）。
3. **SIMD 对齐缺失导致 ARM crash**：矩阵批量运算用 NEON 指令，分配器没加对齐，某些骁龙设备上 `vld1q_f32` 读到未 16 字节对齐的地址直接 SIGBUS crash。给 ArenaAllocator.alloc() 加 `align=16` 参数后修复。iOS/A7 以上不 crash 是因为 Apple 的 malloc 默认 16 字节对齐，安卓各厂商不一致——这种平台差异在 QA 阶段极难复现，只在真机灰度才暴露。
4. **Pool Allocator 大小分槽**：一个通用 Pool 块大小 64B，但游戏中有 128B 的对象也有 32B 的对象。128B 对象无法放入 64B 池（分配失败），32B 对象放入 64B 池浪费 50%（内部碎片）。解法：分槽位 Pool（32B/64B/128B/256B 四档），按请求大小 round-up 到最近的槽位。实测内存利用率从 45% 提升到 89%。
5. **JS/TS 中 Arena 的 ArrayBuffer transfer 陷阱**：用 ArrayBuffer + DataView 模拟 arena，把 arena 传给 Web Worker 时用 `postMessage(buf, [buf])`（transfer 语义），结果主线程的 arena 被"掏空"（detached），后续分配全报 TypeError。解法：要么用 structuredClone（拷贝，但大数据慢），要么用双 arena 交替（主线程一个、Worker 一个，不 transfer）。这个坑在分帧渲染架构中很常见。

### 🔗 相关问题

以下是面试官常追问的延伸方向，涉及 C++ 语义、智能指针与自定义分配器的交互、以及 GC 语言的根本限制。这三问决定了候选人能否把 Arena 从"概念"落地到"工程实践"：

1. C++ 的 `new`/`delete` 和 `malloc`/`free` 有什么区别？`placement new` 如何配合自定义 Arena 分配器使用？为什么 Arena 分配的对象不能直接 `delete`？（考察构造/析构与内存释放的解耦，以及 placement new 只构造不分配、需手动调用析构函数的语义）
2. 引用计数智能指针（`shared_ptr`）配合自定义分配器时，如何避免"对象从 Arena 分配但析构时试图 free 到全局堆"的双重释放问题？定制删除器（custom deleter）怎么写？（考察 control block 与 deleter 协作，以及如何在 deleter 里只调析构不调 free）
3. JS/C# 这类 GC 语言的"arena 模式"和 C++ 的 arena 有什么本质区别？为什么 ArrayBuffer 方案只能模拟部分功能（无法存放对象引用/虚函数表）？（考察值类型 vs 引用类型、GC barrier、以及 GC 语言无法真正绕过堆的根因）

> **延伸思考**：如果面试官追问"为什么不直接用语言自带的 GC / 引用计数"，可以回答：GC 的 STW 停顿和引用计数的写屏障开销在 60FPS（16.6ms 帧预算）下同样致命，Arena 把"回收时机"从"GC 决定"变成"开发者显式决定"，换取确定性的帧时间。
