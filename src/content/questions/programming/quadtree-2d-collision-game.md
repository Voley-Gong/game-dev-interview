---
title: "2D游戏碰撞检测为什么用四叉树？它和空间哈希网格如何选择？"
category: "programming"
level: 2
tags: ["数据结构", "碰撞检测", "四叉树", "空间划分", "2D", "性能优化"]
related: ["programming/bvh-bounding-volume-hierarchy-game", "programming/spatial-hash-grid-game", "programming/data-structures-game", "programming/object-pool-game"]
hint: "100 个敌人两两碰撞是 5000 次——但 99% 根本不在附近。四叉树把 2D 空间递归四等分，只检测同一子空间的物体，把 O(n²) 砍到接近 O(n log n)。它是 2D 弹幕、MOBA、平台跳跃的事实标准。"
---

## 参考答案

### ✅ 核心要点

1. **碰撞检测必须分两阶段：Broadphase 粗筛 + Narrowphase 精算**：n 个物体两两配对是 O(n²)，200 个敌人就是近 2 万对，其中绝大多数隔了半个屏幕根本碰不到。Broadphase 用廉价的 AABB（轴对齐包围盒）快速排除不可能相交的对，只把"可能碰撞"的少数送进 Narrowphase 做精确检测。四叉树是 2D Broadphase 最常用的数据结构，它决定了送进窄相的对数，是性能主战场。
2. **四叉树递归四等分空间，自适应密度分布**：从整个场景边界开始，当某区域物体超过容量阈值就四等分（左上/右上/左下/右下），子区域满了再四等分。结果是密集区域（敌人扎堆）会深分到很多层，稀疏区域（空地）只有一层——这种"按需分裂"让查询自动适应物体分布。查询时只检测目标所在子空间及邻居子空间，平均 O(log n)。
3. **四叉树 vs 均匀网格：分布不均时四叉树完胜**：均匀网格把空间切成固定大小格子，物体分布均匀时查询 O(1) 极快；但敌人全挤在屏幕一角时，那一格塞了几百个物体变成局部 O(n²)，而空格全是浪费。四叉树在密集区自动细分缓解热点，稀疏区不分层不浪费——这就是 2D 动态场景（敌人会移动、聚集、分散）普遍选四叉树的原因。
4. **动态场景的更新策略决定生死**：物体每帧移动，四叉树需要更新。① **懒重建**：每帧清空整树重新插入所有物体（O(n log n)），实现最简单，移动场景常用——只要 n 不极端，每帧重建比增量维护更快更不易出错；② **增量更新**：物体移动后 remove + reinsert，O(log n)，适合少量移动；③ **深度/容量限制**：防止极端密集时无限分裂。绝大多数 2D 游戏用"每帧整树重建"就够了。
5. **容量阈值和最大深度是关键调参**：容量（每节点最多存几个物体才分裂）太小则树太深、查询要下钻多层；太大则单节点物体多、退化成暴力遍历。经验值：容量 4-10，最大深度 5-8（2^8=256 个最细格子够用）。物体直径差异大时还要限制最小格子尺寸，否则小物体把树钻太深。调参没有银弹，必须用实际场景的对象数量和分布 profile 校准。
6. **跨界物体要特殊处理避免漏检**：物体正好在分界线上、或大到横跨多个子空间，只放进一个子空间会导致与邻居子空间物体的碰撞漏检。解法：① 物体同时插入所有相交的叶子节点（查询会去重）；② 限制子空间不分裂到比物体还小。跨界处理不当会产生"明明撞上了却没检测到"的诡异 bug，这是四叉树最隐蔽的坑。

### 📖 深度展开

**1. 四叉树的 TypeScript 实现（插入 + 范围查询）**

```typescript
interface AABB { x: number; y: number; w: number; h: number; } // 轴对齐包围盒
interface HasBox { box: AABB; id: number; }

class QuadTree {
  private objects: HasBox[] = [];     // 本节点存的物体（仅叶子节点）
  private children: QuadTree[] | null = null; // 分裂后的4个子节点
  constructor(private bounds: AABB, private capacity = 8, private depth = 0, private maxDepth = 6) {}

  insert(obj: HasBox): void {
    if (!aabbIntersect(obj.box, this.bounds)) return;     // 不在本区域，不插
    if (this.children) {                                    // 已分裂，委托子节点
      for (const c of this.children) c.insert(obj);
      return;
    }
    this.objects.push(obj);
    if (this.objects.length > this.capacity && this.depth < this.maxDepth) {
      this.split();                                         // 超容量，四等分
      for (const o of this.objects) for (const c of this.children!) c.insert(o); // 下放
      this.objects = [];                                    // 内部节点不再存物体
    }
  }

  private split(): void {
    const { x, y, w, h } = this.bounds, hw = w/2, hh = h/2, d = this.depth+1;
    this.children = [
      new QuadTree({x, y, w:hw, h:hh}, this.capacity, d, this.maxDepth),       // 左上
      new QuadTree({x:x+hw, y, w:hw, h:hh}, this.capacity, d, this.maxDepth),  // 右上
      new QuadTree({x, y:y+hh, w:hw, h:hh}, this.capacity, d, this.maxDepth),  // 左下
      new QuadTree({x:x+hw, y:y+hh, w:hw, h:hh}, this.capacity, d, this.maxDepth), // 右下
    ];
  }

  // 查询：返回与 queryBox 相交的所有物体（碰撞配对的核心）
  query(box: AABB, out: HasBox[] = [], seen = new Set<number>()): HasBox[] {
    if (!aabbIntersect(box, this.bounds)) return out;       // 整个子树剪枝
    if (this.children) { for (const c of this.children) c.query(box, out, seen); return out; }
    for (const o of this.objects) {                         // 叶子：逐个检测
      if (!seen.has(o.id) && aabbIntersect(box, o.box)) { out.push(o); seen.add(o.id); } // 去重
    }
    return out;
  }
}
// 用法：每帧 clear() → 重新插入所有敌人 → 对每个敌人 query 拿候选碰撞对
```

