---
title: "不可变数据结构与结构共享（Persistent Data Structures）怎么用？"
category: "programming"
level: 3
tags: ["不可变数据结构", "结构共享", "HAMT", "函数式编程", "状态管理"]
related: ["programming/command-pattern-undo-redo", "programming/deterministic-simulation-replay", "programming/closure-memory-leak"]
hint: "每次修改都返回新对象听起来很浪费——结构共享如何让「不可变」几乎零拷贝，支撑撤销/重做、录像回放、状态时间旅行？"
---

## 参考答案

### ✅ 核心要点

1. **不可变（Immutable）= 修改不就地改写，而是返回新版本**：一个对象一旦创建就不再变化，「修改」操作产生一个新对象，旧对象保持原样。好处是极度可预测：任何持有旧引用的人都看到一致的数据，没有「被别人偷偷改了」的并发惊吓。这是撤销/重做、录像回放、响应式 UI、确定性帧同步的共同底座。
2. **结构共享（Structural Sharing）是零拷贝的关键**：朴素实现「每次修改深拷贝整个对象」是 O(n) 的灾难。结构共享的做法是把数据组织成树（Trie/链表），修改时**只复制从根到修改点的路径**，其余子树直接复用旧节点的引用。这样一次「拷贝」只花 O(log n)，而新旧版本共享 99% 的内存。
3. **HAMT（Hash Array Mapped Trie）是工业级实现**：Immer、Immutable.js、Clojure 的持久化 Map 都用 HAMT——用键的哈希位分段（每段 5 bit，对应 32 叉）做 Trie，深度被压到 log₃₂(n)，万级键也只需 2~3 层。插入/查找近似 O(1)，且天然支持历史版本共存。
4. **游戏中的杀手级应用是「廉价快照」**：撤销栈不再存深拷贝（内存爆炸）或命令 diff（实现复杂），而是直接存「不可变状态的引用」——每个历史状态因结构共享只占增量内存。同理，录像回放可以每隔几帧存一个状态快照（checkpoint），随机跳转时从最近的快照重放，状态体积可控。
5. **引用相等（`===`）成了变更检测的性能利器**：因为不可变，`newState === oldState` 当且仅当真的没变。UI 框架（React、Solid）和 memoization 用这个做 O(1) 的「是否需要重渲染/重计算」判断——mutable 对象每次都像变了，反而无法做这种剪枝。
6. **权衡：别在每帧热循环里用**：不可变写入有「路径复制 + 分配」的常数开销，在每帧更新上万实体的热路径上会产生巨大 GC 压力。正确姿势是热循环用 mutable 累积，帧末一次性「冻结/快照」成不可变版本供读取层（UI、录像、网络同步）使用——可变求性能、不可变求正确性。

### 📖 深度展开

#### 1. 结构共享图解：修改一个元素只复制一条路径

```
持久化向量（32 叉 Trie），修改 index=35 的元素：

旧版本 v0:                  新版本 v1（只复制高亮路径）:
   root                        root'  ← 新根
   / \                        /   \
 [0..31] [32..63]          [0..31] [32..63]'  ← 复制
            |                          |
         叶子[32..63]              叶子'[32..63]  ← 复制，仅改 index 35
            ↓ 其余不变               ↓ 复用旧叶子的兄弟节点引用

复制量 = 树深 = log₃₂(n)。万级数据深 3 层，复制 3 个节点 + 1 个新叶子，
其余成千上万个节点全部与 v0 共享同一份内存。
旧引用 v0 仍完好 → 可放进撤销栈，零额外内存。
```

#### 2. HAMT 风格的持久化 Map（简化实现）

