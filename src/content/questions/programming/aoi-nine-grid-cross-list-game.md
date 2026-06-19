---
title: "MMO 的视野管理怎么实现？AOI 九宫格和十字链表算法有什么区别？"
category: "programming"
level: 3
tags: ["AOI", "视野管理", "空间索引", "网络同步", "MMO", "九宫格", "十字链表"]
related: ["programming/network-sync-game", "programming/spatial-hash-grid-game", "programming/ring-buffer-game"]
hint: "不是全服广播——是按视野过滤：每个玩家只收视野内实体的状态变化"
---

## 参考答案

### ✅ 核心要点

1. **AOI（Area of Interest）解决多玩家广播的 N² 爆炸**：一个场景 1000 个玩家互相广播移动，每帧就是 100 万条消息——服务器 CPU 和带宽都顶不住。AOI 的核心是"按视野过滤"：每个玩家只接收自己视野半径内其他实体的状态变化，视野外的怪物跑动、玩家施法一律不下发，把 N² 降到接近 O(N)。
2. **九宫格算法：地图按视野大小切网格**：把整张地图切成 `视野半径 × 视野半径` 的方格（视野 = 3×3 格），实体落格后只关心自身所在格 + 周围 8 格的实体。玩家移动跨格时触发"离开旧 9 格 / 进入新 9 格"的增删消息——简单、缓存友好、适合实体密集的 MMO。
3. **十字链表（Cross-Linked List）：X 轴 + Y 轴各一条有序链表**：所有实体按 X 坐标排序插入 X 链表，同时按 Y 坐标排序插入 Y 链表。查询视野时从当前实体出发，沿 X 链向左右扫描、沿 Y 链向上下扫描，取交集。实体移动只需链表内局部重排（平均 O(1)），比九宫格更适合实体稀疏、移动频繁的场景。
4. **三种核心事件：Enter / Leave / Move**：实体进入观察者视野发 `Enter`（创建实体、下发基础信息），离开发 `Leave`（销毁实体），视野内移动发 `Move`（增量坐标）。客户端维护一个"视野内实体集合"，只渲染这个集合——这和九宫格/十字链表的实现无关，是 AOI 的统一对外契约。
5. **服务器 AOI 是核心，客户端 AOI 锦上添花**：服务器 AOI 决定"哪些消息发给谁"，是带宽和 CPU 的关键优化（不做 AOI，万人战场直接 OOM）。客户端 AOI 用于屏幕外裁剪（不渲染屏幕外怪物）、UI 遮罩（屏幕外飘字不显示），是渲染性能优化——两者算法可以不同，服务器常用九宫格，客户端常用视锥裁剪。
6. **灯塔算法（LightCube）是九宫格的分级扩展**：把地图按不同精度切多层格子（粗格 + 细格），远距离用粗格（少消息）、近距离用细格（高精度）。适合超大规模战场（千人同屏），是九宫格在实体数量极大时的进阶方案。

### 📖 深度展开

**1. 九宫格算法：格子划分 + 邻域查询**

```
地图切成 cellSize × cellSize 的方格（cellSize = 视野半径）
玩家 P 在 (5,5)，视野 = 3×3 邻域（P 所在格 + 周围 8 格）

      x→
   ┌──┬──┬──┬──┬──┬──┐
y  │..│..│..│..│..│..│
↓  ├──┼──┼──┼──┼──┼──┤
   │..│ A│ B│ C│..│..│   P 所在 3×3:
   ├──┼──┼──┼──┼──┼──┤     A B C
   │..│ D│ P│ E│..│..│     D P E   ← 只下发这 9 格内实体的状态
   ├──┼──┼──┼──┼──┼──┤     F G H
   │..│ F│ G│ H│..│..│   视野外（..）的实体不进入 P 的消息流
   ├──┼──┼──┼──┼──┼──┤
   │..│..│..│..│..│..│
```

```typescript
class NineGridAOI {
  private cellSize: number;              // 格子边长 = 视野半径
  private grid = new Map<string, Set<Entity>>();  // "gx,gy" → 实体集合

  private key(gx: number, gy: number): string { return `${gx},${gy}`; }
  private toGrid(x: number, y: number): [number, number] {
    return [Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)];
  }

  // 玩家 P 的视野内实体 = 自身格 + 8 邻格的所有实体
  *queryViewers(p: Entity): Iterable<Entity> {
    const [px, py] = this.toGrid(p.x, p.y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.grid.get(this.key(px + dx, py + dy));
        if (cell) for (const e of cell) if (e.id !== p.id) yield e;
      }
    }
  }

  // 实体移动跨格时触发 Enter/Leave 事件
  onMove(entity: Entity, newX: number, newY: number): void {
    const [oldGx, oldGy] = this.toGrid(entity.x, entity.y);
    const [newGx, newGy] = this.toGrid(newX, newY);
    entity.x = newX; entity.y = newY;
    if (oldGx === newGx && oldGy === newGy) return;  // 格内移动，无需重算
    // 跨格：从旧格移除、加入新格，并对受影响玩家广播 Enter/Leave
    this.grid.get(this.key(oldGx, oldGy))!.delete(entity);
    this.getOrCreate(newGx, newGy).add(entity);
    this.notifyBoundaryCross(entity, oldGx, oldGy, newGx, newGy);
  }
  private getOrCreate(gx: number, gy: number): Set<Entity> {
    const k = this.key(gx, gy);
    let s = this.grid.get(k); if (!s) { s = new Set(); this.grid.set(k, s); }
    return s;
  }
}
```

