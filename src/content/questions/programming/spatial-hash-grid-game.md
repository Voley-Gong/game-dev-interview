---
title: "空间哈希网格如何加速 2D 碰撞检测？和四叉树比什么时候该用哪个？"
category: "programming"
level: 2
tags: ["数据结构", "空间划分", "碰撞检测", "海量实体", "性能优化"]
related: ["programming/data-structures-game", "programming/priority-queue-binary-heap", "programming/object-pool"]
hint: "四叉树不是万能的——当实体分布均匀、数量稳定、查询频繁时，空间哈希网格更简单更快。把世界切成格子，实体按坐标哈希进格子，查询只看相邻 9 格。"
---

## 参考答案

### ✅ 核心要点

1. **空间哈希网格核心是\"把连续空间离散化成格子，用哈希 O(1) 定位\"**：把 2D 世界切成固定大小的方格（cell），每个实体根据坐标算出所在格子的 `(col, row)`，用 `hash(col, row) = col + row * cols` 映射到桶（bucket）。查询某实体附近的敌人时，只遍历它所在格子及周围 8 个格子（3×3 邻域），而不是全场景所有实体。暴力遍历是 O(n²)，哈希网格降到接近 O(k)（k 是邻域内实体数）。
2. **格子大小的选择是核心 trade-off**：格子太大，每格塞太多实体，查询变慢（退化成暴力遍历）；格子太小，实体跨多个格子，插入/查询要处理多个桶，哈希开销和桶数量膨胀。经验法则：格子边长 ≈ 实体平均尺寸 × 1~2，或 ≈ 查询半径。弹幕游戏子弹小而密，用小格子；MOBA 单位少而大，用大格子。
3. **插入删除 O(1)，但移动要重新哈希**：实体每帧移动后位置变了，要从旧格子移除、插入新格子。这是哈希网格的主要维护成本。优化：用"脏标记 + 批量重建"（每帧不增量更新，而是清空重建整个网格，移动密集时反而更快）、或"懒删除"（移动时只标记，查询时过滤失效项，定期压缩）。
4. **与四叉树各有适用场景，不是替代关系**：四叉树递归细分空间，适合实体分布不均（密集区自动细分、稀疏区保持粗粒度），但实现复杂、平衡/重建开销大；哈希网格结构固定、实现简单、常数因子小，适合实体分布相对均匀、查询极其频繁的场景。动态分布（一会儿密集一会儿稀疏）用四叉树，稳定分布（弹幕、塔防、AOE 技能）用哈希网格。
5. **游戏典型场景：碰撞检测、范围技能、视野查询、AI 感知、流式加载**：弹幕/射击游戏（子弹 vs 敌人碰撞）、塔防（塔的射程内找敌人）、MOBA（技能范围伤害判定）、RTS（单位集群移动避让）、AOE 技能（圆形范围内的所有目标）、网络同步（只同步视野内玩家）。空间哈希是 2D 游戏里最常用的空间索引，3D 对应的是均匀网格（Uniform Grid）。

### 📖 深度展开

**1. 空间哈希网格的完整实现**

