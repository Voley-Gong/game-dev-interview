---
title: "A*寻路算法的原理是什么？游戏中如何工程化实现高效寻路？"
category: "programming"
level: 2
tags: ["算法", "寻路", "A*", "图搜索", "启发式", "性能优化"]
related: ["programming/priority-queue-binary-heap", "programming/data-structures-game", "programming/performance-profiling-budget", "programming/bvh-bounding-volume-hierarchy-game"]
hint: "A* = Dijkstra（保证最优）+ 贪心最佳优先（利用启发式加速）。f(n)=g(n)+h(n) 是它的灵魂公式——但游戏中真正的难点不是算法本身，而是导航网格、分帧寻路、多单位避障这些工程化问题。"
---

## 参考答案

### ✅ 核心要点

1. **A\* 的核心是 f(n) = g(n) + h(n) 评估函数**：`g(n)` 是起点到当前节点的实际累积代价，`h(n)` 是当前节点到终点的启发式估算（从不高估才能保证最优）。每轮从"开放表"中取出 f 最小的节点扩展，直到终点进入关闭表。当 `h(n)=0` 时 A* 退化为 Dijkstra（向四周均匀扩散）；当只看 `h(n)` 时退化为贪心最佳优先（可能绕远路）。A* 的精妙在于两者平衡——既朝目标方向加速，又不放弃最优性。
2. **启发式函数 h(n) 的选择决定性能与正确性**：① **曼哈顿距离**（|dx|+|dy|）：适合四方向网格移动，简单快速；② **对角线距离**（max(|dx|,|dy|) + (√2−1)·min）：适合八方向移动；③ **欧几里得距离**（直线距离）：适合自由方向但计算稍贵。关键规则：`h(n)` 绝不能高估真实代价（admissible），否则可能得到次优路径。允许"次优但更快"时可以适度放大 h（weighted A*），牺牲最优性换 10 倍速度。
3. **开放表必须用优先队列（最小堆），关闭表用哈希集合**：每轮要从开放表取 f 最小节点，用数组是 O(n) 查找、用二叉堆是 O(log n)。1000 节点地图，数组版每轮扫 1000 次，堆版每轮 ~10 次对比，实测堆版快 5-10 倍。关闭表用 `Set` 做 O(1) 查重，防止重复扩展。这两个数据结构的选择直接决定 A* 的实测量级。
4. **游戏工程化：网格只是教学版，导航网格（NavMesh）才是实战**：网格寻路简单但路径生硬（只能走格子中心）且节点数多（100×100 地图=1 万节点）。NavMesh 把可行走区域合并成多边形，节点数大幅减少（同场景可能只要 50 个多边形），路径更自然。A* 算法不变，只是"图"的节点从网格变为多边形，边权变为多边形间距。商业引擎（Unity NavMesh、Recast）都基于 NavMesh。
5. **大规模寻路的性能靠"分帧 + 层次化 + Flow Field"**：单次 A* 在大地图上可能耗时 5-10ms，RTS 里 100 个单位同时寻路会瞬间卡帧。解法：① **分帧寻路**——把一次 A* 拆到多帧执行（每帧走 N 步），单位先朝大致方向移动再逐步修正；② **HPA\*（层次化）**——先在粗粒度图上找大致路径再细化，减少搜索节点；③ **Flow Field（流场）**——只对终点跑一次 Dijkstra 生成全场方向场，所有单位顺着流场走，O(1) 查询，RTS 首选。
6. **路径后处理让路径"看起来对"**：A* 输出的网格路径充满锯齿拐点，角色沿之字走很违和。① **路径平滑**（Funnel/字符串拉直）：去掉共线冗余拐点，只保留真正的转折；② **Catmull-Rom 样条**：在关键点间插值生成平滑曲线。寻路"算对"和"走好看"是两件事，后处理不可省略。

### 📖 深度展开

**1. A\* 核心算法实现（TypeScript，含二叉堆开放表）**

```typescript
interface Node { x: number; y: number; g: number; h: number; parent: Node | null; }
// f = g + h，开放表用最小堆按 f 排序
function astar(grid: number[][], start: [number,number], end: [number,number]): Node[] | null {
  const open = new MinHeap<Node>((a,b) => (a.g+a.h) - (b.g+b.h)); // 最小堆，按 f 排序
  const closed = new Set<string>();                                // 关闭表：O(1) 查重
  const key = (x:number,y:number) => `${x},${y}`;
  const heuristic = (x:number,y:number) => Math.abs(x-end[0]) + Math.abs(y-end[1]); // 曼哈顿

  const startNode: Node = { x:start[0], y:start[1], g:0, h:heuristic(start[0],start[1]), parent:null };
  open.push(startNode);

  while (open.size > 0) {
    const cur = open.pop();                       // 取 f 最小的节点 O(log n)
    if (cur.x === end[0] && cur.y === end[1]) return reconstruct(cur); // 到达终点
    closed.add(key(cur.x, cur.y));

    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) { // 4 邻居
      const nx = cur.x+dx, ny = cur.y+dy;
      if (grid[ny]?.[nx] === 1) continue;          // 1=障碍，跳过
      if (closed.has(key(nx, ny))) continue;       // 已扩展，跳过
      const tg = cur.g + 1;                         // 步进代价（对角线时为 √2）
      const existing = open.find(n => n.x===nx && n.y===ny);
      if (existing && existing.g <= tg) continue;   // 已有更优路径，跳过
      open.push({ x:nx, y:ny, g:tg, h:heuristic(nx,ny), parent:cur });
    }
  }
  return null; // 无路径
}
function reconstruct(node: Node): Node[] {           // 回溯父指针重建路径
  const path = []; let cur: Node | null = node;
  while (cur) { path.unshift(cur); cur = cur.parent; }
  return path;
}
```

