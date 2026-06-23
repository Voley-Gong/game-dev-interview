---
title: "网格哈希（Spatial Hash Grid）在网络兴趣区域管理中如何实现？相比九宫格和四叉树有什么优劣？"
category: "network"
level: 3
tags: ["空间分区", "Spatial Hash", "兴趣区域", "AOI", "网络裁剪", "数据结构"]
related: ["network/aoi-algorithm", "network/fps-interest-management", "network/server-authority-vs-client-trust"]
hint: "九宫格是固定大小的格子，Spatial Hash 用 HashMap 存动态格子——插入 O(1)，查询 O(1)，但格子大小选择是个艺术。"
---

## 参考答案

### ✅ 核心要点

1. **Spatial Hash Grid**：将世界坐标映射到固定大小的网格 Cell，用 HashMap<(int,int), Set<Entity>> 存储，插入/删除/查询均 O(1)
2. **AOI 核心流程**：实体移动时更新所属 Cell → 玩家视野范围内的 Cell 集合 → 计算 Enter/Leave 集合 → 仅同步变化部分
3. **三种空间分区对比**：九宫格（简单但粗粒度）、Spatial Hash（均衡）、四叉树（精细但维护贵）
4. **网格大小选择**：通常等于最大视野半径或最大交互距离，过大则裁剪效率低，过小则 Cell 数量爆炸
5. **优化变体**：多层网格（不同关注半径用不同 Cell 大小）、时间分片（均匀分摊 Tick 开销）

### 📖 深度展开

#### Spatial Hash Grid 数据结构

```typescript
class SpatialHashGrid {
    private cellSize: number;        // 格子边长（如 50 米）
    private grid: Map<string, Set<Entity>>;  // "x,z" → entities

    // 坐标 → 格子索引
    private toCell(coord: number): number {
        return Math.floor(coord / this.cellSize);
    }

    private key(cx: number, cz: number): string {
        return `${cx},${cz}`;
    }

    // 插入实体 O(1)
    insert(entity: Entity) {
        const cx = this.toCell(entity.x);
        const cz = this.toCell(entity.z);
        const k = this.key(cx, cz);
        if (!this.grid.has(k)) this.grid.set(k, new Set());
        this.grid.get(k)!.add(entity);
        entity.cellKey = k;
    }

    // 移动后更新 O(1)
    update(entity: Entity, newX: number, newZ: number) {
        this.remove(entity);
        entity.x = newX;
        entity.z = newZ;
        this.insert(entity);
    }

    // 查询视野范围内实体 O(k)，k=覆盖格子数
    queryAround(x: number, z: number, radius: number): Entity[] {
        const result: Entity[] = [];
        const minCx = this.toCell(x - radius);
        const maxCx = this.toCell(x + radius);
        const minCz = this.toCell(z - radius);
        const maxCz = this.toCell(z + radius);

        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cz = minCz; cz <= maxCz; cz++) {
                const cell = this.grid.get(this.key(cx, cz));
                if (cell) result.push(...cell);
            }
        }
        return result;
    }
}
```

#### AOI 视野管理流程

```
玩家移动 → 重新计算视野 Cell 集合
                │
                ▼
    ┌───────────────────────────┐
    │  oldCells = {A, B, C}     │  上一帧视野
    │  newCells = {B, C, D}     │  这一帧视野
    └─────────────┬─────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
   enterCells = {D}    leaveCells = {A}
        │                   │
        ▼                   ▼
   发送 Enter 消息      发送 Leave 消息
   (实体创建/同步)      (实体销毁/移除)
```

#### 三种空间分区对比

| 维度 | 九宫格 (Fixed Grid) | Spatial Hash Grid | 四叉树 (Quadtree) |
|------|---------------------|-------------------|-------------------|
| 数据结构 | 二维数组 | HashMap | 树（递归分区） |
| 插入复杂度 | O(1) | O(1) | O(log n) |
| 查询复杂度 | O(k) 固定 | O(k) 可变范围 | O(log n + k) |
| 内存占用 | 固定（含空格） | 按需分配 | 中等 |
| 密集分布 | 浪费格子 | 可接受 | 自适应细分 ✅ |
| 稀疏分布 | 大量空格子 ✅ | 自然处理 ✅ | 树较深 |
| 实现难度 | 最简单 | 简单 | 较复杂 |
| 动态更新 | O(1) 简单 | O(1) 简单 | O(log n) 需重平衡 |
| 适用场景 | 棋盘/固定地图 | 开放世界/MMO | 密度差异大的场景 |

#### 网格大小如何选择？

```
关键公式：
  cellSize ≥ maxViewRadius（玩家最大视野半径）
  cellsInQuery = (2R/cellSize + 1)²

权衡：
  cellSize 太大 → 单格内实体太多，查询后还需距离过滤
  cellSize 太小 → 查询覆盖的格子数量爆炸

实践建议：
  - MOBA（视野 ~800单位）: cellSize = 800, 查询 ~9 格
  - FPS（视野 ~50m）: cellSize = 50, 查询 ~9 格
  - MMO（视野 ~100m）: cellSize = 100, 查询 ~9 格
  - 规则：让一个玩家视野刚好覆盖 3×3 的格子
```

#### 多层网格优化

```csharp
// 不同关注半径的实体用不同 Cell 大小
public class MultiResolutionGrid
{
    private SpatialHashGrid _npcGrid;      // cellSize=100, NPC 固定
    private SpatialHashGrid _playerGrid;   // cellSize=50, 玩家视野
    private SpatialHashGrid _projectileGrid; // cellSize=20, 子弹密集

    // 小物体放细网格（子弹、掉落物）
    // 大物体放粗网格（BOSS、建筑）
    // 查询时分别查各层，合并结果
}
```

#### 性能数据参考

| 场景 | 实体数 | Grid Size | AOI Tick (1Hz) | 内存 |
|------|--------|-----------|----------------|------|
| 10v10 MOBA | ~500 | 800u | <0.1ms | ~50KB |
| 100人 FPS | ~2000 | 50m | ~0.3ms | ~200KB |
| MMO 城战 | ~5000 | 100m | ~1.5ms | ~1MB |
| 万人同屏 | ~50000 | 100m | ~15ms | ~10MB |

### ⚡ 实战经验

1. **HashMap 的 Key 用整数编码比字符串快**：`"123,456"` 的字符串拼接在热路径上是性能杀手。改用 `(cx & 0xFFFF) << 16 | (cz & 0xFFFF)` 整数编码，速度提升 3-5 倍
2. **AOI Tick 分散到多个 Frame**：不要在一个 Tick 里遍历所有玩家的 AOI，按玩家 ID 取模分散到多帧，避免单帧 CPU 峰值（"AOI 卡帧"）
3. **边界实体跨格问题**：实体在格子边界来回跳动会频繁触发 Enter/Leave。引入**迟滞区域（Hysteresis）**：只在实体跨越超过 0.5 格时才触发切换，避免抖动
4. **服务器间网格同步**：跨服场景下，边界 Cell 需要在两台服务器都注册。用 Ghost 实体方案：边界实体在两台服务器各存一份镜像，一台为主权威

### 🔗 相关问题

- 四叉树在什么场景下比 Spatial Hash Grid 更优？
- AOI 的优先级调度（重要实体先同步）如何设计？
- 跨服无缝大地图中，边界实体的网格归属如何管理？