**2. 十字链表：X/Y 双链表的十字扫描**

```
实体按 X 坐标排序的 X 链表（水平），按 Y 排序的 Y 链表（垂直）：

X 链表（按 x 升序）:  E1(x=2) ⟷ E2(x=5) ⟷ [P(x=8)] ⟷ E3(x=11) ⟷ E4(x=15)
                                         ↑ 向左扫到视野边界 x_min
                                                              ↑ 向右扫到 x_max
Y 链表（按 y 升序）:  E2(y=1) ⟷ E1(y=4) ⟷ [P(y=7)] ⟷ E4(y=9) ⟷ E3(y=13)

查询 P 视野 = X 链向左右扫 ∩ Y 链向上下扫 = 同时满足的实体集合
  → E2 既在 X 视野范围又在 Y 视野范围 → 在视野内 ✓
  → E3 在 X 范围但 Y 超出（y=13 > y_max）→ 不在视野 ✗
```

```typescript
// 十字链表：实体同时挂在两条有序链表上，移动时局部重排
class CrossLinkedListAOI {
  private xHead: Entity | null = null;  // 按 x 升序
  private yHead: Entity | null = null;  // 按 y 升序
  private viewRadius: number;

  queryViewers(p: Entity): Entity[] {
    const result: Entity[] = [];
    const xMin = p.x - this.viewRadius, xMax = p.x + this.viewRadius;
    // 沿 X 链向左扫到 xMin，收集候选；再用 Y 链过滤
    let cur = p.xPrev;
    while (cur && cur.x >= xMin) {
      if (Math.abs(cur.y - p.y) <= this.viewRadius) result.push(cur);
      cur = cur.xPrev;
    }
    cur = p.xNext;
    while (cur && cur.x <= xMax) {
      if (Math.abs(cur.y - p.y) <= this.viewRadius) result.push(cur);
      cur = cur.xNext;
    }
    return result;
  }
  // 插入：X 链和 Y 链各做一次有序插入（平均 O(1)，因实体局部聚集）
}
```

**3. 三种 AOI 算法对比：选型看实体密度和移动模式**

| 算法 | 数据结构 | 查询复杂度 | 移动开销 | 适用场景 | 缺点 |
|------|---------|-----------|---------|---------|------|
| **九宫格** | 二维哈希网格 | O(1) 定位 + O(9) 邻域 | 跨格才重算（多数帧 O(0)） | 实体密集、均匀分布（MMO 主城） | 视野非方形时浪费；格子边界抖动 |
| **十字链表** | X 链 + Y 链（双向） | O(视野内实体数) | 每次移动链表重排 O(1)~O(n) | 实体稀疏、分布不均（野外、战场） | 指针维护复杂；并发难 |
| **灯塔 LightCube** | 多层九宫格（粗+细） | O(9) 粗 + O(9) 细 | 多层格同时更新 | 超大规模（千人同屏战场） | 实现复杂；调参难 |
| **视锥裁剪**（客户端） | 四叉树/BVH | O(log n) | 高（每帧重建） | 客户端渲染裁剪 | 不适合网络广播决策 |

### ⚡ 实战经验

- **九宫格的 cellSize 必须等于视野半径**：曾把格子切得太小（cellSize = 视野半径 / 2），结果查询要扫 5×5 = 25 格，消息量翻 3 倍；切得太大（cellSize = 2× 视野），格内实体过多单格遍历变慢。经验值：`cellSize = 视野半径`，正好覆盖 3×3 邻域，查询恒定 9 格，最稳。
- **跨格抖动用滞回区（hysteresis）消除**：玩家在格子边界来回走，每帧触发 Enter/Leave 风暴，客户端实体反复创建销毁画面闪烁。解决：进入视野立即发 Enter，离开视野延迟 500ms 发 Leave（若期间又回到视野则取消）——抖动期间实体保持可见，消息量降 80%。
- **十字链表在万人战场比九宫格快 3 倍**：某 MOBA 大乱斗模式 80 人同屏，九宫格每帧查询扫描大量空格（实体集中在中心），CPU 占 15%。改用十字链表后只扫实际在视野内的实体（外围大量空区域被跳过），CPU 降到 5%——稀疏分布场景十字链表的"只扫有实体的地方"优势明显。
- **Enter 消息要带上实体全量初始状态**：只发坐标的话，客户端收到 Enter 时不知道这是怪物还是玩家、什么模型、多少血量。约定 `Enter = { id, type, modelId, hp, maxHp, pos, ... }`，一次性下发——曾漏了 modelId 字段，怪物进入视野时客户端用默认模型渲染，玩家看到一堆"史莱姆"其实是 Boss，被投诉。
- **客户端 AOI 和服务器 AOI 用不同算法**：服务器用九宫格决定网络下发（带宽优先），客户端用视锥裁剪决定渲染（GPU 优先）。两者职责不同，别试图用一套算法覆盖——曾有同事让客户端也跑九宫格，结果屏幕角落的怪物（视锥内但不在 3×3 邻格）不渲染，而屏幕外远处的怪物（在邻格但视锥外）白白绘制浪费 GPU。

### 🔗 相关问题

1. 帧同步游戏（格斗/RTS）需要 AOI 吗？所有玩家看到同一画面时 AOI 还有意义吗？
2. 玩家快速移动（坐骑、传送）时 AOI 会产生大量 Enter/Leave 风暴，如何做平滑过渡和消息合并？
3. 九宫格的格子边界附近，实体的视野查询精度怎么保证？是否需要圆形视野修正（角落距离 > 视野半径的实体该不该下发）？
