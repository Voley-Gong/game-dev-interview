---
title: "生成器与迭代器：如何用惰性求值处理游戏数据流？"
category: "programming"
level: 3
tags: ["生成器", "迭代器", "惰性求值", "数据流"]
related: ["programming/async-coroutine-scheduling", "programming/procedural-noise-generation"]
hint: "无限地图、按需加载的关卡、流式日志——生成器如何让你遍历「还没生成的数据」而不用担心内存爆炸？"
---

## 参考答案

### ✅ 核心要点

1. **迭代器协议**：实现 `next()` 的对象，提供「按需取一个值」的能力，是 `for...of`、展开运算符背后的统一抽象
2. **生成器函数 `function*`**：用 `yield` 暂停执行并产出值，把「产生序列」的逻辑写得像同步代码，天然支持惰性求值
3. **惰性求值（Lazy Evaluation）**：值在需要时才计算，可表示「无限序列」（如无限程序化地形）而不占用无限内存
4. **数据流管线**：用生成器组合 `map/filter/take`，像流水线一样处理大数据集，中间不产生完整数组
5. **与协程的关系**：生成器是 JS 协程的基础，`yield` 可用于实现帧分片任务、状态机暂停恢复、可取消的异步流程

### 📖 深度展开

**1. 无限序列：程序化生成的惰性地图**

```typescript
// 用噪声函数生成「无限」地形，只在玩家靠近时才实际计算对应区块
function* infiniteTerrain(seed: number): Generator<Chunk, void, void> {
  const noise = makeNoise(seed);
  let cx = 0, cy = 0;
  while (true) {  // 无限循环，但只在被 next() 调用时才执行一步
    const height = noise(cx, cy);
    yield { x: cx, y: cy, height, biome: height > 0.6 ? 'mountain' : 'plain' };
    // 简化的螺旋遍历，实际按玩家位置加载
    cx += 1;
  }
}

const terrain = infiniteTerrain(42);
// 只取玩家周围 5x5 的区块，绝不一次性生成无限地图
const nearby: Chunk[] = [];
for (let i = 0; i < 25; i++) nearby.push(terrain.next().value);
// 内存占用恒定（25 个 Chunk），而非 O(∞)
```

**2. 数据流管线：处理海量日志/事件而不爆内存**

```typescript
// 生成器版的 map/filter：每个环节都是惰性的，不在内存中生成中间数组
function* mapGen<T, U>(iter: Iterable<T>, fn: (x: T) => U): Generator<U> {
  for (const x of iter) yield fn(x);
}
function* filterGen<T>(iter: Iterable<T>, pred: (x: T) => boolean): Generator<T> {
  for (const x of iter) if (pred(x)) yield x;
}
function* takeGen<T>(iter: Iterable<T>, n: number): Generator<T> {
  let i = 0;
  for (const x of iter) { if (i++ >= n) break; yield x; }
}

// 从百万行战斗日志中，筛选暴击且伤害>1000的前10条——全程不生成百万数组
const topCrits = takeGen(
  filterGen(
    mapGen(battleLogLines(), parseLog),
    (e) => e.isCrit && e.damage > 1000
  ),
  10
);
for (const evt of topCrits) renderToUI(evt);  // 逐条产出，内存占用极低
```

```
惰性管线 vs 急切（Eager）数组对比：

  battleLog (1,000,000 行)
    │
    ├─ 急切：.map().filter().slice()
    │        生成 3 个百万级中间数组 → 内存峰值 ~300MB
    │
    └─ 惰性：mapGen→filterGen→takeGen
             每个 next() 只推一个值穿过管道
             取满 10 条即停 → 内存峰值 < 1KB
```

**3. 帧分片：用生成器把耗时任务拆到多帧**

```typescript
// 寻路、大面积伤害计算等耗时任务，用生成器分片到多帧执行避免卡顿
function* pathfindStepByStep(start: Vec, goal: Vec): Generator<Vec[] | null> {
  const open = new PriorityQueue();
  open.push(start);
  while (!open.empty()) {
    // 每次 yield 让出一帧，引擎可在帧间渲染、保持流畅
    const node = open.pop();
    if (node === goal) return reconstructPath(node);
    for (const n of neighbors(node)) {
      open.push(n);
      yield null;  // 交还控制权，本帧计算到此为止
    }
  }
  return null;
}
// 主循环中每帧推进一次，UI 不卡顿
const walker = pathfindStepByStep(hero, dest);
function update() {
  walker.next();  // 推进一步寻路
  requestAnimationFrame(update);
}
```

**迭代方式对比：**

| 方式 | 内存 | 是否惰性 | 可表示无限序列 | 适用场景 |
|------|------|----------|---------------|----------|
| 数组 `[...items]` | O(n) 全量 | 否 | 否 | 数据量小、需随机访问 |
| 生成器 `function*` | O(1) 单步 | 是 | 是 | 流式数据、无限序列 |
| 异步迭代 `async function*` | O(1) 单步 | 是 | 是 | 网络/IO 数据流 |
| 自定义 Iterable | O(1) | 可选 | 可选 | 需复用迭代逻辑 |

### ⚡ 实战经验

- **生成器不是免费的**：每次 `next()` 有协程切换开销，紧密循环（每帧万次）中用生成器比直接 for 循环慢 3-5 倍。热点路径用手写循环，IO/流式场景才用生成器
- **`for...of` 会消费完整个生成器**：对无限生成器用 `for...of` 会死循环。务必配 `break` 或 `take` 限制数量，曾因漏写 break 导致页面假死
- **生成器做完就关**：未遍历完的生成器会持有闭包引用，可能延迟 GC。对提前退出的生成器调用 `return()` 显式释放，避免长生命周期生成器泄漏内存
- **协程分帧注意超时**：用生成器分片寻路时，如果单步计算仍然很重（如一次展开上千节点），分帧也救不了。要确保每次 `next()` 的工作量小于单帧预算（16ms 的 1/3）

### 🔗 相关问题

- `async function*` 异步生成器和普通生成器有什么区别？如何用它拉取网络分页数据？
- 生成器如何实现可取消的协程？`throw()` 和 `return()` 在协程控制中起什么作用？
- 迭代器协议（`Symbol.iterator`）和 React 的 children 遍历、Immutable.js 的序列有什么联系？
