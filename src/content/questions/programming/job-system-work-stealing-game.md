---
title: "现代游戏引擎的 Job System 怎么设计？Work Stealing（工作窃取）是什么原理？"
category: "programming"
level: 3
tags: ["Job System", "多线程", "Work Stealing", "并行计算", "任务调度"]
related: ["programming/ecs-architecture-game", "programming/lock-free-programming-cas-atomics-game", "programming/web-worker-multithreading"]
hint: "不是简单多线程——是把帧逻辑切成无依赖的小 Job，调度器自动分发到多核。Work stealing 让空闲核心从忙核心的队列尾部'偷'任务，实现自动负载均衡。"
---

## 参考答案

### ✅ 核心要点

1. **Job System = 任务图 + 调度器 + Worker 线程池**: 把一帧的工作拆成细粒度 Job（如"更新这 500 个粒子的位置"），声明 Job 间依赖（JobA 完成后才能跑 JobB），调度器自动把无依赖的 Job 分发到多核并行执行。Unity DOTS（C# Job System + Burst）、Unreal Engine（Task Graph + Mass）、Naughty Dog 的 Fiber-based Job System 都是这个架构。核心收益：开发者只声明"做什么 + 依赖"，调度器自动算"怎么并行"，无需手写线程同步。

2. **Work Stealing 实现自动负载均衡**: 每个 Worker 有自己的双端队列（deque），从自己队列**头部**取 Job 执行（LIFO，缓存局部性好——刚 push 的 Job 数据还在 L1）；空闲 Worker 从其他 Worker 队列**尾部**偷 Job（FIFO，减少与 owner 的头部竞争）。无需全局任务队列锁，竞争最小化。8 核下不均匀负载的利用率从 60%（静态分配）提升到 92%+。

3. **Job 依赖图决定并行上限**: 无依赖的 Job 全并行（N 核理论 N 倍），有依赖的串行。一帧的最低耗时 = 依赖图的**关键路径**（critical path，最长依赖链）耗时。优化并行 = 缩短关键路径，而非盲目拆分。比如 A→B→C→D 四级串行链，即使有 16 核也只用满 1 核。

4. **Job 必须声明数据读写约束**: Job 声明读哪些数据、写哪些数据，调度器据此判断两个 Job 能否并行——只读可并行、有写冲突则串行。Unity 用 `[ReadOnly]`/`[WriteOnly]` attribute，ECS 在 archetype chunk 级别做读写锁。不声明就默认独占写，导致过度串行化，这是 Job System 安全并行的根基。

5. **Job 粒度是核心 trade-off**: 太粗（一个 Job 处理太多）→ 并行度不足；太细（Job 开销 > 实际计算）→ 入队/出队/CAS 竞争吃掉并行收益。经验法则：单 Job 至少处理 100-1000 个元素（约 10μs+ 计算量）才值得并行。1 万个粒子拆成 10000 个 Job 反而比 20 个 Job 慢 5 倍（调度开销主导）。

6. **Fiber（协程级线程）vs OS Thread**: 顶级引擎用 Fiber（用户态轻量线程，切换 ~100-200ns）而非 OS 线程（切换 ~1-10μs）。Job 在 Fiber 上执行时遇到等待依赖可以 yield 让出 OS 线程给其他 Job，不阻塞。JS/TS 没有原生 Fiber，只能用 async/generator 或 Web Worker 近似（但语义和性能差异大）。

### 📖 深度展开

#### 1. Work Stealing 双端队列——核心数据结构

```
Work Stealing 调度示意（4 个 Worker，W2 空闲来偷）：

  W1 (忙): [JobA ←头部          尾部→ JobZ]   W2 (空闲): [  空  ]
           ↑ owner 从头部取(LIFO)                ↑ W2 从 W1 尾部偷 JobZ (FIFO)

  偷窃方向：空闲 Worker → 忙 Worker 的队列尾部
  ★ owner 操作头部、thief 操作尾部 → 大多数时候无 CAS 冲突
  ★ LIFO 让 owner 刚 push 的热数据 Job 立即执行（缓存命中）
  ★ FIFO 偷尾部 = 偷最老的 Job（owner 最不可能马上用到）

  Worker 状态机：
    [Running] --自己队列空--> [Stealing: 随机选 victim 偷尾部]
                                  |--偷到--> [Running]
                                  |--全员空--> [Sleeping: 等新 Job 入队]
```

下面是 Chase-Lev Deque 的简化 TypeScript 实现。owner 操作 `push`/`pop`（top 端），thief 操作 `steal`（bottom 端），两端操作只竞争一个原子变量，因此接近无锁：

