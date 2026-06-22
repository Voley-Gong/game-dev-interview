---
title: "3D AOI 进阶：视野遮挡剔除、高度差异与空间索引优化怎么做？"
category: "network"
level: 4
tags: ["AOI", "兴趣区域", "3D空间", "视野遮挡", "空间索引", "MMO", "性能优化"]
related: ["network/aoi-algorithm", "network/mmo-seamless-map-zoning"]
hint: "玩家在山上和山下，距离很近但互相看不见——九宫格 AOI 怎么处理这种情况？"
---

## 参考答案

### ✅ 核心要点

1. **基础 AOI（九宫格/十字链表）只解决平面距离问题**，3D 场景中的墙壁、地形、建筑遮挡需要额外处理
2. **服务器端遮挡剔除（Server-side Occlusion）** 是 MMO 的大型优化方向，避免发送玩家"看不到"的实体数据
3. **层次化空间索引**：粗筛（Grid）→ 精筛（AABB / 视锥）→ 遮挡测试（PVS / 光线投射），逐层减少计算量
4. **PVS（Potentially Visible Set）** 预计算方案适合静态场景，动态遮挡则依赖运行时 BVH 或 Hi-Z
5. **降级策略很重要**：遮挡判断本身也有开销，当服务器负载高时可退回纯距离 AOI

### 📖 深度展开

#### 问题场景：为什么平面 AOI 不够用

```
侧视图：

    🧙玩家A (山顶)
    /\
   /  \          ← 地形遮挡
  /    \
─────────────────
         🧝玩家B (山脚)

平面距离 = 5m（九宫格判定：可见）
实际视野 = 不可见（被山体遮挡）

→ 如果服务器仍然推送 B 的数据给 A：
   - 浪费带宽（尤其是大型战场）
   - 暴露战术信息（穿墙透视？）
   - 客户端还要渲染看不见的角色
```

#### 三级过滤架构

```
实体进入玩家视野判断流水线：

Level 1: Grid 粗筛（O(1)）
   输入：玩家坐标
   输出：同格 + 相邻格的所有实体
   ↓ 过滤掉 80-90% 的远距离实体

Level 2: 精确距离 + 视锥筛选（O(n)）
   输入：Level 1 的候选集
   操作：球形距离判断 + 视锥体（Frustum）裁剪
   输出：距离 ≤ R 且在视野角度内的实体
   ↓ 再过滤 30-50%

Level 3: 遮挡测试（O(n × k)）
   输入：Level 2 的候选集
   操作：
     方案A：PVS 查表（O(1)，仅静态遮挡）
     方案B：光线投射 Ray Cast（O(k)，k=障碍数）
     方案C：Hi-Z Buffer 查询（GPU 辅助）
   输出：真正可见的实体集合
```

#### PVS（预计算可见集）实现

```csharp
// 离线预处理：将地图划分为 Cell，每个 Cell 预计算可见 Cell 列表
public class PVSTable
{
    // cellId → 可见的其他 cellId 集合
    private Dictionary<int, HashSet<int>> visibilityMap;

    // 离线烘焙：对每个 Cell 中心点向所有其他 Cell 发射光线
    public void Bake(TerrainMesh terrain, int gridSize)
    {
        for (int x = 0; x < gridSize; x++)
        {
            for (int z = 0; z < gridSize; z++)
            {
                int fromCell = Encode(x, z);
                var visible = new HashSet<int>();

                for (int tx = 0; tx < gridSize; tx++)
                {
                    for (int tz = 0; tz < gridSize; tz++)
                    {
                        if (fromCell == Encode(tx, tz)) continue;
                        // 从 fromCell 中心到 targetCell 中心做光线追踪
                        if (!terrain.IsOccluded(GetCellCenter(x, z), GetCellCenter(tx, tz)))
                        {
                            visible.Add(Encode(tx, tz));
                        }
                    }
                }
                visibilityMap[fromCell] = visible;
            }
        }
    }

    // 运行时查询：O(1) 查表
    public bool IsVisible(int observerCell, int targetCell)
    {
        return visibilityMap.TryGetValue(observerCell, out var set) && set.Contains(targetCell);
    }
}
```

#### 动态遮挡处理（建筑、载具）

| 方案 | 适用场景 | 开销 | 精度 |
|------|---------|------|------|
| PVS + 动态标记 | 可破坏建筑、开关门 | 低（查表+位运算） | 中 |
| BVH 光线投射 | 复杂动态场景 | 中高（每帧少量射线） | 高 |
| Hi-Z Buffer | GPU 已有深度图 | 低（GPU 查询） | 高 |
| 简化碰撞体射线 | 移动载具遮挡 | 中 | 中 |

```
混合策略（推荐）：

静态地形/建筑 → PVS 预计算（离线烘焙）
动态大型物体 → 简化 AABB 光线测试（运行时）
小型动态物体 → 跳过遮挡（误差可接受）
```

#### AOI 与网络带宽的量化关系

```csharp
// 一个大型 MMO 战场场景的带宽计算

// 无遮挡 AOI：
int visibleEntities = 200;  // 半径内所有实体
int bytesPerEntity = 32;     // 位置+状态压缩后
int sendRate = 10;           // 每秒 10 次更新
// 每玩家带宽 = 200 × 32 × 10 = 64 KB/s（下行）

// 启用遮挡剔除后（过滤 60%）：
int visibleEntities = 80;
// 每玩家带宽 = 80 × 32 × 10 = 25.6 KB/s（节省 60%）
// 万人同屏时总带宽节省：数 GB/s 级别
```

### ⚡ 实战经验

- **PVS 烘焙耗时但值得**：一张大型地图的 PVS 烘焙可能需要数小时，但运行时查询只需 O(1)，大型 MMO 几乎必做
- **动态遮挡不要过设计**：80% 的遮挡收益来自静态地形和大型建筑，动态物体的遮挡优化收益往往不如预期——先做静态的
- **AOI 半径要区分实体类型**：角色 50m、NPC 30m、特效 100m、掉落物 20m——统一半径会浪费带宽或导致"突然冒出来"的体验问题
- **移动端注意 CPU 开销**：光线投射在服务器做即可，但如果用 P2P 或 Relay 架构，客户端也要做本地 AOI 预剔除再发送

### 🔗 相关问题

- 九宫格 AOI 和十字链表 AOI 的具体实现差异？（→ aoi-algorithm）
- 无缝大地图的分区服务器如何与 AOI 协同？（→ mmo-seamless-map-zoning）
- 可破坏地形（如战壕、炸墙）如何实时更新 PVS？
