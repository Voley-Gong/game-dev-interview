---
title: "3D 游戏碰撞检测为什么普遍用 BVH？它和八叉树、空间哈希怎么选？"
category: "programming"
level: 3
tags: ["数据结构", "碰撞检测", "BVH", "空间划分", "性能优化", "3D"]
related: ["programming/spatial-hash-grid-game", "programming/data-structures-game", "programming/performance-profiling-budget"]
hint: "Broadphase 的任务是砍掉 n² 对里不可能相撞的部分。3D 动态场景里 BVH 凭'适应任意分布 + 增量更新'成为默认选择——八叉树怕对象穿越边界，空间哈希怕分布不均。"
---

## 参考答案

### ✅ 核心要点

1. **碰撞检测分 Broadphase（粗筛）和 Narrowphase（精算）两阶段**：n 个对象两两配对是 O(n²)，1000 个对象就是 50 万对，绝大多数根本不可能相撞。Broadphase 用廉价的 AABB（轴对齐包围盒）快速排除不可能相交的对，只把\"可能相撞\"的少数对送进 Narrowphase 做三角形级精确检测。Broadphase 的数据结构选择直接决定送进窄相的对数，是性能主战场。
2. **BVH（Bounding Volume Hierarchy，层次包围盒）是一棵\"包围盒套包围盒\"的树**：每个叶子节点存一个对象的 AABB，每个内部节点的 AABB 紧包所有子节点的 AABB。查询时从根下降，若当前节点 AABB 与查询不相交，整棵子树一次性剪枝——平均查询 O(log n)。射线检测（raycast）、视锥裁剪、碰撞配对全用它。
3. **BVH 胜在\"适应任意分布 + 支持动态增量更新\"**：八叉树按固定空间均匀切分，对象集中在某一层时要么空桶浪费、要么穿越边界频繁重建；空间哈希网格在 3D 不均匀场景（城市密集 vs 天空空旷）退化严重。BVH 按对象组织（而非按空间），密集区自动多分、稀疏区少分，且移动对象只需 remove + reinsert 单节点再局部重平衡，是动态 3D 场景（角色、载具、可破坏物）的事实标准。
4. **构建质量决定一切：SAH（表面积启发式）是黄金标准**：随机中分构建的 BVH 查询会退化（叶子重叠多、剪枝失效）。SAH 假设\"射线击中节点的概率正比于其 AABB 表面积\"，按最小化期望查询代价来选择切分位置。静态场景一次性高质量构建（Morton 码排序 + SAH），动态场景周期性增量重平衡 + 每隔 N 帧全量重建。
5. **动态 BVH 的更新是性能与质量的权衡**：① **增量更新**（对象移动后 remove+reinsert，O(log n)）适合每帧少量移动；② **懒更新**（只更新 AABB 不动结构，等重叠严重再重建）适合慢速移动；③ **周期重建**（积累改动后整树 SAH 重建）兜底防止树退化成链表。商业引擎（PhysX、Bullet）都用\"增量 + 定期 refit/rebuild\"混合策略。
6. **AABB 相交和 Ray-AABB 是底层原语**：所有上层结构最终都归结为大量 AABB-AABB 或 Ray-AABB 测试。AABB-AABB 用\"分离轴定理\"6 轴判断 O(1)；Ray-AABB 用 slab 法 O(1)。这两个原语的常数因子（SIMD、分支预测）往往比数据结构本身更影响实测量能。

### 📖 深度展开

**1. BVH 的构建与查询（核心算法）**

```typescript
interface BVHNode {
  box: AABB;                  // 紧包本节点所有对象的 AABB
  left: BVHNode | null;       // 内部节点有左右子，叶子为 null
  right: BVHNode | null;
  object?: GameObject;        // 仅叶子节点持有
}

// 构建：递归按 SAH 选择切分轴和位置
function build(objects: GameObject[]): BVHNode {
  const box = unionAABB(objects.map(o => o.aabb));   // 本节点 AABB = 子并集
  if (objects.length <= 1) return { box, left: null, right: null, object: objects[0] };
  // 选最长轴，按质心排序，SAH 评估每个切分点的代价取最小
  const axis = box.longestAxis();
  objects.sort((a, b) => a.centroid[axis] - b.centroid[axis]);
  const split = bestSAHSplit(objects, axis);         // 表面积启发式选最优切分
  const left = build(objects.slice(0, split));
  const right = build(objects.slice(split));
  return { box, left, right };
}

// 查询：递归下降，AABB 不相交即剪枝整棵子树
function query(node: BVHNode, q: AABB, out: GameObject[]): void {
  if (!intersectAABB(node.box, q)) return;           // 剪枝：子树全排除
  if (node.object) { out.push(node.object); return; } // 叶子命中
  query(node.left!, q, out);
  query(node.right!, q, out);
}
```

```
BVH 结构示意（每个内部节点 AABB 包住两个子节点）：
                根 AABB (包全场)
               /              \
         ┌─────┴────┐      ┌────┴────┐
        城区AABB    郊区AABB  天空AABB  地下AABB
        /    \      /    \    (空旷, 叶少)
     楼1  楼2..   树  车..   
     
射线检测 raycast：从根下降，Ray-AABB 不相交的子树直接跳过
 ╳ 城区不相交 → 跳过整片城区（剪掉上千对象）
 ✓ 郊区相交 → 继续下降到叶子做精确三角面检测
 平均复杂度 O(log n)，暴力遍历是 O(n)
```