**2. 启发式函数与寻路表示的对比**

```
不同 h(n) 的搜索行为（同一张 50×50 网格，左下到右上）：

h=0 (Dijkstra)：         曼哈顿 h：               Weighted A* (h×3)：
向四周均匀扩散            明确朝目标方向收束        高度集中在目标方向
探索 ~2500 节点           探索 ~400 节点           探索 ~80 节点
最优路径 ✅               最优路径 ✅               次优路径（快10倍）
████████████             ··········              ·········
████████████             ··██······              ···█·····
████████████             ····████··              ·····█···
S─────────E             S──────E                S──────E
```

| 寻路表示 | 节点数 | 路径质量 | 实现难度 | 适用场景 |
|---------|-------|---------|---------|---------|
| **方格网格** | 多（100²=1万） | 锯齿、生硬 | 低 | 塔防、roguelike |
| **NavMesh 多边形** | 少（几十~几百） | 自然、平滑 | 中高 | ✅ 3D RPG、ACT |
| **航点图(Waypoint)** | 最少（手动标） | 依赖标注密度 | 低 | 老式 FPS、竞速 |
| **体素(Voxel)** | 极多 | 可爬坡/飞行 | 高 | 我的世界类 |

**3. 分帧寻路：避免单帧卡顿**

```typescript
// 把一次完整 A* 拆成每帧最多走 stepBudget 步，单位先朝终点大致方向走
class SteppedAStar {
  private open: MinHeap<Node>; private closed: Set<string>;
  private done = false; path: Node[] | null = null;
  constructor(grid, start, end) { /* 初始化 open 表，push 起点 */ }

  // 每帧调一次，返回是否完成
  step(stepBudget: number): boolean {
    for (let i = 0; i < stepBudget && this.open.size > 0; i++) {
      const cur = this.open.pop();
      if (到达终点) { this.path = reconstruct(cur); return this.done = true; }
      // ... 扩展邻居 ...
    }
    return this.done; // 本帧预算用完，下帧继续
  }
}
// 用法：RTS 100 个单位排队寻路，每帧给每个单位 5 步预算，总耗时均摊不卡帧
```

### ⚡ 实战经验

- **h(n) 高估导致绕远路**：对角线移动地图却用了曼哈顿距离，h 低估了真实距离（对角线实际走 √2≈1.41 步，h 只算 1 步），虽仍最优但搜索范围膨胀。更糟的是曾把对角线代价设为 1 却用 `h=欧几里得`，欧几里得 < 对角线步进代价导致高估，路径出现明显绕远。解法：h 的度量方式必须与实际移动代价模型一致——八方向用对角线公式，四方向用曼哈顿。
- **开放表用数组导致 200ms 寻路**：早期实现用 `Array.sort()` 维护开放表，50×50 地图单次寻路 200ms。换成二叉堆后降到 3ms。教训：A* 的性能瓶颈 90% 在开放表的 push/pop，必须用堆（或配对堆/斐波那契堆）。这点踩过一次就刻在骨头里。
- **RTS 大量单位同时寻路卡帧**：50 个单位同时 A*，每帧 150ms 直接卡成幻灯片。改用 Flow Field——只对目标点跑一次 Dijkstra 生成全场距离场，所有单位 O(1) 查"下一步往哪走"，50 个单位寻路总耗时降到 2ms。RTS/MOBA 类大量同目标单位首选 Flow Field，A* 适合个体独立目标。
- **动态障碍物导致路径失效**：玩家放了一堵墙，已算好的路径穿墙了。解法：① 单位每移动几格检测前方是否被新障碍阻挡，是则触发重寻路（增量而非全量）；② 给路径加"有效期"，超时或环境变化时重算。完全重算太贵，完全信任旧路径会穿墙——折中是"信任 + 前瞻检测 + 按需重算"。
- **路径锯齿让角色走成机器人**：A* 网格路径全是直角拐弯，角色沿之字走极度违和。加 Funnel 算法拉直共线点 + Catmull-Rom 样条平滑后，角色走出的曲线丝滑自然。寻路"算到"和"走到好看"之间差一个后处理，这是新手最容易忽略的一步。

### 🔗 相关问题

1. 当地图完全动态（可破坏地形、实时建造）时，A* 每次重算代价太高，D\* Lite（增量式重规划）如何复用上一次的搜索结果只更新受影响的部分？它的适用边界是什么？
2. JPS（Jump Point Search）在均匀网格上比 A* 快 10-20 倍，原理是"跳过对称路径直接到关键决策点"。它为什么在 NavMesh 上不适用？什么场景下 JPS 是最优解？
3. 多单位寻路不仅要找路还要互相避让（不会全挤在一条路上），局部避障算法（RVO/ORCA/Boids）与全局 A* 寻路如何分层协作——A* 规划大方向，RVO 处理每帧微调？
