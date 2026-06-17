---
title: "线段树（Segment Tree）如何高效处理游戏中的区间查询？"
category: "programming"
level: 3
tags: ["线段树", "数据结构", "区间查询", "性能优化"]
related: ["programming/skip-list-leaderboard", "programming/priority-queue-binary-heap"]
hint: "排行榜区间排名、范围技能批量伤害、属性区间修改——这些 O(n) 操作如何变 O(log n)？"
---

## 参考答案

### ✅ 核心要点

1. **线段树把数组区间操作降到 O(log n)**：用一棵二叉树把长度为 n 的数组划分为若干区间段，每个节点维护一段区间的聚合信息（和、最值、计数），查询和修改只需访问 O(log n) 个节点。
2. **核心操作三件套**：`build`（O(n) 建树）、`update`（O(log n) 单点修改）、`query`（O(log n) 区间查询），适用于需要**频繁修改 + 频繁查询**的动态场景。
3. **Lazy 延迟标记是进阶关键**：区间批量修改（如给一段玩家加 buff）若逐点更新是 O(n)，引入懒标记（Lazy Propagation）把修改「记账」延迟到必须下探时，区间更新也降到 O(log n)。
4. **游戏中的高频应用**：排行榜某分段内的玩家计数、地图矩形区域的最大伤害值、活动期间某时间段在线人数统计、批量给一段敌人施加易伤 debuff。
5. **选型要看场景**：只求前缀和用树状数组（Fenwick Tree，常数更小）；区间最值且不改数据用稀疏表（ST 表，O(1) 查询）；既要改又要查区间聚合，才是线段树的主场。

### 📖 深度展开

#### 1. 基础线段树：单点修改 + 区间求和

```typescript
class SegmentTree {
  private tree: number[];   // 用 1-indexed 数组存树，节点 i 的子节点是 2i、2i+1
  private n: number;

  constructor(data: number[]) {
    this.n = data.length;
    this.tree = new Array(4 * this.n); // 安全上界 4n
    this.build(data, 1, 0, this.n - 1);
  }

  private build(data: number[], node: number, l: number, r: number): void {
    if (l === r) { this.tree[node] = data[l]; return; } // 叶子
    const mid = (l + r) >> 1;
    this.build(data, node << 1, l, mid);
    this.build(data, node << 1 | 1, mid + 1, r);
    this.tree[node] = this.tree[node << 1] + this.tree[node << 1 | 1]; // 上推
  }

  /** 单点修改：data[index] = value */
  update(index: number, value: number, node = 1, l = 0, r = this.n - 1): void {
    if (l === r) { this.tree[node] = value; return; }
    const mid = (l + r) >> 1;
    if (index <= mid) this.update(index, value, node << 1, l, mid);
    else this.update(index, value, node << 1 | 1, mid + 1, r);
    this.tree[node] = this.tree[node << 1] + this.tree[node << 1 | 1];
  }

  /** 区间查询 [ql, qr] 的和 */
  query(ql: number, qr: number, node = 1, l = 0, r = this.n - 1): number {
    if (qr < l || r < ql) return 0;            // 完全不相交
    if (ql <= l && r <= qr) return this.tree[node]; // 完全包含，直接返回
    const mid = (l + r) >> 1;
    return this.query(ql, qr, node << 1, l, mid)
         + this.query(ql, qr, node << 1 | 1, mid + 1, r);
  }
}
```

#### 2. 区间结构可视化

```
数组: [3, 1, 4, 1, 5, 9, 2, 6]   (n=8)

线段树（每个节点存区间和）：
                     [0,7]=31
                   /            \
             [0,3]=9              [4,7]=22
            /       \             /        \
       [0,1]=4   [2,3]=5    [4,5]=14   [6,7]=8
       /    \     /    \     /    \     /    \
     [0]=3 [1]=1 [2]=4 [3]=1 [4]=5 [5]=9 [6]=2 [7]=6

查询区间 [2, 5] 的和：
  命中 [2,3]=5（完全包含）+ 进入 [4,5] → [4]=5 + [5]=9
  = 5 + 14 = 19   只访问 3 个节点，而非遍历 4 个元素
```

