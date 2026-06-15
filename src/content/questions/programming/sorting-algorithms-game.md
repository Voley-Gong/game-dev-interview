---
title: "游戏开发中哪些场景需要排序算法？怎么选？"
category: "programming"
level: 2
tags: ["排序", "算法", "排行榜", "深度排序", "Top-K", "性能优化"]
related: ["programming/data-structures-game", "programming/bit-manipulation-game"]
hint: "排序不是 LeetCode 题目——UI 渲染顺序、2D 深度排序、排行榜、伤害飘字，全靠它，而且选错算法会掉帧。"
---

## 参考答案

### ✅ 核心要点

1. **游戏里排序无处不在**：2D/3D 物体的渲染顺序（透明物体必须从后往前画）、UI 层级、伤害飘字、背包按品质排序、排行榜——选错算法每帧几万次排序直接掉帧。
2. **稳定性很重要**：不稳定排序（快排）可能让相同 Y 坐标的物体帧间抖动闪烁，稳定排序（归并/TimSort）保证相对顺序不变，视觉稳定。
3. **Top-K 用堆而不是全排序**：排行榜只需要前 100 名，对 100 万玩家全排序是 O(n log n) 浪费，用最小堆维护 K 个最大值只需 O(n log K)。
4. **几乎排好序的数据用插入排序最快**：每帧物体只移动一点点，整体接近有序，插入排序 O(n) 几乎是常数级，比快排快一个数量级。
5. **引擎内置排序通常够用**：Cocos/Unity 的 `sort()` 底层是 TimSort（V8 也是），混合了归并和插入排序，对现实数据已经优化得很好，除非有特殊需求否则别自己造。
6. **排序键的设计比算法本身更关键**：把 `a.y - b.y` 换成预计算的整数 depth key，能避免每帧浮点比较，也能利用基数排序（O(n)）大幅提速。

### 📖 深度展开

**1. 主流排序算法在游戏场景的适用性**

```
按数据规模和特征选算法：

数据量 < 16 且近似有序  →  插入排序  (每帧物体微调，O(n))
数据量 中等 + 需要稳定   →  TimSort   (V8 Array.sort 底层)
只需前 K 名             →  最小堆     (排行榜，O(n log K))
整数键 + 海量数据        →  基数排序   (depth key，O(n))
链表结构                →  归并排序   (不依赖随机访问)
```

| 算法 | 平均 | 最坏 | 稳定 | 游戏典型场景 | 陷阱 |
|------|------|------|------|-------------|------|
| 快排 | O(n log n) | O(n²) | ❌ | 通用排序（引擎默认不一定用它） | 已排序数据退化 |
| 归并 | O(n log n) | O(n log n) | ✅ | 链表、外部排序 | 需要 O(n) 额外空间 |
| TimSort | O(n log n) | O(n log n) | ✅ | V8 `Array.sort` 底层 | 对随机数据无优势 |
| 插入排序 | O(n²) | O(n²) | ✅ | 近似有序的逐帧排序 | 大规模乱序灾难 |
| 堆排序 | O(n log n) | O(n log n) | ❌ | Top-K 维护 | 缓存不友好 |
| 基数排序 | O(n) | O(n) | ✅ | 整数 depth key | 仅限整数键 |

**2. 2D 游戏的 Y 轴深度排序（最经典的应用）**

```
俯视角 2D 游戏中，"下面的"物体（Y 大）应该遮挡"上面的"：

渲染顺序（从小 Y 到大 Y）：
  树(y=100) → 角色A(y=300) → 角色B(y=350) → 石头(y=500)
       ↑ 先画（被遮挡）              ↑ 后画（遮挡前者）

错误：用不稳定排序导致同 Y 的 A/B 每帧顺序变化 → 闪烁
```

