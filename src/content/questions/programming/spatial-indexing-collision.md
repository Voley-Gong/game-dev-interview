---
title: "空间索引与碰撞检测优化：如何高效处理上万物体的碰撞？"
category: "programming"
level: 3
tags: ["空间索引", "碰撞检测", "算法优化", "性能优化"]
related: ["programming/data-structures-game", "programming/memory-gc-optimization"]
hint: "暴力 O(n²) 不可行——用空间分区把碰撞查询从平方级降到近似线性。"
---

## 参考答案

### ✅ 核心要点

1. **两阶段策略是行业标准**：先 Broad Phase（粗筛，用包围盒快速排除不可能碰撞的对），再 Narrow Phase（精检，做几何相交计算如 SAT / GJK）。绝大多数对在粗筛阶段就被淘汰，精检只处理极少数候选。
2. **均匀网格（Uniform Grid）适合密度均匀的场景**：把空间切成等大格子，物体只与同格和相邻格内的物体检测。查询复杂度 O(n·k)，k 是格内平均物体数。2D 弹幕游戏、棋盘类首选。
3. **空间哈希（Spatial Hash）处理动态大世界**：用哈希函数将网格坐标映射到桶，无界世界也能用。物体移动时更新所属桶即可，增删都是 O(1)。
4. **BVH（层次包围盒）适合大小差异大的 3D 场景**：动态更新开销比网格大，但对不规则分布的物体查询效率更高。Cocos / Unity 引擎内部场景裁剪默认用 BVH。
5. **Sweep and Prune（扫掠剪枝）适合轴对齐稳定的物体**：按某轴排序后只检查区间重叠的对。实现简单，但物体频繁穿越排序轴时退化为 O(n²)。
6. **Narrow Phase 算法选型**：AABB 对 AABB 用坐标区间判断（最快）；凸多边形用 SAT（分离轴定理）；任意形状用 GJK（更通用但实现复杂）。

### 📖 深度展开

**1. 两阶段碰撞管线流程**

```
                    ┌──────────────┐
  N 个刚体 ────────►│ Broad Phase  │ AABB 包围盒粗筛
                    │  (空间索引)   │ 输出候选对列表
                    └──────┬───────┘
                           │ ~O(n) 候选对
                           ▼
                    ┌──────────────┐
                    │ Narrow Phase │ 精确几何相交
                    │  SAT / GJK   │ 输出碰撞法线 + 穿透深度
                    └──────┬───────┘
                           │ ~O(候选数 × 1)
                           ▼
                    ┌──────────────┐
                    │ Collision    │ 推力分离 / 触发回调
                    │ Response     │
                    └──────────────┘

  典型数据：10000 个物体
    暴力检测：     10000 × 9999 / 2 ≈ 5000万次  ❌
    Broad 后候选：  ~300 对                         ✅
    Narrow 后命中： ~12 对
```

**2. 均匀网格 + 空间哈希实现**

```typescript
class SpatialHashGrid {
  private cellSize: number;
  private cells: Map<string, Set<number>>; // "x,y" → 实体ID集合

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  // 插入：一个物体的 AABB 可能跨多个格子
  insert(id: number, minX: number, minY: number, maxX: number, maxY: number) {
    const x0 = Math.floor(minX / this.cellSize);
    const y0 = Math.floor(minY / this.cellSize);
    const x1 = Math.floor(maxX / this.cellSize);
    const y1 = Math.floor(maxY / this.cellSize);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        if (!this.cells.has(k)) this.cells.set(k, new Set());
        this.cells.get(k)!.add(id);
      }
    }
  }

  // 查询候选对：只检测同格内的物体
  queryPairs(): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    for (const set of this.cells.values()) {
      const ids = [...set];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          pairs.push([ids[i], ids[j]]);
        }
      }
    }
    return pairs; // 去重后交给 Narrow Phase
  }
}
```

**3. 各空间索引结构对比**

| 结构 | 构建复杂度 | 查询复杂度 | 动态更新 | 适用场景 | 内存开销 |
|------|-----------|-----------|---------|---------|---------|
| 暴力遍历 | O(1) | O(n²) | 无 | n < 50 | 极低 |
| 均匀网格 | O(n) | O(n·k) | O(1) | 2D 弹幕、等大物体 | 中（空格子浪费） |
| 空间哈希 | O(n) | O(n·k) | O(1) | 无限大世界、开放地图 | 低（按需分配） |
| 四叉树/八叉树 | O(n·log n) | O(log n) | O(log n) | 3D 场景、密度不均 | 中 |
| BVH 树 | O(n·log n) | O(log n) | O(log n) | 3D 场景裁剪、光线投射 | 低 |
| Sweep & Prune | O(n·log n) | O(n+k) | O(1) 增量 | 轴稳定、2D 物理 | 极低 |

> **经验法则**：cellSize 取物体平均直径的 1～2 倍，格内物体数 k 才能稳定在常数级。太小则格子数爆炸、缓存 miss 上升；太大则退化为暴力遍历。

### ⚡ 实战经验

- **弹幕游戏用均匀网格立竿见影**：一个射击游戏同屏 800 发子弹 + 50 个敌人，暴力遍历每帧 42 万次检测（~18ms）。换成 cellSize = 64px 的网格后，候选对降到 ~200 个，碰撞检测降到 0.3ms，帧时间从 22ms 降到 4ms。
- **空间哈希的 key 拼接是性能陷阱**：最初用字符串模板 `` `${cx},${cy}` `` 做 key，每帧产生上万次字符串分配，GC 压力暴增。改用位运算打包 `(cx & 0xFFFF) << 16 | (cy & 0xFFFF)` 转成单个 number 做 key，Map 查找快了 3 倍且零分配。
- **四叉树动态更新比想象中贵**：粒子频繁移动时每帧都要从树中删除再插入，树会退化（子树不平衡）。实际项目中发现动态场景下均匀网格 + 空间哈希反而比四叉树快 2 倍，因为网格增删是纯 O(1)。
- **Broad Phase 的 AABB 宽松度要调**：AABB 太紧导致物体旋转后频繁"进出"格子触发重排；太宽则候选对暴增。实测物理类游戏 AABB 外扩 10%～15% 的 padding 是甜点区。
- **多线程碰撞检测注意数据竞争**：将物体按空间分区分配给不同 Worker 并行做 Narrow Phase 是安全的（不同区域不会互相碰撞），但边界格的候选对必须在主线程二次确认。

### 🔗 相关问题

1. GJK（Gilbert-Johnson-Keerthi）算法是如何检测任意凸多边形碰撞的？和 SAT 比有什么优劣？
2. 连续碰撞检测（CCD）是什么？为什么高速移动物体（如子弹）需要它？
3. 在 ECS 架构中如何高效查询"某范围内所有实体"？空间索引该由哪个 System 管理？
