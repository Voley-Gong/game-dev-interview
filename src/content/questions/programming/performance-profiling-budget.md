---
title: "游戏性能怎么分析？火焰图、堆快照、帧预算分别解决什么问题？"
category: "programming"
level: 2
tags: ["性能优化", "性能分析", "Profiling", "火焰图", "帧预算", "内存泄漏", "性能回归"]
related: ["programming/memory-gc-optimization", "programming/game-loop-fixed-timestep", "programming/event-loop-task-scheduling"]
hint: "不是凭直觉调参——是先用 Profiler 拿数据定位『CPU 还是 GPU、主线程还是 GC、稳态还是极端场景』，再针对性优化。"
---

## 参考答案

### ✅ 核心要点

1. **测量先于优化（Measure, don't guess）**：任何优化前都必须先用 Profiler 拿到数据。凭直觉优化的典型悲剧是花三天调 A* 寻路，Profiler 一开发现 80% 时间耗在 UI 的 mask 重绘上。性能问题的第一定律是「用数据说话」：先分清瓶颈在 CPU 还是 GPU、主线程还是工作线程、是脚本逻辑还是引擎渲染，再动手。
2. **帧预算（Frame Budget）是性能管理的总纲**：60FPS 意味着每帧只有 **16.67ms**，30FPS 是 33.33ms。把渲染、AI、物理、逻辑、IO 各子系统的耗时加起来必须落在预算内，还要预留 1-2ms 给系统抖动（GC、vsync、后台进程）。建立「帧预算分配表」把预算切给各模块，哪个模块超标一目了然，避免「整体达标但某一帧爆掉」。
3. **CPU 采样与内存堆快照是两种互不替代的工具**：CPU Profile（性能面板的火焰图）回答「哪段代码跑得久、被调用多少次」——找 CPU 热点；Heap Snapshot（堆快照）回答「什么对象占内存、谁引用它导致无法回收」——找内存泄漏和高驻留。卡顿类问题看 CPU，内存涨/OOM 类问题看堆，两者结合才能定位「偶发卡顿」和「长期内存腐烂」两类不同病因。
4. **火焰图解读：宽度 = 采样占比，优化看「宽且在栈顶」的函数**：火焰图纵轴是调用栈深度（下→上），横轴是采样次数占比（不是绝对墙钟时间）。优化要看「宽且位于栈顶」的函数——那才是 CPU 真正消耗点；「深而窄」的调用链通常不是瓶颈。还要区分「自身耗时（self time）」和「含子调用耗时（total time）」：self time 高才是真正该优化的热点。
5. **区分稳态性能与极端场景性能**：日常跑图 60FPS 不代表 boss 战满屏特效不卡。必须针对三个极端场景单独 profiling——「同屏实体峰值」（百人团战）、「特效/粒子峰值」（全屏大招）、「加载峰值」（切大场景）——因为它们的瓶颈完全不同（实体峰值卡 AI/物理，特效峰值卡 GPU/DrawCall，加载峰值卡 IO/解码），优化手段也互斥。
6. **建立性能回归基线，用 P99 而非平均值做门槛**：平均帧时间 14ms 看着达标，但 P99 可能是 48ms——意味着 10% 的玩家每秒经历 2 次明显卡顿却从平均数完全看不出来。每次提交跑自动化 benchmark（固定场景回放 + 帧时间采集），用 P99/P99.9 帧时间设回归阈值，一旦超限自动告警，防止性能随迭代悄无声息地腐烂。

### 📖 深度展开

#### 1. 帧预算分配与火焰图解读

帧预算表把 16.67ms（60FPS）切分给各子系统，超标项就是优化目标。下图是一个典型的 MMO 团战场景预算（已超支）：

```
60FPS 帧预算 = 16.67ms
┌──────────────────────────────────────────────┐
│ 渲染(Render)   ████████████ 8.5ms   ⚠超标(预算6) │
│ AI/寻路        █████ 3.2ms              (预算3) │
│ 物理           ██ 1.1ms                 (预算2) │
│ 脚本逻辑       ███ 2.0ms                (预算2) │
│ IO/解码        █ 0.6ms                  (预算1) │
│ 系统/GC预留    ██ 1.27ms                (预算1.6)│
└──────────────────────────────────────────────┘
实际合计: 16.67ms  → 勉强达标，但渲染超标挤压了GC余量
```

