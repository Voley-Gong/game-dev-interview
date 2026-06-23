---
title: "游戏中的空间分区有哪些方案？四叉树、八叉树、网格怎么选？"
category: "architecture"
level: 3
tags: ["空间分区", "四叉树", "八叉树", "空间哈希网格", "性能优化", "架构设计"]
related: ["architecture/pathfinding-navigation-architecture", "architecture/ecs-architecture"]
hint: "核心目标是把 O(n²) 的空间查询降为接近 O(n)，不同数据分布对应不同分区结构。"
---

## 参考答案

### ✅ 核心要点

1. **问题本质**：N 个实体的两两碰撞/查询是 O(n²)，空间分区通过"只检查附近实体"将其降为 O(n·k)
2. **均匀网格（Uniform Grid）**：固定大小格子，查询快、实现简单，适合实体分布均匀的场景
3. **四叉树（2D）/ 八叉树（3D）**：自适应细分的树结构，适合实体分布不均、稀疏的场景
4. **BVH（层次包围盒）**：动态物体友好的树结构，适合频繁移动的场景（物理引擎常用）
5. **选择依据**：实体数量、分布密度、移动频率、查询类型（邻近查询 vs 范围查询 vs 射线检测）

### 📖 深度展开

**三种主流方案结构对比：**

```
均匀网格（Uniform Grid）
  将世界划分为等大小的格子，实体按位置映射到格子
  ┌───┬───┬───┬───┐
  │ A │   │ B │   │
  ├───┼───┼───┼───┤
  │   │ C │   │ D │
  ├───┼───┼───┼───┤
  │ E │   │ F │   │
  └───┴───┴───┴───┘
  查询 A 附近：只检查 A 所在格子 + 相邻 8 格

四叉树（Quadtree, 2D）
  递归四分空间，密集区域自动细分
  ┌────────┬───┬────┐
  │        ├───┼────┤
  │   A    │ B │    │
  │        ├───┴────┤
  ├────────┤        │
  │   C    │   D    │
  └────────┴────────┘
  稀疏区域保持大格子，密集区域深细分

BVH（Bounding Volume Hierarchy）
  按包围盒构建树，物体移动时只需更新包围盒
       [Root AABB]
       /          \
  [Branch]      [Branch]
   / \            / \
 [A] [B]       [C] [D]
```

**均匀网格实现：**

```csharp
public class SpatialHashGrid {
    private readonly Dictionary<(int, int), List<Entity>> _cells = new();
    private readonly float _cellSize;

    public SpatialHashGrid(float cellSize) => _cellSize = cellSize;

    private (int cx, int cy) CellOf(float x, float y) =>
        ((int)(x / _cellSize), (int)(y / _cellSize));

    public void Insert(Entity e) {
        var (cx, cy) = CellOf(e.X, e.Y);
        if (!_cells.TryGetValue((cx, cy), out var list))
            _cells[(cx, cy)] = list = new List<Entity>();
        list.Add(e);
    }

    // 查询某实体附近的所有实体
    public List<Entity> QueryNearby(Entity e) {
        var result = new List<Entity>();
        var (cx, cy) = CellOf(e.X, e.Y);
        for (int dx = -1; dx <= 1; dx++)
        for (int dy = -1; dy <= 1; dy++) {
            if (_cells.TryGetValue((cx + dx, cy + dy), out var list))
                result.AddRange(list);
        }
        return result;
    }

    // 每帧重建（简单粗暴，实体少时效率高）
    public void Clear() => _cells.Clear();
}
```

**四叉树实现核心：**

