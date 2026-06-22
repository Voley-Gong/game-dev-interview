---
title: "游戏寻路与导航系统架构怎么设计？A*、NavMesh、流场寻路怎么选？"
category: "architecture"
level: 3
tags: ["寻路", "NavMesh", "A*", "流场寻路", "AI导航", "架构设计"]
related: ["architecture/fsm-behavior-tree", "architecture/open-world-loading", "architecture/ecs-architecture"]
hint: "寻路不只是'A* 算法'，而是一套分层系统：用什么表达世界（网格/路点/NavMesh）、用什么算法找路（A*/流场）、找到路后怎么平滑走（Steering/避障）。选型取决于单位数量和地图类型。"
---

## 参考答案

### ✅ 核心要点

1. **寻路 = 地图表达 + 路径搜索 + 运动执行三层**：地图表达（Grid/Waypoint/NavMesh）决定可走区域怎么存；路径搜索（A*/Dijkstra/流场）决定怎么找最优路径；运动执行（Steering/RVO 避障）决定单位怎么平滑沿路径走、互相不挤。
2. **A\* 是通用骨架**：用启发函数（曼哈顿/欧几里得）引导搜索，保证最优解；性能瓶颈在"搜索节点数"，所以优化方向是"减少可搜索的节点"——这就是 NavMesh 和分层寻路（HPA*）存在的意义。
3. **NavMesh 是 3D 游戏的主流地图表达**：把可走区域烘焙成凸多边形网格，节点数远少于 Grid（一整块地面只是一个多边形），A* 在多边形上跑极快，且天然支持斜坡/高低差。
4. **流场寻路（Flow Field）适合 RTS 海量同屏单位**：先对全场算一次"每个格子到目标的代价场 + 方向场"，之后所有单位只需查表朝目标方向走——O(1) 寻路，万人同屏也流畅。
5. **找到路≠能走通**：静态寻路只考虑地形，动态还得处理单位互相挡路（局部避障 RVO/ORCA）、动态障碍（门/陷阱）、编队保持、路径平滑（Funnel 算法去拐角）。

### 📖 深度展开

**三种地图表达对比：**

```
Grid（网格）          Waypoint（路点）        NavMesh（导航网格）
┌┬┬┬┬┬┐               •───•───•              ┌──────────┐
├┼┼┼┼┼┤               │       │            ┌─┘  可走区域  └┐
├┼┼┼┼┼┤               •   •   •            │  烘焙成凸多边形 │
└┴┴┴┴┴┘               │       │            └─────────────┘
每个格子一个节点        人工/自动标记关键点     多边形=节点，边=邻接
节点多（精度高）         节点少但不连续          节点少且连续，支持3D
```

| 维度 | Grid 网格 | Waypoint 路点 | NavMesh 导航网格 |
|------|-----------|---------------|------------------|
| 节点密度 | 高（每格一节点） | 低（手工点） | 低（一块面一节点） |
| 路径精度 | 高（格子细） | 低（只在点间走） | 高（面内自由走） |
| 动态修改 | 容易（改格子） | 难 | 中（重建局部） |
| 3D/高低差 | 差（需多层） | 差 | 好（天然支持） |
| 适用 | 2D/塔防/roguelike | 老式 FPS | 3D 动作/MMO/开放世界 |

**A\* 核心与优化：**

```csharp
// A*: f = g(已走代价) + h(启发预估到终点)，优先扩展 f 最小的节点
public List<Node> FindPath(Node start, Node goal) {
    var open = new PriorityQueue<Node>();   // 按 f 排序
    var gScore = new Dictionary<Node, float>();
    gScore[start] = 0;
    start.F = Heuristic(start, goal);
    open.Enqueue(start);

    while (open.Count > 0) {
        var cur = open.Dequeue();
        if (cur == goal) return ReconstructPath(cur);  // 找到
        foreach (var next in cur.Neighbors) {
            float tentative = gScore[cur] + Cost(cur, next);
            if (tentative < gScore.GetValueOrDefault(next, float.MaxValue)) {
                next.CameFrom = cur;
                gScore[next] = tentative;
                next.F = tentative + Heuristic(next, goal);
                if (!open.Contains(next)) open.Enqueue(next);
            }
        }
    }
    return null; // 无路
}
```

**流场寻路（Flow Field）——RTS 海量单位的解法：**

```
传统 A*: 1000 个单位各自算 A* → 1000 次搜索，卡帧
流场:    对目标点算 1 次 Dijkstra 反向求"代价场"
         → 由代价场导出"方向场"（每格指向代价最小的邻居）
         → 每个单位每帧查自己所在格子的方向，O(1) 移动

代价场(Cost Field)      方向场(Flow Field)        单位朝向
 5 4 3 2 1              → → → ↓                   → → → ↓
 4 3 2 1 T            ↘ → ↓ ↓ ★(目标)            ↘ → ↓ ↓ ★
 5 4 3 2 1              ↓ ↓ ↓ ↓                   ↓ ↓ ↓ ↓
```

**完整的导航子系统分层：**

```
请求寻路(A → B)
  ↓
1. 全局路径（静态）——A* / NavMesh 求出多边形/格子序列
  ↓
2. 路径平滑——Funnel 算法去掉贴墙拐角，拉直成自然路径
  ↓
3. 局部避障（动态）——RVO/ORCA 检测附近单位，调整速度避免碰撞
  ↓
4. 运动执行——Steering（抵达/分离/聚合）驱动角色朝下一路点移动
  ↓
到达目标 / 路径失效时触发重算
```

### ⚡ 实战经验

- **别每帧给每个单位跑 A\***：寻路是 CPU 大户，应做"请求节流 + 路径复用"——同一目标的小兵共享一条流场；单位寻路请求排队，每帧只处理 N 个，分摊到多帧；路径缓存后只在撞墙/目标移动时重算。
- **NavMesh 烘焙是离线资产，不是运行时算的**：关卡设计时烘焙好 `.navmesh`，运行时直接加载查询。地图若会动态变化（可破坏墙、开关门），用"局部 NavMesh 切片 + 动态障碍 carving"而非整体重建，否则掉帧。
- **路径平滑选 Funnel 别选简单直线连点**：NavMesh 原始路径是"多边形中心点连线"，角色会贴墙走 Z 字。Funnel 算法利用多边形共享边作"漏斗"求最短路径，走出来才自然。
- **群组寻路要防"单位互锁"**：一群怪挤在窄路口，各自 A* 会互相挡死。用流场（共享方向场）+ RVO 局部避障，并给编队加"槽位（slot）"分配，让单位排成队而非挤成一团。

### 🔗 相关问题

1. 动态障碍（如玩家放下的墙）出现时，如何高效更新 NavMesh 而不整体重建？
2. RVO/ORCA 局部避障算法的原理是什么？为什么比简单的"撞到就停"好？
3. 在 ECS 架构下如何实现高性能的批量寻路（多线程 Job 化）？