用 Chrome DevTools Performance 录一段卡顿帧，火焰图长这样（栈顶越宽越该优化）：

```
火焰图（横轴=采样占比，纵轴=调用栈，底部=入口）
Task (16.8ms) ──────────────────────────────────────
 ├─ Update (12.1ms) ████████████████████████
 │   ├─ updateEntities (8.4ms) ████████████████     ← 宽，热点候选
 │   │   ├─ computeAI (5.1ms) ██████████            ← 栈顶最宽！真正热点
 │   │   │   └─ findPath (4.8ms)                    ← 几乎全在 A*寻路
 │   │   └─ updateTransform (2.0ms)
 │   └─ Render (3.7ms) ███████
 │       └─ drawMask (3.1ms) ██████                 ← 第二热点
 └─ RAF callback (1.2ms)
```
结论：优先优化 `findPath`（A* 寻路）和 `drawMask`（UI 蒙版），而不是凭感觉去改 `updateTransform`。

代码侧用 Performance API 打点，精确测量热点函数耗时：

```typescript
// 在热点函数前后打 mark，测量区间耗时，写进 ring buffer 做统计
class PerfTracker {
  private samples: number[] = new Array(120).fill(0);  // 滚动 2 秒@60fps
  private idx = 0;

  /** 测量一段同步逻辑的耗时（ms） */
  measure<T>(label: string, fn: () => T): T {
    const t0 = performance.now();
    const r = fn();
    const dt = performance.now() - t0;
    this.samples[this.idx = (this.idx + 1) % 120] = dt;
    if (dt > 8) console.warn(`[PERF] ${label} 耗时 ${dt.toFixed(2)}ms`);
    return r;
  }

  /** P99 帧时间——比平均更能反映真实卡顿体验 */
  get p99(): number {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.99)];
  }
}
// 用法：tracker.measure('A*寻路', () => pathfinder.find(start, goal));
```

#### 2. 内存泄漏定位：堆快照三快照对比法

卡顿/OOM 类问题用 Heap Snapshot。核心是「三快照对比法」——在泄漏发生的操作前后各拍快照，对比只增不减的对象就是泄漏元凶：

```
快照1(基线)  →  执行「进战斗→退出」  →  快照2(操作后)
                ↓ 重复5次
快照3(操作后) →  对比 快照1 vs 快照3

筛选条件：在 快照1 和 快照3 之间都存在、且 retained size 持续增长的对象
        → 这些就是没被回收的泄漏对象
```

```
快照对比结果（按 retained size 降序）:
┌──────────────────────────┬──────────┬───────────┬────────────┐
│ 构造函数 / 类型           │ 新增数量 │ Shallow   │ Retained   │
├──────────────────────────┼──────────┼───────────┼────────────┤
│ EventHandler (closure)   │ +12,480  │ 0.8MB     │ 14.2MB ⚠   │ ← 泄漏!
│ DamagePopup (Sprite)     │ +3,200   │ 2.1MB     │ 5.6MB  ⚠   │ ← 没销毁
│ PlayerSnapshot           │ +5       │ 0.2MB     │ 0.3MB      │ (正常缓存)
└──────────────────────────┴──────────┴───────────┴────────────┘
Retained Size = 该对象被回收后能释放的总内存（含其引用的整条对象图）
```

关键概念辨析：

| 概念 | 含义 | 优化意义 |
|------|------|---------|
| Shallow Size | 对象自身占用的内存（不含引用的对象） | 看对象本身多大 |
| Retained Size | 对象被 GC 后能释放的总内存（含其独占引用的对象图） | **找泄漏看这个**——它代表「删掉这个根，能回收多少」 |
| Dominator | 持有该对象的最短引用路径上的「支配者」 | 顺着 Dominator 树找到泄漏根（谁在持有） |

#### 3. 帧时间统计与性能回归基线

性能不是「上线前测一次」，而是「每次提交都测」。用 ring buffer 采集帧时间，算 P50/P99/P99.9，超阈值即告警：

