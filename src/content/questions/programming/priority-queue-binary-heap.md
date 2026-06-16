---
title: "优先队列（二叉堆）在游戏开发中有哪些应用？如何手写一个高效的优先队列？"
category: "programming"
level: 2
tags: ["数据结构", "优先队列", "二叉堆", "A*寻路", "任务调度"]
related: ["programming/data-structures-game", "programming/graph-algorithms-game", "programming/ring-buffer-game"]
hint: "不是普通的先进先出队列——每次取出的都是优先级最高的元素，A* 寻路的 Open Set、事件调度系统、AI 决策权重排序全靠它。"
---

## 参考答案

### ✅ 核心要点

1. **优先队列 = 永远取优先级最高/最低的元素**：普通队列是 FIFO（先进先出），优先队列每次 `pop` 出来的都是当前堆中优先级最高（或代价最小）的元素。游戏中最典型的应用是 A* 寻路的 Open Set——每步都要从待探索节点中取出 `f(n) = g(n) + h(n)` 最小的节点，如果用排序数组每次 O(n log n)，用二叉堆只要 O(log n)。
2. **二叉堆是标准实现，入队出队均 O(log n)**：二叉堆用数组存储完全二叉树，父节点总是 ≤（或 ≥）子节点（小顶堆/大顶堆）。插入时「上浮」（sift up），删除堆顶时将末尾元素放到堆顶再「下沉」（sift down），两个核心操作都是 O(log n)，且由于数组连续存储，缓存命中率极高。
3. **A* 寻路的性能瓶颈就在优先队列**：一张 100×100 的网格地图，A* 可能探索数千个节点。如果 Open Set 用数组 + 每次排序，总复杂度 O(n² log n)；换成二叉堆后降到 O(n log n)，寻路耗时从 15ms 降到 0.3ms——这就是为什么几乎所有寻路库内部都用堆。
4. **游戏事件/任务调度系统的核心**：延迟回调系统（「3 秒后爆炸」「10 秒后刷怪」）需要一个按触发时间排序的优先队列，每帧只需检查堆顶事件是否到期，而不是遍历整个事件列表。1000 个定时器从 O(n) 遍历降到 O(1) 的堆顶检查。
5. **支持 decrease-key 操作的堆用于 Dijkstra**：Dijkstra 算法需要「更新已有节点的距离」（降低优先级值），朴素实现是「插入重复项 + 懒删除」（简单但浪费空间），进阶实现用索引堆（Indexed Heap）直接定位并更新堆中任意元素的位置。
6. **JS/TS 中没有内置优先队列，必须手写**：C++ 有 `std::priority_queue`、Java 有 `PriorityQueue`、Python 有 `heapq`，但 TypeScript 没有标准库实现。游戏开发者必须自己实现二叉堆，或依赖第三方库（如 `heap-js`）。理解底层原理是面试核心考点。

### 📖 深度展开

**1. 二叉堆完整实现（TypeScript，泛型 + 比较器）**

```typescript
/**
 * 泛型二叉堆优先队列
 * 小顶堆：comparator 返回负数时 a 排在前面（优先出队）
 */
class PriorityQueue<T> {
  private heap: T[] = [];
  private readonly compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number { return this.heap.length; }
  get isEmpty(): boolean { return this.heap.length === 0; }

  /** 入队：追加到末尾，向上调整 O(log n) */
  push(item: T): void {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  /** 取出堆顶（优先级最高）O(log n) */
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;       // 取出末尾元素
    if (this.heap.length > 0) {
      this.heap[0] = last;               // 末尾元素放到堆顶
      this.siftDown(0);                   // 向下调整
    }
    return top;
  }

  /** 查看堆顶但不移除 O(1) */
  peek(): T | undefined { return this.heap[0]; }

  // ── 核心算法：上浮 ──
  private siftUp(index: number): void {
    const item = this.heap[index];
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;   // 父节点索引 = (i-1)/2
      if (this.compare(item, this.heap[parentIndex]) >= 0) break;
      this.heap[index] = this.heap[parentIndex]; // 父节点下沉
      index = parentIndex;
    }
    this.heap[index] = item;
  }

  // ── 核心算法：下沉 ──
  private siftDown(index: number): void {
    const half = this.heap.length >> 1;  // 只需要下沉到最后一层之前
    const item = this.heap[index];
    while (index < half) {
      let childIndex = (index << 1) + 1;  // 左子节点 = 2*i+1
      const right = childIndex + 1;
      // 选较小的子节点
      if (right < this.heap.length &&
          this.compare(this.heap[right], this.heap[childIndex]) < 0) {
        childIndex = right;
      }
      if (this.compare(item, this.heap[childIndex]) <= 0) break;
      this.heap[index] = this.heap[childIndex]; // 子节点上浮
      index = childIndex;
    }
    this.heap[index] = item;
  }
}
```

**2. A* 寻路中的实际应用**

```
A* 寻路流程与优先队列的关系：

  Start 节点入队 (f = h(start))
         ↓
  ┌─── 从 OpenSet 弹出 f 最小的节点 current ───┐  ← pop()  O(log n)
  │                                                    │
  │    遍历 current 的邻居 neighbor:                    │
  │      g_new = current.g + cost(current, neighbor)    │
  │      如果 g_new < neighbor.g:                        │
  │        neighbor.g = g_new                            │
  │        neighbor.f = g_new + h(neighbor)             │
  │        neighbor.parent = current                     │
  │        neighbor 入队                                │  ← push() O(log n)
  │                                                     │
  └──── current == Goal ? → 重建路径 : 继续循环 ────────┘

  对比：用数组排序每次取最小 = O(n) pop → 总复杂度 O(V²)
        用二叉堆 pop/push = O(log n) → 总复杂度 O(E log V)
```

