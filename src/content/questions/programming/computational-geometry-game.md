---
title: "计算几何在游戏中怎么用？点在多边形内/线段相交/凸包"
category: "programming"
level: 3
tags: ["计算几何", "凸包", "碰撞检测", "导航网格", "算法"]
related: ["programming/spatial-indexing-collision", "programming/segment-tree-range-query", "programming/game-math-vector-matrix"]
hint: "点击是否命中不规则 UI 区域、光线是否穿墙、导航网格的凸多边形判定——这些背后是同一组计算几何原语。"
---

## 参考答案

### ✅ 核心要点

1. **几何谓词（orientation/CCW）是所有算法的地基**：用向量叉积判断三个点的转向——`cross(b-a, c-a) > 0` 为逆时针、`<0` 为顺时针、`=0` 共线。这是点在多边形内、线段相交、凸包等几乎所有 2D 计算几何算法的核心原语，比直接算斜率更鲁棒（避免除零、避开大量浮点除法误差）。
2. **点在多边形内：射线法 O(n)，绕数法处理边界更稳**：从待测点向右发射水平射线，数与多边形边的交点数——奇数在内、偶数在外（射线法）。绕数法（Winding Number）累加有向角度，对自交多边形和边界穿越情形判定更准确。游戏里点击拾取不规则 UI 形状、判断单位是否进技能范围圈（多边形近似）都用它。
3. **线段相交：跨立实验 + 快速排斥**：两条线段相交 ⟺ 每条线段的两个端点分别在另一条线段的两侧（用 orientation 判断），再加一个包围盒快速排斥（bbox 不重叠直接 false）。这是视野遮挡裁剪、子弹弹道命中、线技能（如刀光）判定的底层。
4. **凸包：Andrew 单调链 O(n log n)**：给一堆散点（如关卡中的障碍顶点）求最小凸包围，Andrew 算法先按 x 排序，再分别从左到右、右到左扫描维护上下凸壳，代码比 Graham 扫描短且不易错。凸包用于：碰撞用 SAT 检测凸形状、计算最小包围盒做剔除、生成导航区域的凸多边形。
5. **凸多边形碰撞用 SAT（分离轴定理）**：两个凸多边形不相交 ⟺ 存在一条轴（某条边的法线）使它们在该轴上的投影不重叠。凸 vs 凸只要检查所有边的法线轴即可 O(n+m)，比 GJK 更直观。导航网格保证每个区域是凸多边形正是为了让 SAT/寻路能高效工作。
6. **浮点鲁棒性是隐形杀手**：计算几何对精度极敏感——共线判定 `cross==0` 在浮点下几乎永远不成立，必须用 `|cross| < eps`。eps 取值要结合坐标尺度（像素级用 1e-6，世界坐标用 1e-4），方向判断用整数坐标或定点数能彻底消除误差，这是联机帧同步项目不崩盘的硬要求。

### 📖 深度展开

#### 1. 几何谓词 + 点在多边形内（射线法）

```typescript
type P = { x: number; y: number };
// 叉积：>0 左转(逆时针) <0 右转(顺时针) =0 共线
function cross(o: P, a: P, b: P): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
// 射线法：点 p 在多边形 poly 内？O(n)。处理水平边避免交点歧义
function pointInPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    // 判断水平射线 y=p.y 是否穿过边 a-b（一端在上、一端在下）
    const intersect = (a.y > p.y) !== (b.y > p.y) &&
      p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside; // 每穿一次翻转
  }
  return inside;
}
```

#### 2. 线段相交 + 快速排斥

```typescript
// 两线段 (p1,p2) 与 (p3,p4) 是否规范相交？
function segmentsIntersect(p1: P, p2: P, p3: P, p4: P): boolean {
  // 快速排斥：bbox 不重叠直接 false，剪掉大多数不相交情形
  if (Math.max(p1.x, p2.x) < Math.min(p3.x, p4.x) ||
      Math.max(p3.x, p4.x) < Math.min(p1.x, p2.x) ||
      Math.max(p1.y, p2.y) < Math.min(p3.y, p4.y) ||
      Math.max(p3.y, p4.y) < Math.min(p1.y, p2.y)) return false;
  // 跨立实验：p3p4 在 p1p2 两侧 且 p1p2 在 p3p4 两侧
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
```