**2. 四叉树 vs 均匀网格 vs BVH 横向对比**

```
同一场景（200 敌人，左下角聚集）的三种 Broadphase 行为：

均匀网格：                    四叉树：                    BVH：
全图均匀切格子                密集区深分/稀疏区不分        按物体组织的包围盒树
左下格塞 180 个→局部 O(n²)    左下自动分6层→每叶≤8个        按质心组织，查询O(log n)
右上 90% 空格浪费             无浪费                       无空间浪费
查询：热点区域退化            查询：稳定 O(log n)          查询：稳定 O(log n)
```

| 方案 | 构建 | 查询 | 适应分布 | 动态更新 | 典型场景 |
|------|------|------|---------|---------|---------|
| **暴力遍历** | 无 | O(n²) | 不限 | 无成本 | n<30，调试 |
| **均匀网格** | O(n) | O(k)邻居 | ❌ 需均匀 | 移动重哈希 | ✅ 2D 弹幕、塔防（分布均匀） |
| **四叉树** | O(n log n) | O(log n+k) | ✅ 自适应 | 每帧重建/增量 | ✅ 2D MOBA、RTS、平台跳跃 |
| **BVH** | O(n log n) | O(log n) | ✅ 任意 | remove+reinsert | ✅ 3D 动态首选 |

**3. 动态四叉树：每帧重建的工程实践**

```typescript
// 绝大多数 2D 游戏的最佳实践：每帧 clear + 重新插入，简单且够快
class CollisionSystem {
  private tree = new QuadTree(WORLD_BOUNDS, 8, 0, 6);
  update(entities: Entity[]): CollisionPair[] {
    this.tree.clear();                                      // 清空，不销毁结构
    for (const e of entities) this.tree.insert(e);          // 重新插入 O(n log n)
    const pairs: CollisionPair[] = [];
    const seen = new Set<string>();
    for (const e of entities) {
      const candidates = this.tree.query(e.box);            // 每个物体查候选碰撞者
      for (const c of candidates) {
        if (c.id <= e.id) continue;                         // 避免重复 (A,B) 和 (B,A)
        const key = `${e.id}-${c.id}`;
        if (!seen.has(key) && narrowPhase(e, c)) { seen.add(key); pairs.push([e, c]); }
      }
    }
    return pairs; // 送入物理/伤害结算
  }
}
// 200 敌人场景：暴力 19900 对 → 四叉树候选 ~600 对 → 窄相后真实碰撞 ~80 对
```

### ⚡ 实战经验

- **容量阈值开太大退化成暴力遍历**：早期把容量设为 50 试图"减少分裂开销"，结果 200 个敌人全挤在根节点的 objects 数组里（从未触发分裂），query 每次遍历全部 200 个，等于没分。实测容量 4-8 时查询最快。容量本质是"何时值得分裂"的阈值——太小则下钻开销大，太大则失去划分意义，必须 profile。
- **不设最大深度导致树钻到无限深**：敌人集中在一点时四叉树疯狂分裂，深度飙到 30 层，每层都是几乎重叠的微小区域，查询要下钻 30 次还查不到几个物体，性能比暴力还差。加 `maxDepth=6` 限制后，最细格子 = 世界/64，极端密集时退化但不会爆炸。maxDepth 要根据世界尺寸和物体最小直径设置。
- **跨界物体漏检碰撞**：大尺寸 Boss 的 AABB 横跨四个子区域，只插入了一个子节点，结果只检测到该子区域内的碰撞，另一侧的敌人撞上来没触发。改为"物体插入所有相交叶子节点 + 查询时用 id 去重"后修复。跨界处理是四叉树最隐蔽的 bug，测试时务必覆盖"物体正好在分界线"的场景。
- **每帧重建 GC 压力**：每帧 clear 重建会产生大量临时数组（子节点、objects 数组），200 敌人每帧产生约 50KB 垃圾，移动端 GC 尖峰明显。解法：用对象池复用 QuadTree 节点（clear 时归零而非销毁，重建时从池取），GC 频率降为 0。四叉树节点数量稳定（最多 4^6 个），非常适合池化。
- **四叉树不如网格快的场景**：纯弹幕游戏（东方Project类）敌人分布极其均匀且数量巨大（500+），均匀网格的 O(1) 查询比四叉树的 O(log n) 快约 30%。曾统一用四叉树后弹幕帧时间从 2ms 涨到 3ms，换回均匀网格后恢复。教训：分布均匀且密集选网格，分布不均或动态聚集选四叉树，没有万能结构。

### 🔗 相关问题

1. 当 2D 场景中有大量高速移动的子弹（每帧位移大于自身尺寸）时，离散的四叉树查询会漏掉"穿越"碰撞（tunneling）。连续碰撞检测（CCD/射线扫掠）如何与四叉树结合——用子弹的"运动线段"而非点来查询？
2. 四叉树在 3D 自然扩展为八叉树，但 3D 游戏普遍选 BVH 而非八叉树（参考 BVH 一题）。2D 为什么反而四叉树比 2D-BVH 更常见——是因为 2D 空间维度低、分裂成本低，还是 2D 物体分布特性使然？
3. 如果场景同时有"超大物体"（Boss 占半个屏幕）和"超小物体"（子弹几个像素），四叉树很难兼顾——大物体横跨太多叶子导致重复插入，小物体把树钻太深。是否该用"双结构"（大物体走 BVH、小物体走网格/四叉树）分层管理？