```typescript
// A* 寻路核心：优先队列管理 Open Set
interface PathNode {
  x: number; y: number;
  g: number;      // 起点到此节点的实际代价
  h: number;      // 此节点到终点的启发式估算
  f: number;      // g + h（优先队列排序依据）
  parent: PathNode | null;
}

function astar(grid: number[][], start: Vec2, goal: Vec2): Vec2[] | null {
  // 小顶堆：f 值最小的先出队
  const openSet = new PriorityQueue<PathNode>((a, b) => a.f - b.f);
  const visited = new Set<string>();

  const startNode: PathNode = {
    x: start.x, y: start.y, g: 0,
    h: heuristic(start, goal), f: 0, parent: null,
  };
  startNode.f = startNode.g + startNode.h;
  openSet.push(startNode);

  while (!openSet.isEmpty) {
    const current = openSet.pop()!;           // 取出 f 最小的节点
    const key = `${current.x},${current.y}`;

    if (current.x === goal.x && current.y === goal.y)
      return reconstructPath(current);        // 到达终点

    if (visited.has(key)) continue;           // 懒删除：跳过已处理的重复项
    visited.add(key);

    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nx = current.x + dx, ny = current.y + dy;
      if (!isWalkable(grid, nx, ny) || visited.has(`${nx},${ny}`)) continue;

      const g = current.g + 1;                // 均匀地形代价为 1
      const h = heuristic({x:nx,y:ny}, goal);
      openSet.push({ x: nx, y: ny, g, h, f: g + h, parent: current });
    }
  }
  return null; // 无路径
}

// 曼哈顿距离（4 方向移动的启发式）
function heuristic(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
```

**3. 优先队列 vs 其他结构的性能对比**

| 操作 | 排序数组 | 无序数组 | 二叉堆 | 斐波那契堆 |
|------|---------|---------|--------|-----------|
| **插入** | O(n)（需搬移） | O(1) | O(log n) | O(1) 均摊 |
| **取出最值** | O(1) | O(n)（需扫描） | O(log n) | O(log n) 均摊 |
| **查看最值** | O(1) | O(n) | O(1) | O(1) |
| **decrease-key** | O(n) | O(1)+标记 | O(log n) | O(1) 均摊 |
| **A* 1000 节点** | ~15ms | ~45ms | ~0.3ms | ~0.2ms |
| **适用场景** | 一次性排序 | 插入多取值少 | 通用最佳 | 理论最优，实现极复杂 |
| **JS 实现难度** | 简单 | 简单 | 中等 | 极高 |

### ⚡ 实战经验

- **懒删除优于 decrease-key**：A* 寻路中同一个节点可能被多次入队（发现更短的 g 值时），用「懒删除」策略——不修改堆中已有元素，而是直接 push 新版本，pop 时用 `visited` Set 跳过已处理的旧版本。实现简单且实际性能更好（避免索引堆的维护开销），代价是堆中可能有少量冗余节点，但对 1000 节点的寻路影响可忽略。
- **堆退化成链表是隐蔽 Bug**：早期实现用了 `Math.random()` 作为比较器的 tie-breaker（两个 f 值相等时随机返回），结果破坏了堆的传递性（a < b, b < c 但 a > c），堆操作退化成 O(n)。正确做法是 f 值相等时按插入顺序（用一个自增 id 字段）稳定排序，保证堆性质不被破坏。
- **定时器系统从数组扫描迁移到优先队列**：项目里有 800+ 个延迟回调（技能冷却、buff 到期、延迟爆炸），原来每帧遍历整个数组检查 `currentTime >= callback.triggerTime`，每帧消耗 0.4ms。换成最小堆（按 triggerTime 排序）后，每帧只检查堆顶，降为 0.02ms，帧预算腾出了 0.38ms 给渲染。
- **对象池配合优先队列避免 GC**：A* 寻路每帧频繁 `push/pop` 产生大量 `PathNode` 临时对象，在移动端触发频繁 GC 导致卡顿。给 `PathNode` 加对象池——`pop` 时节点回收到池中，`push` 时从池中取——GC 频率从每秒 3 次降到 0。
- **优先队列不保证整体有序**：优先队列只保证堆顶是最值，不保证中间元素有序。有同事误用优先队列做 Top-10 排行榜（期望取 10 次就是前 10 名），实际上每次 pop 后堆会重新调整，取出的 10 个虽然按序但中间有大量未被访问的节点。排行榜用排序数组或跳表（Skip List）更合适。

### 🔗 相关问题

1. 当 A* 的启发函数 `h(n)` 不可采纳（高估实际代价）时，寻路结果会怎样？优先队列的行为是否受影响？
2. 如何用索引堆（Indexed Heap）实现 O(1) 定位堆中任意元素并执行 decrease-key？这在 Dijkstra 中有什么优势？
3. 多线程环境下，优先队列如何保证线程安全？无锁优先队列（Lock-Free Heap）是否可行？