```typescript
// 空间哈希网格：用 Map 存格子→实体列表的映射
class SpatialHashGrid<T extends { x: number; y: number; radius: number }> {
  private cellSize: number;
  private buckets = new Map<number, T[]>();  // key=hash, value=该格子内的实体

  constructor(cellSize: number) { this.cellSize = cellSize; }

  // 坐标 → 格子坐标 → 哈希 key
  private hash(x: number, y: number): number {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    return col * 73856093 ^ row * 19349663;  // 负载均衡的混合哈希
  }

  // 插入：O(1)
  insert(entity: T): void {
    const key = this.hash(entity.x, entity.y);
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = []; this.buckets.set(key, bucket); }
    bucket.push(entity);
  }

  // 查询邻域：只看 3×3 格子，而非全场景
  // 返回距离 query 半径内的所有实体，用于碰撞/范围伤害
  queryNearby(qx: number, qy: number, radius: number): T[] {
    const result: T[] = [];
    const minCol = Math.floor((qx - radius) / this.cellSize);
    const maxCol = Math.floor((qx + radius) / this.cellSize);
    const minRow = Math.floor((qy - radius) / this.cellSize);
    const maxRow = Math.floor((qy + radius) / this.cellSize);
    // 遍历覆盖范围内的所有格子（不只是 3×3，按 radius 自适应）
    for (let col = minCol; col <= maxCol; col++) {
      for (let row = minRow; row <= maxRow; row++) {
        const key = col * 73856093 ^ row * 19349663;
        const bucket = this.buckets.get(key);
        if (!bucket) continue;
        for (const e of bucket) {
          const dx = e.x - qx, dy = e.y - qy;
          if (dx * dx + dy * dy <= radius * radius) result.push(e);  // 精确距离过滤
        }
      }
    }
    return result;
  }

  // 每帧重建：清空重新插入（移动密集时比增量更新快）
  rebuild(entities: T[]): void {
    this.buckets.clear();
    for (const e of entities) this.insert(e);
  }
}

// 使用：1000 个敌人的塔防，塔要找射程内的敌人
const grid = new SpatialHashGrid<Enemy>(64);  // 格子 = 射程附近
for (const enemy of allEnemies) grid.insert(enemy);
// 每个塔查询射程内敌人，O(邻域) 而非 O(全场)
for (const tower of towers) {
  const targets = grid.queryNearby(tower.x, tower.y, tower.range);
  if (targets.length) tower.attack(targets[0]);
}
```

**2. 空间哈希网格 vs 四叉树 vs 暴力遍历**

```
碰撞检测性能对比（1000 个实体，查询 1 次邻域）：

暴力遍历 O(n²)：           空间哈希网格 O(k)：        四叉树 O(log n + k)：
遍历全部 1000 个            只看 9 格 ~30 个            沿树下降到叶子 ~10 个
┌───────────────┐          ┌───┬───┬───┐              ┌───────────────┐
│ ●  ●     ●    │          │   │ ● │   │ ◄ 查询格     │    ┌────┬───┐ │
│    ●  ◯查询   │          ├───┼───┼───┤              │  ┌─┴──┐ │   │ │
│ ●        ●  ●│          │ ● │ ◯ │ ● │              │  │●●  │ │   │ │
│   ●    ●     │          ├───┼───┼───┤              │  └────┘ │   │ │
│ ●     ●   ●  │          │   │ ● │   │              │    ┌───┴───┐ │
└───────────────┘          └───┴───┴───┘              └────┴───────┘─┘
每查询检查 1000 个          每查询检查 ~30 个           每查询检查 ~10 个
1000 次查询 = 100 万次      1000 次查询 = 3 万次        1000 次查询 = 1 万次
```

| 维度 | 暴力遍历 | 空间哈希网格 | 四叉树 |
|------|---------|-------------|--------|
| **查询复杂度** | O(n) | O(k)，k=邻域实体数 | O(log n + k) |
| **插入复杂度** | O(1)（追加） | O(1)（哈希） | O(log n)（下降到叶子） |
| **实现复杂度** | 极低 | 低（~50 行） | 高（递归/平衡/重建） |
| **内存开销** | 无额外 | 桶数组 | 树节点指针 |
| **分布适应性** | 不受影响 | 固定格子，密集区退化 | 自动细分，适应任意分布 |
| **动态更新成本** | 无 | 移动要重新哈希 | 移动要删除+重新插入，可能触发平衡 |
| **常数因子** | 大 | 小（哈希+数组访问） | 中（指针跳转/递归） |
| **典型游戏场景** | 实体 <50 | 弹幕、塔防、均匀分布 | 开放世界、动态聚集分散 |

**3. 格子大小的选择：经验法则与实测调优**

