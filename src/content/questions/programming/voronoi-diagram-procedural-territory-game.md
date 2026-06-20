---
title: "Voronoi 图在游戏中如何实现？领土划分、城市分布与生物群落边界生成"
category: "programming"
level: 3
tags: ["算法", "计算几何", "Voronoi", "程序化生成", "领土系统"]
related: ["programming/procedural-noise-generation", "programming/computational-geometry-game", "programming/graph-algorithms-game"]
hint: "RTS 的势力领地、文明类游戏的城市辐射圈、程序化地图的自然生物群落边界——背后都是同一张 Voronoi 图。"
---

## 参考答案

### ✅ 核心要点

1. **Voronoi 图定义：给定一组「站点（site）」，每个站点控制离它最近的所有区域**：整张平面被划分成若干个凸多边形单元（cell），每个单元内的所有点到「它的站点」的距离都小于到任何其他站点的距离。单元之间的边界就是两个站点「中垂线」的一部分。游戏里：RTS 的势力领地（每个基地是一个站点，领地是它的 Voronoi 单元）、文明类游戏的城市文化辐射圈、程序化地图的「自然生物群落」分布，全都是 Voronoi 图的直接应用。
2. **三种主流生成算法，性能差异巨大**：① 朴素法——对每个像素遍历所有站点求最近，O(像素数 × 站点数)，256×256 图 × 50 站点要 320 万次距离计算；② Fortune 扫描线算法——经典 O(n log n)，但实现极复杂（涉及抛物线弧、事件队列、海滩线数据结构）；③ Jump Flooding Algorithm（JFA）——专为 GPU 设计，把 Voronoi 当作「特殊 Flood Fill」，在 GPU 上并行跑，512×512 图 × 1000 站点仅需 ~1ms。游戏项目里 JFA 是性价比最高的选择。
3. **Lloyd 松弛（Lloyd Relaxation）让站点分布更均匀**：纯随机的站点会让某些单元特别大、某些特别小，看起来不自然。Lloyd 松弛迭代地「把每个站点移到它当前单元的质心」，重复 2-5 次后站点分布趋于均匀，生成的领地形状更接近现实国家版图。这是《文明》《群星》等程序化地图游戏让领土看起来「合理」的关键后处理。
4. **Voronoi 图的对偶图是 Delaunay 三角剖分——直接生成道路/贸易路线**：Voronoi 两个相邻单元的站点之间连一条边，就得到 Delaunay 三角剖分。游戏中：城市（Voronoi 站点）之间的天然贸易路线、程序化大陆之间的航道、神经网络式关卡连接图，都可以直接从 Delaunay 图提取，省去手动设计路网。
5. **加权 Voronoi（Power Diagram）模拟不对称影响力**：标准 Voronoi 假设所有站点「影响力相同」，但游戏里大城市的辐射范围显然大于小村庄。加权 Voronoi 给每个站点一个权重（如人口、军力），距离公式从「欧氏距离」改成「`dist² - weight`」，权重大的站点占据更大单元。这正是 RTS「按军力动态划分势力范围」的底层算法。

### 📖 深度展开

**1. Jump Flooding Algorithm（JFA）：GPU 友好的 Voronoi 生成**

```typescript
/**
 * JFA 把 Voronoi 看作"特殊的 Flood Fill"：
 * 从每个站点同时向外泛洪，每步步长折半（n/2, n/4, ..., 1）
 * 每个像素记录"已知最近的站点"，传播过程中不断更新
 * 复杂度 O(n log n)，且天然可并行（每个像素独立计算）
 */
function jumpFloodingVoronoi(
  width: number, height: number,
  sites: Array<{ x: number; y: number; id: number }>
): Int32Array {
  // nearestSite[idx] = 当前像素已知最近的站点 id（-1 表示未知）
  let nearestSite = new Int32Array(width * height).fill(-1);
  const siteX = new Float32Array(sites.length);
  const siteY = new Float32Array(sites.length);
  sites.forEach((s, i) => { siteX[i] = s.x; siteY[i] = s.y; });

  // 初始化：站点像素标记为自己
  for (const s of sites) {
    nearestSite[s.y * width + s.x] = s.id;
  }

  // 步长从 max(w,h)/2 折半到 1
  for (let step = Math.max(width, height) >> 1; step >= 1; step >>= 1) {
    const next = new Int32Array(nearestSite);   // 双缓冲：读 old，写 new
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        let bestId = nearestSite[idx];
        let bestDist = bestId >= 0
          ? dist2(x, y, siteX[bestId], siteY[bestId]) : Infinity;
        // 检查 8 个方向的"跳跃"邻居（步长为 step）
        for (let dy = -step; dy <= step; dy += step) {
          for (let dx = -step; dx <= step; dx += step) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const candId = nearestSite[ny * width + nx];
            if (candId < 0) continue;
            const d = dist2(x, y, siteX[candId], siteY[candId]);
            if (d < bestDist) { bestDist = d; bestId = candId; }
          }
        }
        next[idx] = bestId;
      }
    }
    nearestSite = next;
  }
  return nearestSite;   // 每个像素的归属站点 id → 上色即得 Voronoi 图
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;    // 用距离平方省去开方，比较结果不变
}
```

```
JFA 传播过程（步长折半）：

  step=4:   ● · · · · · · ·        站点(●)向 8 方向跳 4 格传播
            · · · · · · · ·
            · · · · · · · ·
            · · · · · · · ·
            · · · · ▲ · · ·        ← 中间像素收到 4 格外站点的"我最近"

  step=2:   每个已知像素再向 8 方向跳 2 格，更新更近的站点
  step=1:   最后一步精细传播，每个像素确定最终归属

  总共 log₂(maxDim) 轮，每轮 O(像素数) → 在 GPU 上每像素并行，极快
```