#### 3. 凸包：Andrew 单调链

```typescript
// 返回顺时针排列的凸包顶点。O(n log n)
function convexHull(points: P[]): P[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const build = (lower: boolean): P[] => {
    const hull: P[] = [];
    for (const p of pts) {
      while (hull.length >= 2) {
        const o = hull[hull.length - 2], a = hull[hull.length - 1];
        // lower 取右转(顺时针 cross<=0)，upper 取左转
        if ((cross(o, a, p) <= 0) === lower) break;
        hull.pop();
      }
      hull.push(p);
    }
    hull.pop(); // 去掉与另一端重复的端点
    return hull;
  };
  return [...build(true), ...build(false).reverse()];
}
```

```
散点求凸包（Andrew 单调链）：
    点集排序后，分别扫下凸壳和上凸壳：
        •           •  ← 上凸壳从右到左
       / \         /
      •   •       •
      |    \     /
      •     •---•     ← 下凸壳从左到右
      合并上下壳 = 完整凸包（虚线为内部被弹出的点）
    每个点最多入栈出栈一次 → 总 O(n)，排序占主导 O(n log n)
```

#### 4. 算法复杂度与选型对比

| 问题 | 朴素法 | 优化法 | 复杂度 | 游戏应用 |
|------|--------|--------|--------|---------|
| 点在多边形内 | 三角化后逐个判 | 射线法/绕数法 | O(n) | 点击拾取、范围判定 |
| 线段相交 | 两两判 O(n²) | 扫描线+事件队列 | O((n+k)log n) | 视野裁剪、弹道 |
| 凸包 | 暴力枚举三点 | Andrew/Graham | **O(n log n)** | 碰撞包围、剔除 |
| 凸多边形碰撞 | 逐边检测 | **SAT 分离轴** | O(n+m) | 物理碰撞、技能命中 |
| 最近点对 | 两两算 O(n²) | 分治 | O(n log n) | 散弹命中、吸引范围 |
| 凸多边形距离 | — | GJK | O(n+m) | 碰撞响应、分离向量 |

### ⚡ 实战经验

- **浮点 eps 选错会「时灵时不灵」**：曾做过一个点击拾取，玩家偶发点不中——因为 `cross==0` 共线判定在浮点下失效，边界点被随机判进或判出。解法是统一用 `Math.abs(cross) < 1e-6` 做共线判定，且像素坐标直接取整做整数运算彻底回避除法误差。联机帧同步项目更应全程用整数/定点数，否则两端判定不一致直接导致不同步。
- **凹多边形先凸分解再做 SAT**：SAT 只对凸形状成立。关卡里的房间轮廓常常是凹的，直接 SAT 会漏判碰撞。标准做法是预处理把凹多边形凸分解（Hertel-Mehlhorn）成若干凸块，运行时两两凸块判碰撞。导航网格保证每个区域是凸的，正是为了免掉这步分解、直接用 SAT 和寻路。
- **大量点查询必须配空间索引**：用射线法判断「上万个粒子是否在技能多边形内」是 O(n×m) 的灾难。先对多边形建 BVH/AABB 树或用网格分桶，把候选点缩到局部，再做多边形精确判定，实测万级粒子从 30ms 降到 1ms 内。
- **凸包预处理是碰撞优化的利器**：复杂形状（如角色由几十个部件组成）每帧两两碰撞开销巨大。离线对所有障碍顶点求一次凸包，运行时只对凸包做 SAT，边数从几十降到十几，且 SAT 复杂度正比于边数。代价是精度下降，对「判定是否大致挡住」的视野/ LOS 判定足够，精确命中仍需原始形状。

### 🔗 相关问题

- GJK 算法如何用 Minkowski 差和单纯形求两个凸多边形的最短距离？
- 如何用扫描线算法在 O((n+k)log n) 内求所有相交线段对（视野遮挡裁剪）？
- 帧同步游戏里，如何保证计算几何判定在所有客户端完全一致（定点数方案）？