```typescript
// 格子大小直接影响性能，三种常见取值策略：

// 策略 A：格子 = 查询半径（最常用）
// 邻域查询只需 3×3=9 格，查询覆盖刚好
const gridA = new SpatialHashGrid(enemySearchRadius);

// 策略 B：格子 = 实体平均直径（碰撞检测常用）
// 每个实体最多跨 1~2 格，插入开销可控
const avgSize = entities.reduce((s, e) => s + e.radius * 2, 0) / entities.length;
const gridB = new SpatialHashGrid(avgSize);

// 策略 C：自适应分层（多层次网格）
// 大实体进大格子网格，小实体进小格子网格，查询时合并结果
class MultiLevelGrid {
  coarse: SpatialHashGrid<LargeEntity>;   // 大单位（BOSS、建筑）
  fine: SpatialHashGrid<SmallEntity>;     // 小单位（子弹、特效）
  queryNearby(x, y, r) {
    return [...this.coarse.query(x, y, r), ...this.fine.query(x, y, r)];
  }
}
```

```
格子大小对性能的影响（1000 实体，固定查询半径 60px）：

格子=20px (太小)：         格子=60px (刚好)：         格子=200px (太大)：
每格~1个实体，桶数多       每格~5个实体，桶数适中     每格~100个实体，桶数少
查询扫 7×7=49 格           查询扫 3×3=9 格            查询扫 1格（几乎全在）
每格遍历快，但格子数多      ✅ 平衡点                  单格内退化成暴力遍历
哈希开销 dominate          实体过滤 dominate          实体数 dominate
实测：0.8ms/查询           实测：0.2ms/查询           实测：1.5ms/查询
```

### ⚡ 实战经验

- **格子太小导致哈希开销反超查询收益**：早期把弹幕游戏格子设成 8px（子弹直径），结果每帧 5000 个子弹要做 5000 次哈希插入 + 每个子弹查询扫 7×7=49 格，哈希计算本身吃掉 3ms，比暴力遍历还慢。实测后调成 32px（4 倍子弹直径），查询扫 3×3 格，总耗时降到 0.5ms。格子大小必须实测调，不能拍脑袋。
- **跨格实体的多重插入问题**：大尺寸实体（BOSS 直径 200px，格子 64px）横跨 4 个格子，要么只插入中心所在格（查询时漏检边缘碰撞）、要么插入所有覆盖格（删除时要从多个桶移除，易泄漏）。解法：大实体单独走粗粒度网格或多重插入 + 引用计数，小实体走细网格。别让一个网格扛所有尺寸。
- **每帧重建 vs 增量更新的抉择**：一开始用增量更新（移动时从旧格删、插新格），但移动实体多时 Map 的增删开销大，且容易遗漏。改成每帧 `clear() + 重新 insert 全部`，反而快了 2 倍——因为批量插入缓存友好，且省去了删除时的查找。当实体移动率 >30% 时，重建通常比增量快。
- **哈希函数选错导致桶分布不均**：直接用 `col + row * 1000` 做哈希，结果横向移动的实体全落在一个桶的相邻位置，Map 冲突严重。改用混合哈希（`col * 73856093 ^ row * 19349663`）后分布均匀，查询速度提升 40%。哈希函数要让相邻坐标分散到不同桶，别用线性映射。
- **用数组替代 Map 提升常数因子**：当世界边界固定时，用扁平数组（`buckets: T[][]`，index = `col + row * cols`）替代 Map，省掉哈希计算和动态扩容，查询快 30%。代价是边界外坐标要做边界检查或回绕。开放世界（无固定边界）才必须用 Map，封闭关卡用数组更优。

### 🔗 相关问题

1. 当实体尺寸差异巨大（小兵半径 10px、BOSS 半径 300px）时，单一网格要么小实体查询格子过多、要么大实体跨格爆炸，如何设计多层网格或松散四叉树（Loose Quadtree）来解决？
2. 空间哈希网格在 3D 游戏里对应均匀网格（Uniform Grid），但 3D 场景往往有空旷区和（天空）和密集区（城市），此时均匀网格的空桶浪费如何缓解？是否该切换到八叉树？
3. 网络游戏中，服务端用空间哈希网格做"视野同步"（只把玩家视野内的其他实体广播给他），当玩家快速移动穿越格子边界时，如何避免实体"闪烁"（进出一个格子的瞬间消息丢失或重复）？