```typescript
class FrameStats {
  private times: Float32Array;  // 用 TypedArray 避免 GC
  private idx = 0;
  private last = performance.now();

  constructor(n = 300) { this.times = new Float32Array(n); }

  /** 每帧末尾调用 */
  tick() {
    const now = performance.now();
    this.times[this.idx] = now - this.last;     // 本帧耗时
    this.idx = (this.idx + 1) % this.times.length;
    this.last = now;
  }

  /** 分位数统计（P99 比 mean 更能反映真实体验） */
  quantile(p: number): number {
    const sorted = [...this.times].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * p)];
  }
  report() {
    return {
      p50: this.quantile(0.50).toFixed(1),
      p99: this.quantile(0.99).toFixed(1),    // 99% 的帧快于此
      max: Math.max(...this.times).toFixed(1),
    };
  }
}
// CI 回归门槛：P99 > 22ms (留 5ms 给抖动) → 失败，阻断合并
```

帧时间分布的形状比单点值更能说明问题：

```
健康分布（集中、无长尾）:          病态分布（有长尾卡顿）:
   │██                            │██
   │████                          │████
   │██████                        │██████
   │████████  ←P50~14ms           │██████████  ←P50看着OK
   │████████████                  │████████████████ ▓▓  ←长尾!P99=48ms
   └────────────── ms             └────────────────────── ms
   8  10 12 14 16                 8 10 12 14 16 ... 40 48
   集中在 14ms，P99=16ms           平均14ms但10%的帧爆到48ms
```
长尾通常来自 GC、资源加载、IO 同步等待——这些在平均值里被「稀释」隐藏，只有 P99 才暴露。

### ⚡ 实战经验

- **凭直觉优化三天不如 Profiler 开五分钟**：曾怀疑 50 人团战卡顿是 A* 寻路慢，花三天上 JPS 跳点寻路优化，毫无改善。Profiler 一开发现 80% 帧时间在 UI 的 `drawMask`（一个全屏血条蒙版每帧重绘），把血条用 GPU 实例化合并后帧时间从 **42ms 降到 15ms**。教训：永远先测量再动手。
- **P99 才是真体验，平均值会骗人**：平均帧时间 14ms「达标」，但 P99 是 48ms——实测 10% 的玩家每秒经历 2 次明显掉帧，论坛一片「卡顿」差评却从监控曲线完全看不出来。后来把告警阈值从「mean > 18ms」改成「**P99 > 22ms**」，立刻抓到问题。
- **三快照对比法定位事件监听器泄漏**：切场景后内存持续上涨，用三快照对比发现 `EventHandler` 闭包每次涨 **12,000+ 个、retained size 14MB**——是战斗模块的事件监听器在切场景时没解绑。顺着 Dominator 树查到是 `EventBus.on()` 返回的 disposable 被丢弃没调用，加 `takeUntil(destroy$)` 后泄漏归零。
- **GPU 纹理内存不释放是引用计数漏减**：切场景后 GPU 显存不降，Profiler 的 Memory 面板显示纹理 retained size 占 **120MB**。排查是资源管理器的引用计数在「快速切场景」时被 `destroy` 和 `load` 并发执行打乱（减了两次），导致纹理永驻。改用「延迟销毁队列 + 帧末统一 flush」后显存稳定在 40MB。
- **极端场景要单独建基线**：日常跑图 60FPS，但「全屏大招 + 百人团战」组合帧时间飙到 **55ms（18FPS）**。给三个极端场景分别建独立的 benchmark 回放（录制的固定输入流），CI 里分跑，分别设阈值，才不会让「团战卡成 PPT」这类问题漏过日常测试。

### 🔗 相关问题

- **渲染卡顿和逻辑卡顿怎么快速区分？** —— 提示：看 Profiler 里是 `Render` 段宽（GPU/DrawCall 瓶颈，优化合批/LOD/特效）还是 `Update` 段宽（CPU 逻辑瓶颈，优化算法/缓存/GC）；也可以临时把渲染空跑只跑逻辑，帧时间大降说明瓶颈在渲染。
- **移动端和 PC 端的性能预算策略有什么不同？** —— 提示：移动端要考虑发热降频（持续高负载会被系统强制降频）、内存上限低（iOS 单 App ~1.5GB）、GPU 弱（DrawCall 预算更紧）；常用「分档预算」——低端机锁 30FPS + 降分辨率 + 关后效，高端机 60FPS + 全特效。
- **对象池和 GC 哪个更该先优化？** —— 提示：先看 GC 频率（Memory 面板的 GC 事件），如果每秒触发多次 minor GC 造成抖动，对象池优先（减少分配）；如果 GC 频率正常但单次 major GC 耗时长，则排查是否有大对象驻留或内存泄漏。