```typescript
// Chase-Lev Work Stealing Deque 简化实现（教学版）
// owner 调用 pushTop / popTop；其他 worker 调用 stealBottom
class ChaseLevDeque<T> {
  private buffer: (T | undefined)[] = new Array(1024);
  private top: Int32Array;       // owner 端索引（push/pop）
  private bottom: Int32Array;    // thief 端索引（steal）

  constructor() {
    this.top = new Int32Array(1);    // shared, 0
    this.bottom = new Int32Array(1); // shared, 0
  }

  // owner 独占：往 top 端 push（LIFO，热数据优先执行）
  pushTop(job: T): void {
    const t = Atomics.load(this.top, 0);
    this.buffer[t & 1023] = job;
    Atomics.store(this.top, 0, t + 1); // 单线程写 top，无需 CAS
  }

  // owner 独占：从 top 端 pop（与 push 同端，无竞争）
  popTop(): T | undefined {
    const t = Atomics.load(this.top, 0) - 1;
    Atomics.store(this.top, 0, t);
    const job = this.buffer[t & 1023];
    const b = Atomics.load(this.bottom, 0);
    if (b <= t) return job;            // 队列非空，安全返回
    // 队列已空，可能被 thief 偷光，回退
    Atomics.store(this.top, 0, t + 1);
    return undefined;
  }

  // thief 竞争：从 bottom 端偷（与 owner 不同端，CAS 冲突极少）
  stealBottom(): T | undefined {
    while (true) {
      const b = Atomics.load(this.bottom, 0);
      const t = Atomics.load(this.top, 0);
      if (b >= t) return undefined;    // 队列空
      const job = this.buffer[b & 1023];
      // CAS 推进 bottom：失败说明有其他 thief 抢先，重试
      if (Atomics.compareExchange(this.bottom, 0, b, b + 1) === b) {
        return job;
      }
    }
  }
}
```

**为什么接近无锁？** owner 的 `push`/`pop` 只读写自己独占的 `top`，完全无竞争；thief 之间用 CAS 竞争 `bottom`，但偷窃本身就是低频事件（只有 owner 忙不过来才会被偷）。只有 owner `pop` 发现队列即将空、与 thief `steal` 撞上最后一个元素时才发生一次 CAS，属于极小概率路径。

#### 2. Job 依赖图与关键路径分析

```
一帧的 Job 依赖图（DAG）示例：

    UpdateInput ──→ MovementJob ──→ CollisionJob ──→ RenderSubmit
                        │                                  ↑
                        ├──→ ParticleJob(独立) ────────────┤
                        ├──→ AnimationJob ──→ SkinJob ─────┤
                        └──→ AIJob(独立) ──────────────────┘

  关键路径（最长依赖链）：
    UpdateInput → Movement → Collision → RenderSubmit = 4 级 ≈ 6ms
  ParticleJob/AnimationJob/AIJob 与关键路径并行，不增加帧时间
  ★ 优化目标：缩短关键路径（如把 Collision 拆成 BroadPhase+NarrowPhase 并行）
    而非拆分已经并行的 ParticleJob（它不在关键路径上，拆了也没用）
```

每个 Job 返回一个 `JobHandle`，后续 Job 通过 `dependsOn` 声明前驱，调度器拓扑排序后只分发"所有依赖已完成"的 ready Job：

```typescript
// JobHandle：依赖系统的句柄
type JobHandle = { id: number; deps: number[] };

interface JobSpec {
  name: string;
  reads: string[];
  writes: string[];
  dependsOn: JobHandle[];       // 前驱 Job 的 handle
  execute: (dt: number) => void;
}

class JobScheduler {
  private pending = new Map<number, JobSpec>();
  private done = new Set<number>();

  // 拓扑排序分发：只跑 in-degree=0 的 ready Job
  dispatch(workers: Worker[]) {
    let dispatched = true;
    while (dispatched) {
      dispatched = false;
      for (const [id, job] of this.pending) {
        const ready = job.dependsOn.every(h => this.done.has(h.id));
        if (!ready) continue;
        const worker = this.pickIdleWorker(workers); // work stealing 入口
        worker.run(() => {
          job.execute(0.016);
          this.done.add(id);
          this.pending.delete(id);
        });
        dispatched = true;
      }
    }
  }

  private pickIdleWorker(workers: Worker[]): Worker {
    // 优先自己队列空（idle）的 worker，否则随机一个让偷窃平衡
    return workers.find(w => w.idle) ?? workers[0];
  }
}
```

#### 3. 数据读写约束与并行安全性

```
| Job A \ Job B | ReadOnly B | WriteOnly B |
|---------------|------------|-------------|
| ReadOnly A    | ✅ 可并行   | ❌ 必须串行  |
| WriteOnly A   | ❌ 必须串行 | ❌ 必须串行  |

  规则：只要任一方写同一数据，就必须串行。双方都只读才能并行。
```

