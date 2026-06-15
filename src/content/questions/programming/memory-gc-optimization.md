---
title: "JavaScript/TypeScript 游戏中如何避免 GC（垃圾回收）造成的卡顿？"
category: "programming"
level: 2
tags: ["内存管理", "垃圾回收", "性能优化", "GC", "对象池"]
related: ["programming/data-structures-game", "programming/deep-vs-shallow-copy"]
hint: "关键不是消灭 GC，而是让分配变得可预测——把高频分配挪到低频路径上。"
---

## 参考答案

### ✅ 核心要点

1. **GC 是 V8 的分代回收**：新生代（Scavenge，频繁但快）+ 老生代（Mark-Sweep/Mark-Compact，慢但容量大）。卡顿几乎都来自老生代的标记清除，停顿可达几十毫秒。
2. **减量比优化 GC 本身更重要**：真正有效的不是"调 GC 参数"，而是"让热路径（每帧、战斗循环）零分配"，把 `new` 全部预分配或走对象池。
3. **对象池是头号武器**：子弹、粒子、伤害数字这类高频创建/销毁的对象，用池复用，把"分配"从运行时挪到加载期。
4. **保护 V8 的 hidden class（隐藏类）**：固定字段顺序、别动态删属性、数组别混类型，否则 JIT 退化为慢路径，连带 GC 扫描成本上升。
5. **闭包和事件监听是隐形泄漏源**：回调捕获大对象、`addEventListener` 没有对应 `removeEventListener`，会让对象进老生代永远回收不掉。
6. **先测再优化**：用 `performance.measureUserAgentSpecificMemory` / Chrome DevTools Memory 面板量化堆增长和 GC 频率，别凭感觉。

### 📖 深度展开

**1. V8 分代 GC 原理**

```
堆内存
├── 新生代 (Young, ~1-8MB)
│   ├── From 区  ──┐  Scavenge: 存活对象复制到 To
│   └── To   区  ──┘  约每几 ms 一次，停顿 <1ms
│         │  熬过 2 次 Scavenge → 晋升
│         ▼
└── 老生代 (Old, 数百 MB+)
        Mark-Sweep(标记清除) + Mark-Compact(整理)
        触发条件: 老生代占用超阈值
        ★ 卡顿元凶: 标记阶段可达 10-50ms 停顿
```

关键洞察：**新生代分配几乎免费**（指针碰撞），问题出在"对象活太久晋升到老生代"→ 老生代越满，Mark-Sweep 越频繁越慢。所以目标是**让短命对象真的短命，长命对象只创建一次**。

**2. 对象池完整实现（带统计与自动扩容）**

```typescript
class Pool<T> {
  private free: T[] = [];
  private factory: () => T;
  private reset: (o: T) => void;
  // 运行期统计：判断池大小是否合理
  peak = 0; allocated = 0; hits = 0; misses = 0;

  constructor(factory: () => T, reset: (o: T) => void, prewarm = 0) {
    this.factory = factory; this.reset = reset;
    for (let i = 0; i < prewarm; i++) this.free.push(factory()); // 加载期分配
  }
  obtain(): T {
    const o = this.free.pop();
    if (o) { this.hits++; return o; }
    this.misses++; this.allocated++;
    if (this.allocated > this.peak) this.peak = this.allocated;
    return this.factory();   // 池空才在运行时分配
  }
  release(o: T): void {
    this.reset(o);           // 清脏数据，防止跨帧污染
    this.free.push(o);
    this.allocated--;
  }
}
// 子弹池：预热 200，峰值用量若稳定 <150 说明预热够了
```

**3. 三大隐形泄漏模式与排查**

| 模式 | 触发原因 | 定位手段 |
|------|----------|----------|
| 闭包捕获 | 定时器/回调闭包 hold 住整个场景对象 | Heap snapshot 对比，看 Retained Size |
| 事件未解绑 | `on('dead')` 没配 `off`，回调链一直引用实体 | DevTools Event Listeners 面板 |
| Map/Set 缓存无界 | `cache.set(id, data)` 只增不删 | 看 Map size 是否随帧单调增长 |

```typescript
// ❌ 闭包泄漏：每帧注册，回调持有 entity，永不释放
function tick() {
  setInterval(() => { entity.hp--; }, 1000);  // entity 永生
}
// ✅ 用一次性回调 + 显式清理
const timer = setInterval(() => entity.hp--, 1000);
entity.once('dead', () => clearInterval(timer)); // 死亡时解绑
```

### ⚡ 实战经验

- **每帧 `new Vec3` 是性能黑洞**：一个射击游戏战斗中每帧新建 ~2000 个 `Vec3`（位置/速度/法线），新生代每 3 帧塞满触发 Scavenge，偶发晋升导致老生代 Mark-Sweep，帧时间从 16ms 抖到 45ms。改成 `Vec3` 对象池 + 复用临时变量后稳定 60fps。
- **Map 缓存忘记设上限**：技能特效缓存 `Map<id, Effect>` 不清理，2 小时后堆涨到 800MB 触发全量 GC 卡 1.2 秒。加 LRU 上限（500 条）后堆稳定在 120MB。
- **`delete obj.prop` 破坏 hidden class**：动态删字段让 V8 退化到 dictionary 模式，属性访问慢 5-10 倍。改成 `obj.prop = null`（保留形状）或重新赋整个对象。
- **用 `performance.memory`（或新 API）量化**：上线前埋点记录 `usedJSHeapSize` 增长曲线，正常应"锯齿"波动；若单调上升必是泄漏。别等玩家反馈卡顿才发现。
- **`console.log` 也会持引用**：调试时 `console.log(hugeObject)` 让 DevTools 持有引用不释放，性能测试前务必清掉调试日志。

### 🔗 相关问题

1. Chrome DevTools 的 Memory 面板里 Heap snapshot 和 Allocation timeline 各适合排查什么？怎么对比两次快照找泄漏？
2. `WeakMap` / `WeakSet` 在游戏缓存中有什么用？为什么它们不参与 GC root 计数？
3. 对象池预热多少合适？池太大浪费内存、太小没用，怎么用运行期 `peak/hits/misses` 统计调优？
