---
title: "AOI（Area of Interest）兴趣区域算法如何实现？"
category: "network"
level: 3
tags: ["AOI", "MMO架构", "兴趣区域", "空间索引", "网络优化"]
related: ["network/frame-vs-state-sync", "network/protocol-selection"]
hint: "一个万人同屏的 MMO 服务器，如何做到只同步你附近的 200 人而非全部 10000 人？"
---

## 参考答案

### ✅ 核心要点

1. **核心思想**：每个玩家只关心自己周围一定范围内的实体动态，服务器只下发 AOI 范围内的实体同步信息
2. **进入/离开事件**：实体进入 AOI 范围时发送"生成"消息，离开时发送"销毁"消息
3. **网格法（Grid）**：将地图划分为等大格子，只检查相邻格子的实体——简单高效
4. **十字链表法**：维护 X 和 Y 两个有序链表，利用双向扫描快速确定矩形区域——经典 MMO 方案
5. **四叉树/九宫格**：适合实体分布不均匀的场景（如主城密集、野外稀疏）

### 📖 深度展开

**为什么需要 AOI？**

```
万人 MMO 服务器，如果不做 AOI：

  每个玩家 → 收到 10000 人的位置更新
  服务器每帧广播量 → 10000 × 10000 = 1 亿次消息/帧

  带宽：假设每条消息 50 字节 → 5 GB/s 💀

做了 AOI（半径 50 米，平均附近 200 人）：

  每个玩家 → 只收 200 人的位置更新
  服务器每帧广播量 → 10000 × 200 = 200 万次/帧

  带宽：200万 × 50 字节 → 100 MB/s ✅ 可控
```

**方案一：九宫格 / 网格法（Grid-based AOI）**

```
地图划分为 grid_size × grid_size 的网格
  每个格子维护一个实体列表

  ┌───┬───┬───┬───┬───┐
  │   │   │   │   │   │
  ├───┼───┼───┼───┼───┤
  │   │ ★ │ ★ │ ★ │   │     ★ = AOI 范围内的格子
  ├───┼───┼───┼───┼───┤     ○ = 玩家所在格子
  │   │ ★ │ ○ │ ★ │   │
  ├───┼───┼───┼───┼───┤     AOI半?= 1 格
  │   │ ★ │ ★ │ ★ │   │     检查 3×3 = 9 个格子
  ├───┼───┼───┼───┼───┤
  │   │   │   │   │   │
  └───┴───┴───┴───┴───┘
```

```csharp
public class GridAOI {
    private float cellSize;       // 格子边长（如 50 米）
    private int gridW, gridH;     // 网格行列数
    private HashSet<int>[,] cells; // 每个格子的实体集合

    // 玩家移动时更新 AOI
    public AOIEvent OnEntityMove(int entityId, Vector2 oldPos, Vector2 newPos) {
        var oldCell = WorldToCell(oldPos);
        var newCell = WorldToCell(newPos);

        if (oldCell == newCell) {
            // 格子内移动，不需要更新 AOI 列表
            return AOIEvent.None;
        }

        // 跨格子：重新计算 AOI 范围
        var oldAOI = GetAOICells(oldCell, radius: 1); // 3×3
        var newAOI = GetAOICells(newCell, radius: 1);

        // 计算差异
        var entered = newAOI.Except(oldAOI);   // 新进入视野的格子
        var left = oldAOI.Except(newAOI);      // 离开视野的格子
        var stay = oldAOI.Intersect(newAOI);   // 一直在视野内的格子

        var result = new AOIEvent();

        // 收集进入视野的实体
        foreach (var cell in entered) {
            foreach (var id in cells[cell.x, cell.y]) {
                result.EntitiesEntered.Add(id);
            }
        }

        // 收集离开视野的实体
        foreach (var cell in left) {
            foreach (var id in cells[cell.x, cell.y]) {
                result.EntitiesLeft.Add(id);
            }
        }

        // 更新实体所在格子
        cells[oldCell.x, oldCell.y].Remove(entityId);
        cells[newCell.x, newCell.y].Add(entityId);

        return result;
    }

    private (int x, int y) WorldToCell(Vector2 pos) {
        return (
            (int)(pos.x / cellSize),
            (int)(pos.y / cellSize)
        );
    }
}
```

**方案二：十字链表法（经典 MMO 方案）**

```
原理：维护两个按坐标排序的双向链表

  X 链表（按 x 坐标排序）：
  ... ↔ [E1 x=10] ↔ [E2 x=30] ↔ [E3 x=50] ↔ [E4 x=70] ↔ ...

  Y 链表（按 y 坐标排序）：
  ... ↔ [E3 y=5] ↔ [E1 y=15] ↔ [E4 y=40] ↔ [E2 y=60] ↔ ...

查询 AOI [x-r, x+r] × [y-r, y+r]：
  1. 从当前节点出发，沿 X 链表向左右扫描，直到 x 超出 [x-r, x+r]
  2. 同理沿 Y 链表扫描
  3. 两个扫描结果的交集 = AOI 内的实体
```

**三种方案对比：**

| 维度 | 网格法 | 十字链表 | 四叉树 |
|------|--------|----------|--------|
| **实现复杂度** | ⭐ 简单 | ⭐⭐ 中等 | ⭐⭐⭐ 复杂 |
| **查找复杂度** | O(k) k=格子数 | O(n) 最坏全扫描 | O(log n) |
| **空间效率** | 稀疏区域浪费 | 无浪费 | 自适应 |
| **动态更新** | O(1) 换格 | O(1) 链表插入 | O(log n) |
| **适合场景** | 均匀分布 | 中等规模 MMO | 大地图分布不均 |
| **代表使用** | 手游 MMO | 端游 MMO | 开放世界 |

**Tick 频率优化——AOI 内的差异化同步：**

```
AOI 内也不是所有人同等对待：

┌─────────────────────────────────────┐
│           AOI 分层同步策略            │
├─────────────────────────────────────┤
│                                     │
│  ┌─── 核心层（0-20m）──→ 20Hz 同步  │
│  │    战斗交互范围，高频更新          │
│  │                                  │
│  ├─── 中间层（20-50m）─→ 10Hz 同步  │
│  │    可见范围，中频更新              │
│  │                                  │
│  └─── 外围层（50-100m）→ 2Hz 同步   │
│       刚进入视野，低频即可            │
│                                     │
└─────────────────────────────────────┘

效果：进一步降低带宽 40-60%
```

### ⚡ 实战经验

- **格子大小选择**：一般设为 AOI 半径的 1/2 到 1 倍。格子太大→每格实体过多，遍历慢；格子太小→跨格频繁，更新开销大
- **边界抖动问题**：实体在两个格子边界来回移动时会产生大量进入/离开消息。解决方案：加一个滞回区域（hysteresis），比如离开后 2 秒内不发送销毁消息
- **热点区域**：主城、传送点等区域可能聚集上千人，单个格子的实体列表爆炸。需要对单格实体数设上限，超过后做分片或降频
- **AOI 半径不是固定的**：不同玩法阶段可以动态调整。战斗中缩小 AOI（减少干扰），大地图探索时放大 AOI（增加沉浸感）
- **无缝大地图的服务器分区**：AOI 在边界处需要跨服处理。常见方案是 ghost entity——在相邻服务器的边界创建实体的"幽灵副本"，使得跨服移动时玩家无感知

### 🔗 相关问题

- 无缝大地图如何做服务器间的实体迁移？
- 如何处理 AOI 边界处两个玩家看到不一致的世界状态？
- 手游 MMO 中 AOI 策略与端游有何不同（带宽更受限）？