**2. 四种 Broadphase 方案横向对比**

| 方案 | 构建/更新 | 查询 | 适应分布 | 动态对象 | 典型场景 |
|------|----------|------|---------|---------|---------|
| **暴力遍历** | 无 | O(n²) | 不限 | 无成本 | n<50，调试 |
| **均匀网格/空间哈希** | O(n) 重建 | O(k) 邻域 | ❌ 均匀才好 | 移动重哈希 | 2D 弹幕、塔防 |
| **八叉树** | O(n log n) | O(log n+k) | 中（空桶浪费） | 跨界重建贵 | 半静态 3D 关卡 |
| **BVH** | O(n log n) / 增量 O(log n) | O(log n) | ✅ 任意分布 | ✅ remove+reinsert | ✅ 动态 3D 首选 |
| **Sweep-and-Prune** | O(n) 排序 | O(n+k) | 中 | 排序扰动 | 物体多但轴上分散 |

**3. SAH 表面积启发式：为什么随机构建会慢**

```typescript
// SAH 核心思想：射线击中子节点的概率 ∝ 子节点 AABB 表面积 / 父节点表面积
// 代价模型：cost(split) = 遍历代价 + P(击中左)*cost(左) + P(击中右)*cost(右)
// 目标：选使总代价最小的切分点
function bestSAHSplit(objs: GameObject[], axis: number): number {
  const parentArea = surfaceArea(unionAABB(objs.map(o => o.aabb)));
  let bestCost = Infinity, bestSplit = objs.length >> 1;
  // 预处理：从左到右累积 AABB，从右到左累积 AABB（O(n) 扫描）
  const leftBox = prefixUnion(objs), rightBox = suffixUnion(objs);
  for (let i = 1; i < objs.length; i++) {
    const pLeft = surfaceArea(leftBox[i - 1]) / parentArea;
    const pRight = surfaceArea(rightBox[i]) / parentArea;
    const cost = 1 + pLeft * i + pRight * (objs.length - i); // 遍历代价1 + 期望子代价
    if (cost < bestCost) { bestCost = cost; bestSplit = i; }
  }
  return bestSplit;
}
```

```
构建质量对查询的影响（同 1000 对象，查 1 次 raycast）：

随机中分构建：           SAH 最优构建：
叶子 AABB 重叠严重        叶子 AABB 紧凑少重叠
射线频繁落入多个子树      射线大部分只命中单侧
剪枝失效，退化近 O(n)     剪枝高效，O(log n)
实测：1.8ms/raycast       实测：0.08ms/raycast （快 20 倍）
```

### ⚡ 实战经验

- **八叉树在动态场景被对象跨界拖垮**：开放世界载具高速移动，频繁穿越八叉树格子边界导致 remove + reinsert + 节点合并/分裂，每帧重建吃掉 4ms 且偶发卡顿尖峰。换成 BVH 后单节点 remove+reinsert 只 O(log n) 局部重平衡，帧时间稳定在 1.2ms。结论：静态或慢速场景八叉树够用，大量动态对象首选 BVH。
- **AABB 的 margin（膨胀量）是双刃剑**：给角色 AABB 加 5% margin 防止高速对象\"穿透\"（连续帧间跨过障碍），但 margin 太大会导致 broadphase 误报激增、narrowphase 配对数翻倍。实测 margin=平均移动速度×帧时间 时穿透和误报平衡最好，固定百分比会随对象速度变化失效。
- **树退化成链表没及时发现**：长期只增量更新不重建，BVH 失衡后深度从理想 log₂(1000)≈10 涨到 60+，raycast 从 0.1ms 飙到 3ms。加监控：树高超过 2·log₂(n) 或根 AABB 利用率（叶子总面积/根面积）低于阈值时触发全量 SAH 重建。定期重建是动态 BVH 的安全网。
- **broadphase 配对数爆炸排查**：某场景 800 个对象 broadphase 输出 12 万对送进 narrowphase，帧时间暴涨。根因是大量小物体挤在一个大 AABB 容器（载具内的货物）内，BVH 对聚集对象构建质量差。解法：对聚集物用单独的子 BVH 或直接剔除（货物不参与世界碰撞），配对数降到 3000，帧时间回落。
- **Ray-AABB 的 slab 法要处理除零**：射线平行于某轴时除以方向分量会除零，得到 ±Infinity，逻辑上刚好正确（区间无界）但某些实现会 NaN。用 `1/d` 预计算并允许 Infinity，别加 `if(d===0)` 分支——分支预测失败比处理 Infinity 还慢。这个底层原语每帧调用上万次，常数因子极敏感。

### 🔗 相关问题

1. 当场景中同时有\"静态环境\"（建筑、地形，永不移动）和\"动态对象\"（角色、载具）时，业界常用\"双 BVH\"（静态树 + 动态树分离）的设计，比单棵树好在哪？静态树为何可以离线 SAH 构建到极致？
2. GPU 驱动渲染（GPU-driven rendering）中用 BVH 做 GPU 端视锥裁剪和遮挡剔除，如何把 BVH 结构上传到 GPU 并在 compute shader 里遍历？和 RTX 光追用的硬件加速结构（TLAS/BLAS）是什么关系？
3. 可破坏场景（墙体被打碎成上百碎片）会让 BVH 在瞬间涌入大量新对象，如何避免单帧构建卡顿？是否能用\"碎片懒激活\"或\"LOD 碰撞\"（远处用粗包围盒）平滑过渡？