```csharp
public class QuadTreeNode {
    private readonly Rect _bounds;
    private readonly int _depth;
    private const int MAX_OBJECTS = 8;
    private const int MAX_DEPTH = 6;
    private readonly List<Entity> _objects = new();
    private QuadTreeNode[] _children; // [0]=TL [1]=TR [2]=BL [3]=BR

    public void Insert(Entity e) {
        if (_children != null) {
            var idx = GetChildIndex(e);
            if (idx >= 0) { _children[idx].Insert(e); return; }
        }
        _objects.Add(e);
        // 超容量且未到最大深度 → 细分
        if (_objects.Count > MAX_OBJECTS && _depth < MAX_DEPTH)
            Split();
    }

    private void Split() {
        _children = new QuadTreeNode[4];
        var (x, y, w, h) = (_bounds.x, _bounds.y, _bounds.w / 2, _bounds.h / 2);
        _children[0] = new QuadTreeNode(new Rect(x, y, w, h), _depth + 1);
        _children[1] = new QuadTreeNode(new Rect(x + w, y, w, h), _depth + 1);
        _children[2] = new QuadTreeNode(new Rect(x, y + h, w, h), _depth + 1);
        _children[3] = new QuadTreeNode(new Rect(x + w, y + h, w, h), _depth + 1);
        // 将现有物体重新分配到子节点
        foreach (var e in _objects) {
            int idx = GetChildIndex(e);
            if (idx >= 0) _children[idx].Insert(e);
        }
        _objects.Clear();
    }

    // 范围查询：收集与查询矩形相交的所有实体
    public void Query(Rect range, List<Entity> result) {
        if (!_bounds.Overlaps(range)) return;
        result.AddRange(_objects.Where(e => range.Contains(e)));
        if (_children != null)
            foreach (var child in _children) child.Query(range, result);
    }
}
```

**方案选择决策矩阵：**

| 维度 | 均匀网格 | 四叉树/八叉树 | BVH |
|------|---------|-------------|-----|
| 实体分布 | 均匀 | 不均匀/稀疏 | 动态变化 |
| 内存开销 | 低（数组） | 中（树节点） | 中（树节点） |
| 构建成本 | 极低（哈希映射） | 中（递归插入） | 中（SAH 构建） |
| 动态更新 | 每帧重建 | 增删+再平衡 | 增删+旋转修复 |
| 范围查询 | O(格子数) | O(logN + 结果数) | O(logN + 结果数) |
| 典型场景 | 弹幕、2D 游戏 | 开放世界、场景管理 | 物理引擎碰撞检测 |
| 代表使用 |Bullet Hell | 场景剔除、LOD | Unity PhysX、Havok |

**与游戏子系统集成：**

```
碰撞检测 Broad Phase：
  1. 用空间分区快速筛选"可能在附近的实体对"（候选对）
  2. Narrow Phase 对候选对做精确碰撞检测（AABB/SAT）
  → 宽相过滤 99% 不可能碰撞的对，大幅减少窄相计算量

场景裁剪（Frustum Culling）：
  用四叉树/八叉树快速剔除视锥外的物体
  → 只遍历与视锥相交的节点，跳过大段子树

AI 感知（视野查询）：
  "附近 5 米内有哪些敌人？" → 网格/四叉树范围查询
  → O(附近实体数) 而非 O(全场景实体数)

ECS 中的空间分区：
  将空间索引作为一个 System 维护，每帧用 Job 并行重建
  查询系统通过 EntityQuery + 空间索引组合筛选
```

### ⚡ 实战经验

- **实体少（<100）时别过度设计**：直接 O(n²) 两两检测可能比维护空间分区结构还快——树/网格的构建和维护本身有开销，要用 Profiler 验证收益
- **均匀网格的格子大小是关键参数**：格子太大→每格实体多，查询退化；格子太小→内存浪费、缓存差。经验值：格子大小 ≈ 实体平均查询半径 × 2
- **动态场景优先考虑"每帧重建网格"**：对于频繁移动的实体（如弹幕），每帧 Clear + Insert 比维护增量更新更简单且常更快；四叉树的频繁插入删除反而有碎片化问题
- **跨格子边界的实体需特殊处理**：一个实体可能跨越多个格子，插入时要覆盖所有重叠格子，否则查询会遗漏。或改用"实体中心点 + 查询时扩大搜索范围"的近似策略

### 🔗 相关问题

- 物理引擎的 Broad Phase 和 Narrow Phase 分别做什么？
- 如何在 ECS 架构中高效维护空间分区索引？
- 动态场景中 BVH 的再平衡策略有哪些？