```typescript
// ❌ 每帧新建比较函数 + 不稳定排序
renderables.sort((a, b) => a.y - b.y);  // 快排，同 Y 会抖

// ✅ 预计算整数 depth key + 稳定排序，避免每帧浮点比较
interface Renderable {
  node: Node;
  depthKey: number;  // 在移动时更新：depthKey = Math.round(y * 100)
}

// 移动时更新一次 key（不是每帧重算）
function onPositionChanged(r: Renderable, newY: number) {
  r.depthKey = Math.round(newY * 100);
}

// 渲染前：TimSort 稳定排序，近似有序时接近 O(n)
renderables.sort((a, b) => a.depthKey - b.depthKey);
```

> 💡 进一步优化：depthKey 是整数时可用计数排序/基数排序做到 O(n)，对上千个物体的场景提速明显。

**3. 排行榜的 Top-K（堆的经典应用）**

```typescript
// 100 万玩家只要前 100 名 —— 最小堆维护 K 个最大值
class MinHeap {
  private h: number[] = [];  // 存的是 score，实际场景存 {score, playerId}
  constructor(private k: number) {}

  push(score: number) {
    if (this.h.length < this.k) {
      this.h.push(score);
      this.bubbleUp(this.h.length - 1);
    } else if (score > this.h[0]) {
      this.h[0] = score;       // 踢掉堆顶最小的
      this.sinkDown(0);
    }
  }
  private bubbleUp(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.h[p] <= this.h[i]) break;
      [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
      i = p;
    }
  }
  private sinkDown(i: number) {
    const n = this.h.length;
    while (true) {
      let s = i, l = i * 2 + 1, r = i * 2 + 2;
      if (l < n && this.h[l] < this.h[s]) s = l;
      if (r < n && this.h[r] < this.h[s]) s = r;
      if (s === i) break;
      [this.h[s], this.h[i]] = [this.h[i], this.h[s]];
      i = s;
    }
  }
  topK(): number[] {
    return [...this.h].sort((a, b) => b - a); // 最后把 K 个排序输出
  }
}
// 100 万数据：全排序 ~200ms，Top-K 堆 ~12ms（约 16x）
```

```
Top-K 复杂度对比：
  全排序后取前 K：  O(n log n) + O(K)   n=10^6 时 ~200ms
  最小堆维护 K：    O(n log K)          K=100 时 ~12ms
  快速选择(quickselect)：O(n) 平均      但不稳定、需原地修改
```

### ⚡ 实战经验

- **`a.y - b.y` 的浮点陷阱**：两个物体 Y 几乎相等时，比较结果在 ±epsilon 间跳变，导致稳定排序也"看起来"抖动。解法是 Y 乘以倍数取整作为 key，或加一个二级排序键（如 id）强制稳定。
- **透明物体排序是硬需求**：3D 场景里不透明物体靠 ZBuffer 任意顺序画，但半透明（玻璃、特效）必须从后往前画且关闭深度写——这步排序错了会出现"粒子穿过玻璃"的穿模感。
- **背包排序卡 UI**：背包 500 个道具按品质排序，每次新增道具都全量 `sort()` 导致拖拽时 UI 卡顿。改成插入到已排序数组（二分查找插入点，O(log n) + O(n) 移动）后流畅。
- **比较函数必须满足全序**：写过 `(a, b) => a.priority > b.priority ? 1 : -1` 漏了相等返回 0，导致 V8 排序结果不确定甚至栈溢出。记住三值比较：负/零/正。
- **离线预排序排行榜**：实时排行榜每秒几千次查询，全量排序扛不住。用"增量更新 + 定时全量重排"（Redis Sorted Set 底层是跳表），游戏端只读取缓存结果。

### 🔗 相关问题

1. 为什么 V8 的 `Array.sort` 在 ES2019 后保证稳定？之前不稳定的排序造成过什么线上 bug？
2. 基数排序为什么能做到 O(n)？它在 depth key 场景下相比 TimSort 实测能快多少？有什么前置条件？
3. 快速选择（QuickSelect）找中位数是 O(n)，为什么游戏里找"渲染分界物体"很少用它？