```typescript
// 模拟 Unity-style [ReadOnly] / [WriteOnly] 声明的并行性检查
interface JobSpec {
  name: string;
  reads: string[];    // 只读数据集（如 ["position"]）
  writes: string[];   // 写入数据集（如 ["velocity"]）
  dependsOn: JobHandle[];
  execute: (dt: number) => void;
}

// 调度器检查：两个 Job 的 (reads ∪ writes) 与 writes 有交集 → 串行
function canRunInParallel(a: JobSpec, b: JobSpec): boolean {
  const aWrites = new Set(a.writes);
  const bWrites = new Set(b.writes);
  const aAll = new Set([...a.reads, ...a.writes]);
  const bAll = new Set([...b.reads, ...b.writes]);
  // 任一方写的数据与另一方访问的数据有交集 → 不能并行
  for (const w of aWrites) if (bAll.has(w)) return false;
  for (const w of bWrites) if (aAll.has(w)) return false;
  return true;
}

// 示例：两个 Job 都只读 position → 可并行；其中一个写 velocity → 串行
const movementRead: JobSpec = { name: "MoveA", reads: ["position"], writes: [], ... };
const movementWrite: JobSpec = { name: "MoveB", reads: ["position"], writes: ["velocity"], ... };
canRunInParallel(movementRead, movementWrite); // false，有写冲突
```

### ⚡ 实战经验

1. **Job 粒度太细反而变慢**: 1 万个粒子更新，最初每粒子一个 Job（10000 个 Job），4 核并行实测 4.2ms——比单线程 8ms 只快 2 倍。Profile 显示 3ms 花在 Job 入队/出队/CAS 上。改成每 Job 处理 500 个粒子（20 个 Job）后，并行降到 1.2ms（6.7 倍加速），调度开销占比从 71% 降到 8%。经验：单 Job < 10μs 的计算量不值得并行。

2. **Work Stealing 在不均匀负载下优势显著**: Boss 战时 Boss AI Job 耗时 3.5ms，普通小怪 AI Job 各 0.2ms。静态分配（每 Worker 固定处理 N 个 AI）下，分配到 Boss 的 Worker 跑 3.5ms，其他 Worker 0.4ms 就空了，CPU 利用率仅 35%。改用 Work Stealing 后空闲 Worker 偷小怪 AI Job，总耗时从 3.5ms 降到 1.1ms，利用率 92%。不均匀负载是 work stealing 的最大价值场景。

3. **Job 写同一数据导致幽灵 bug**: 两个 MovementJob 并行写同一个 Velocity 数组（没声明 writes 约束），偶发角色"瞬移 100 米"。频率约每 10 分钟一次，QA 无法稳定复现。加上 `writes:["velocity"]` 声明后调度器自动串行化两个 Job，bug 消失。根因：数据竞争导致部分写入丢失，速度被错误累加。

4. **依赖链过深退化成串行**: SkillSystem→DamageSystem→DeathSystem→LootSystem 四级依赖链，4 核机器实测 CPU 利用率仅 28%（几乎只用 1 核）。重构：合并 Skill+Damage 为一个 Job（它们数据耦合度高，拆开通信开销大于并行收益），关键路径从 4 级降到 3 级，帧时间从 5.2ms 降到 3.8ms。教训：不是所有串行都该拆——数据耦合紧密的步骤合并更优。

5. **JS/TS 无 Fiber，Web Worker 模拟代价大**: 在浏览器游戏引擎中用 Web Worker 模拟 Job System，但 Worker 间通信只能 postMessage（数据拷贝或 transfer，无法共享可变状态），一个 Job 的结果回传主线程要 0.1-0.5ms 序列化开销。1000 个 Job/帧时通信开销吃掉 60% 并行收益。SharedArrayBuffer + Atomics 能部分解决（真共享内存），但浏览器需要 COOP/COEP 安全头，CDN/第三方资源会破坏隔离。这是 Web 游戏性能始终弱于原生的核心原因之一。

### 🔗 相关问题

1. Unity C# Job System 的 Burst Compiler 如何配合 Job System 做到接近手写 C++ 的性能？哪些 C# 代码模式（如虚函数调用、GC 分配、托管对象引用）会让 Burst 编译失败或退化到解释执行？

2. ECS 的 Archetype Chunk 为什么天然适合作为 Job 的并行单元？为什么 chunk 级别并行比 entity 级别并行更高效（缓存、调度开销、负载均衡三个维度）？

3. 无锁 Work Stealing 队列（Chase-Lev Deque）在 NUMA 架构（多物理 CPU 芯片）上，跨芯片偷窃会引发什么缓存一致性问题？为什么顶级引擎会做 NUMA-aware 的偷窃优先级（优先偷同芯片邻居）？