#### 3. Lazy 延迟标记：区间批量加 buff

```typescript
class LazySegmentTree {
  private tree: number[];
  private lazy: number[]; // 待下传的增量
  private n: number;
  // ... 构造同上，lazy 数组初始化为 0

  /** 区间 [ql,qr] 每个元素 + val（例如给一段敌人加攻击力 debuff） */
  rangeAdd(ql: number, qr: number, val: number,
           node = 1, l = 0, r = this.n - 1): void {
    this.pushDown(node, l, r);              // 先下传历史懒标记
    if (qr < l || r < ql) return;
    if (ql <= l && r <= qr) {
      this.tree[node] += val * (r - l + 1); // 整段累加
      this.lazy[node] += val;               // 记账，暂不下传
      return;
    }
    const mid = (l + r) >> 1;
    this.rangeAdd(ql, qr, val, node << 1, l, mid);
    this.rangeAdd(ql, qr, val, node << 1 | 1, mid + 1, r);
    this.tree[node] = this.tree[node << 1] + this.tree[node << 1 | 1];
  }

  private pushDown(node: number, l: number, r: number): void {
    if (this.lazy[node] !== 0) {
      const mid = (l + r) >> 1;
      const v = this.lazy[node];
      this.applyChild(node << 1, l, mid, v);
      this.applyChild(node << 1 | 1, mid + 1, r, v);
      this.lazy[node] = 0; // 清账
    }
  }
  private applyChild(node: number, l: number, r: number, v: number) {
    this.tree[node] += v * (r - l + 1);
    this.lazy[node] += v;
  }
}
```

#### 4. 区间数据结构选型对比

| 数据结构 | 建树 | 单点改 | 区间改 | 区间查 | 适用场景 |
|----------|------|--------|--------|--------|----------|
| 前缀和数组 | O(n) | O(n) | O(n) | **O(1)** | 静态数据、不修改 |
| 树状数组 (BIT) | O(n) | **O(log n)** | 需差分 | **O(log n)** | 只需前缀和、常数极小 |
| 稀疏表 (ST表) | O(n log n) | 不支持 | 不支持 | **O(1)** | 静态区间最值 |
| 线段树 | O(n) | **O(log n)** | **O(log n)** | **O(log n)** | 动态、可改可查、最通用 |
| 平衡树 (Splay) | O(n log n) | O(log n) | O(log n) | O(log n) | 需要分裂/合并、复杂度高 |

### ⚡ 实战经验

- **别用线段树解决所有区间问题**：曾见过团队给一个只有 50 个元素、从不修改的排行榜上线段树，实际前缀和数组查询 O(1) 更快且代码量少 80%。选型先问：数据是否动态？查询是否频繁？
- **数组开 4n 不是浪费**：线段树最坏需要约 4n 空间（2 的幂次对齐导致）。只开 2n 会越界，这种 bug 在压测时才暴露——曾有线上崩溃是因为排行榜扩容后数组越界写入。
- **Lazy 标记的 pushDown 时机**：每次进入节点前必须先 `pushDown`，否则会读到未更新的旧值。漏掉一处 pushDown 是线段树 bug 最常见的来源，建议封装成统一入口强制调用。
- **排行榜区间排名考虑离线化**：实时维护万级玩家排行榜的「某分段人数」用线段树没问题，但如果只关心 Top 100，用跳跃表或最小堆维护窗口更省内存，线段树适合需要任意区间统计的场景。

### 🔗 相关问题

- 树状数组（Fenwick Tree）和线段树在排行榜场景下如何取舍？
- 如何用线段树实现「动态求全局第 K 小」（权值线段树）？
- 二维线段树如何处理矩形区域（如地图 AABB 范围伤害）的聚合查询？