```typescript
// 32 叉 Trie 节点。 immutable.js / immer 的核心思想简化版
const BITS = 5, WIDTH = 1 << BITS, MASK = WIDTH - 1; // 32

class HamtNode<K, V> {
  constructor(
    public entries: Array<[K, V] | HamtNode<K, V>> = new Array(WIDTH),
    public hash = 0, public shift = 0,
  ) {}
  // 用 hash 的 shift~shift+5 位决定走哪个槽
  private idx(h: number): number { return (h >>> this.shift) & MASK; }

  set(key: K, val: V, h: number): HamtNode<K, V> {
    const i = this.idx(h);
    const child = this.entries[i];
    // 叶子：直接存；内部节点：递归并复制该子树（结构共享其余槽）
    const newChild = child instanceof HamtNode
      ? child.set(key, val, h)
      : (child && child[0] === key ? child : [key, val] as [K, V]);
    const next = this.entries.slice();       // O(32) 浅拷贝当前层
    next[i] = newChild;
    return new HamtNode(next, this.hash, this.shift); // 返回新节点，旧节点不动
  }
  // 注意：旧节点 this 完全不变，调用方持有旧引用依然有效
}
// 复杂度：set/get = O(log₃₂ n) ≈ O(1)；n=10^6 时仅 ~4 层
```

#### 3. 用结构共享实现撤销/录像快照

```typescript
// 游戏状态用不可变结构，撤销栈只存引用——内存几乎不增
type GameState = ReturnType<typeof makeImmutable>; // HAMT 包装

class TimeTravel {
  private past: GameState[] = [];
  private future: GameState[] = [];
  constructor(private current: GameState) {}

  commit(next: GameState): void {      // next 与 current 结构共享
    this.past.push(this.current);       // 旧状态入栈，增量内存 ≈ 修改路径
    this.current = next;
    this.future.length = 0;
  }
  undo(): void {
    const prev = this.past.pop(); if (!prev) return;
    this.future.push(this.current);
    this.current = prev;                 // O(1) 切换，无深拷贝
  }
  // 录像：每隔 30 帧存一个快照做 checkpoint，随机跳转从最近 checkpoint 重放
  snapshotEveryNFrames(state: GameState, frame: number): void {
    if (frame % 30 === 0) this.checkpoints.push(state); // 结构共享，廉价
  }
}
```

#### 4. 状态管理方案对比

| 方案 | 写入开销 | 读取历史版本 | 内存 | 典型场景 |
|------|---------|-------------|------|---------|
| 就地可变（mutable） | **O(1)** | 不可能（被覆盖） | 低 | 每帧热循环、物理模拟 |
| 深拷贝快照 | O(n) | 可以 | **爆炸** | 简单存档，不可扩展 |
| 命令模式 diff | O(1) | 回放重建 | 低 | 编辑器撤销，实现复杂 |
| **不可变+结构共享** | O(log n) | **O(1) 引用** | 增量 | 撤销栈、录像、UI 状态 |
| Immer produce | O(改动量) | 草稿+冻结 | 增量 | 兼顾可写语法与不可变结果 |

### ⚡ 实战经验

- **热路径坚决别用不可变**：曾把每帧的实体位置更新从 `pos.x += vx` 改成 Immer 的 `produce`，3000 个实体每帧产生 3000 个新对象，GC 帧时间从 2ms 飙到 18ms 直接掉帧。解法：模拟层全程 mutable，仅把「要给 UI/录像/网络看」的状态在帧末冻结成不可变快照，热循环零分配。
- **撤销栈别存深拷贝**：早期编辑器撤销用 `JSON.parse(JSON.stringify(state))`，改 10 步后内存涨到几百 MB。换成结构共享的不可变状态后，1000 步历史只占几 MB——因为每步只新增「被改路径」的节点，其余全部共享。这是结构共享最直观的收益。
- **用 `===` 做 memoization 剪枝**：技能 UI 监听 `playerState`，用不可变结构后 `if (newState.equipment === prev.equipment) return;` 能 O(1) 跳过没变的子树重渲染。mutable 状态做不到这点——每次引用都「像变了」，被迫深比较或全量刷新。
- **颗粒度决定收益**：一个装 1000 件物品的背包整体做成不可变，改一件要复制整条路径，不如按「背包→格子」分层，只让被改的格子产生新节点。颗粒度太粗结构共享退化成接近深拷贝，太细则节点开销吞噬收益，按「逻辑变更单元」划分最划算。

### 🔗 相关问题

- Immer 的 `produce` 如何用 ES6 Proxy 让你「像写可变代码一样」得到不可变结果？底层拷贝策略是什么？
- 确定性帧同步中，如何用不可变状态保证「相同输入→完全相同状态」，避免浮点/引用导致的 desync？
- 持久化线段树（Persistent Segment Tree）和 HAMT 在「历史版本共存」上思路相通，如何用它做可持久化区间查询？