**2. 三种 Voronoi 生成算法对比**

| 算法 | 复杂度 | 实现难度 | 适合平台 | 典型耗时 (512²×500站点) |
|------|--------|---------|---------|------------------------|
| **朴素逐像素** | O(W·H·N) | 极低 | CPU | ~800ms |
| **Fortune 扫描线** | O(N log N) | 极高（事件队列+海滩线） | CPU | ~3ms（但代码 500+ 行） |
| **JFA（CPU 版）** | O(W·H·log N) | 中 | CPU | ~25ms |
| **JFA（GPU/WebGL）** | O(W·H·log N) | 中高（着色器） | GPU | **~1ms** |
| **加权 Power Diagram** | O(N log N) | 极高 | CPU/GPU | ~5ms |

**3. Lloyd 松弛 + 生物群落应用**

```typescript
/** Lloyd 松弛：让站点分布更均匀（领地更"自然"） */
function lloydRelaxation(
  sites: Array<{x:number;y:number}>,
  nearestSite: Int32Array, width: number, height: number,
  iterations: number = 3
): Array<{x:number;y:number}> {
  let current = sites.map(s => ({ ...s }));
  for (let iter = 0; iter < iterations; iter++) {
    // 1) 用当前站点生成 Voronoi（JFA）
    const voronoi = jumpFloodingVoronoi(width, height,
      current.map((s, i) => ({ ...s, id: i })));
    // 2) 计算每个单元的质心，把站点移到质心
    const sumX = new Float64Array(current.length);
    const sumY = new Float64Array(current.length);
    const cnt = new Uint32Array(current.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const id = voronoi[y * width + x];
        if (id >= 0) { sumX[id] += x; sumY[id] += y; cnt[id]++; }
      }
    current = current.map((_, i) => cnt[i] > 0
      ? { x: sumX[i] / cnt[i], y: sumY[i] / cnt[i] }
      : current[i]);
  }
  return current;   // 3 次迭代后，单元大小趋于一致，版图更自然
}
```

```
程序化大陆生成（Voronoi + 高度图）：

  1. 随机撒 200 个站点 → Voronoi 划分大陆"省份"
  2. Lloyd 松弛 3 次 → 省份边界自然均匀
  3. 每个站点赋一个"海拔值"（来自 Perlin 噪声）
       高海拔站点 → 山脉生物群落
       低海拔 + 内陆 → 森林/平原
       低海拔 + 边缘 → 海洋/海岸
  4. Delaunay 对偶图 → 省份间的天然道路/贸易路线
  5. 加权 Voronoi（按省份人口）→ 城市文化辐射范围

  结果：一张看起来"合理"的程序化世界地图
       ——《文明》《群星》《无限迷宫》都用了类似管线
```

### ⚡ 实战经验

- **朴素算法在生成大地图时卡死**：早期版本用逐像素遍历求最近站点生成 1024×1024 的领土图，100 个势力站点，耗时 4.5 秒，玩家开局要盯着加载条。迁移到 JFA（CPU 版 + WebWorker）后降到 180ms，再上 GPU（WebGL 片段着色器）后 8ms，终于能「即时重新划分势力范围」（玩家攻打下一座城，领地实时变色）。
- **JFA 的 1F+1F+1F 变体消除边界瑕疵**：标准 JFA 在某些站点配置下会留下 1-2 像素的「锯齿边界」和错误归属。用「1F+1F+1F」变体（步长序列：大步、大步、...、1、1、1，末尾多跑几轮 step=1）后边界完全精确，代价是多 2-3 轮迭代，但 GPU 上仍 < 2ms，完全可接受。
- **Lloyd 松弛过度会让地图失去趣味**：某次迭代调到 8 次，结果所有省份变成大小几乎相同的六边形蜂窝，玩家反馈「每个国家长得一样，没特色」。降到 2-3 次后保留了大小差异（大国小国）但形状仍自然。Lloyd 不是「越多越好」，2-3 次是「自然但不死板」的甜点区。
- **加权 Voronoi 让 RTS 势力范围动态化**：原版领土用标准 Voronoi（固定），玩家觉得「我打下整片地图，领地还是原来的形状」。改成加权 Power Diagram（权重 = 该基地驻军数）后，重兵把守的基地辐射范围明显扩大，战场前线随交战实时推移，策略感大幅提升。实现上只是距离公式从 `d²` 改成 `d² - weight`，JFA 主体不用动。
- **Voronoi 边界提取用于寻路障碍**：需要把领地边界变成可碰撞的墙，但 Voronoi 单元是连续多边形，游戏要离散网格。做法：遍历 `nearestSite` 数组，相邻像素归属不同站点即为边界像素，标记为不可通行。比直接用多边形求交快 10 倍，且天然适配网格寻路（A*）。注意边界宽度要 ≥ 1 格，否则小体型单位会穿墙。

### 🔗 相关问题

1. Delaunay 三角剖分和 Voronoi 图的对偶关系如何用代码实现？给定 Voronoi 结果，如何 O(N) 提取出 Delaunay 图用于道路/贸易路线生成？
2. 球面上的 Voronoi（球面距离而非欧氏距离）如何实现？这关系到《群星》这类星际游戏在球面星图上的势力划分。
3. 当站点数极多（上万个城市）时，JFA 的 log N 轮迭代仍可能不够快，能否用「分层 Voronoi」（先粗分再细分）或 BVH 加速最近邻查询来进一步优化？
