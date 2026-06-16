---
title: "游戏实时排行榜为什么用跳表而不是红黑树或堆？"
category: "programming"
level: 3
tags: ["数据结构", "跳表", "排行榜", "概率平衡", "有序集合"]
related: ["programming/data-structures-game", "programming/ring-buffer-game", "programming/cache-eviction-game"]
hint: "不是堆也不是红黑树——是概率性平衡的多层链表，插入和排名查询都是 O(log n)，且实现远比平衡树简单。"
---

## 参考答案

### ✅ 核心要点

1. **跳表 = 有序链表 + 多级索引**：单链表查找是 O(n)，但在上面叠加多层「快车道」索引后，查找退化成 O(log n)——每层索引跳跃式跳过一半节点，像二分一样折半缩小范围。Redis 的 `ZSet`、LevelDB 的 `MemTable` 都用跳表，因为它达到了平衡树的查询效率，但实现复杂度只有其 1/3。
2. **概率平衡替代旋转重平衡**：红黑树/AVL 插入后要旋转重构，代码复杂且并发锁粒度大。跳表用「抛硬币」决定新节点插入到第几层索引——50% 概率只进第 0 层，25% 进第 1 层，以此类推。期望高度是 O(log n)，虽然不保证绝对平衡，但统计上稳定，且**实现极简**（插入无需旋转，只改相邻指针）。
3. **排行榜的核心操作：插入 + 排名查询**：游戏排行榜高频操作是「玩家分数变动后重新定位」和「查询某玩家第几名」。跳表两者都是 O(log n)；排序数组二分查找是 O(log n) 但插入要搬移 O(n) 个元素；堆只能 O(1) 拿 Top1，查任意玩家排名是 O(n)。对于 10 万玩家的实时榜，跳表单次更新 ~17 次比较 vs 数组搬移 ~10 万次内存移动。
4. **跳表天然支持范围查询**：排行榜经常要「取第 50-100 名」或「取分数在 [8000, 9000] 的所有玩家」。跳表找到起点后顺着第 0 层链表往后走即可，O(log n + k)（k 是结果数）。红黑树的范围查询也是 O(log n + k) 但要处理左右子树遍历更繁琐，堆则完全不支持高效范围查询。
5. **内存换时间：跳表有额外索引开销**：每个节点平均出现在 ~1.33 层（几何分布期望 1/(1-0.5) = 2 层指针），比单链表多约 1 倍指针内存。10 万节点的 int64 排行榜，跳表约多占 1.6MB。在内存充裕的服务端可接受，但在内存受限的客户端（如本地离线榜）可能要降低索引概率（p=1/4）来减少层数。
6. **并发友好：跳表易做无锁/细粒度锁**：跳表插入只影响相邻节点的指针（局部修改），而红黑树插入可能触发从叶到根的多处旋转（全局重构）。Java 的 `ConcurrentSkipListMap` 用 CAS 实现无锁跳表，而红黑树只能整树加锁或用拷贝写（Copy-on-Write）。游戏跨服排行榜多线程更新时，跳表的并发吞吐显著优于平衡树。

### 📖 深度展开

**1. 跳表结构：多级索引的折半跳跃**

```
跳表查找分数=75 的玩家（从最高层往下滑）：

Level 3 (稀疏索引):  HEAD ──────────────────────► [50] ──────────────────► [90] ──► NIL
                          │                          (75>50, 75<90 → 下降)
Level 2:            HEAD ──────► [30] ──────────► [50] ──────► [70] ────► [90] ──► NIL
                                                     │           (75>70 → 下降)
Level 1:            HEAD ► [10] ► [30] ► [40] ► [50] ► [60] ► [70] ► [80] ► [90] ► NIL
                                                                  (75>70, 75<80 → 插入点)
Level 0 (完整链表): HEAD ► [10] ► [30] ► [40] ► [50] ► [60] ► [70] ► [80] ► [90] ► NIL

查找路径：HEAD → L3:[50] → L2:[70] → L1:[70] → L0:插入位置(70与80之间)
比较次数：4 次（vs 单链表 7 次，vs 二分 4 次相当）

关键：每层都是下一层的「抽稀快车道」，高层跳得远，底层最精确
```

```
插入新节点 [75]：
  1. 抛硬币决定层数：p=0.5，连续正面次数+1
     假设抛出 2 次正面 → 插入到 Level 0、1、2
  2. 从最高层往下找插入位置，逐层更新指针
  3. 无需旋转、无需重平衡——只改相邻 4-6 个指针

  Level 2:  ... ► [50] ─────────► [70] ───► [75] ───► [90] ► ...   (新指针)
  Level 1:  ... ► [50] ► [60] ► [70] ► [75] ► [80] ► [90] ► ...
  Level 0:  ... ► [50] ► [60] ► [70] ► [75] ► [80] ► [90] ► ...
```

**2. TypeScript 跳表实现（排行榜场景）**

```typescript
interface LeaderboardNode {
  playerId: string;
  score: number;        // 排序键
  forward: LeaderboardNode[];  // forward[i] = 第 i 层的下一个节点
  span: number[];       // span[i] = 第 i 层到下个节点跨越的节点数（算排名用）
}

const MAX_LEVEL = 16;       // 2^16 = 65536，够 10 万级排行榜
const P_FACTOR = 0.5;       // 升层概率，Redis 默认 0.25（更省内存）

class SkipListLeaderboard {
  private head: LeaderboardNode;
  private level = 1;        // 当前最大层数
  private length = 0;

  constructor() {
    this.head = this.makeNode('', -Infinity, MAX_LEVEL);
  }

  private makeNode(playerId: string, score: number, level: number): LeaderboardNode {
    return { playerId, score, forward: new Array(level), span: new Array(level) };
  }

  // 抛硬币决定层数：几何分布
  private randomLevel(): number {
    let lvl = 1;
    while (Math.random() < P_FACTOR && lvl < MAX_LEVEL) lvl++;
    return lvl;
  }

  // 插入/更新玩家分数，返回新排名（从 1 开始）
  upsert(playerId: string, score: number): number {
    const update: LeaderboardNode[] = new Array(MAX_LEVEL);
    const rank: number[] = new Array(MAX_LEVEL);  // 累计跨度算排名
    let node = this.head;

    // 从最高层往下找插入位置，记录每层最后一个小于 score 的节点
    for (let i = this.level - 1; i >= 0; i--) {
      rank[i] = (i === this.level - 1) ? 0 : rank[i + 1];
      while (node.forward[i] && node.forward[i].score < score) {
        rank[i] += node.span[i];   // 累加跨度
        node = node.forward[i];
      }
      update[i] = node;
    }

    const newLevel = this.randomLevel();
    if (newLevel > this.level) {
      // 新节点层数超过当前最大层，补齐 head 的指针
      for (let i = this.level; i < newLevel; i++) {
        rank[i] = 0;
        update[i] = this.head;
        update[i].span[i] = this.length;
      }
      this.level = newLevel;
    }

    const newNode = this.makeNode(playerId, score, newLevel);
    for (let i = 0; i < newLevel; i++) {
      newNode.forward[i] = update[i].forward[i];
      update[i].forward[i] = newNode;
      newNode.span[i] = update[i].span[i] - (rank[0] - rank[i]);
      update[i].span[i] = (rank[0] - rank[i]) + 1;
    }
    for (let i = newLevel; i < this.level; i++) {
      update[i].span[i]++;
    }
    this.length++;
    return rank[0] + 1;  // 新排名
  }

  // 取 Top-N：O(log n + N)，顺着第 0 层走 N 步
  topN(n: number): { playerId: string; score: number }[] {
    const result: { playerId: string; score: number }[] = [];
    let node = this.head.forward[0];
    while (node && result.length < n) {
      result.push({ playerId: node.playerId, score: node.score });
      node = node.forward[0];
    }
    return result;
  }
}
```

**3. 排行榜数据结构选型对比**

| 数据结构 | 插入/更新 | 查排名 | Top-N | 范围查询 | 内存(10万节点) | 实现难度 |
|---------|----------|--------|-------|---------|---------------|---------|
| **排序数组+二分** | O(n) 搬移 | O(log n) | O(1) 直接切片 | O(log n + k) | 基础(0.8MB) | ⭐ 最简单 |
| **跳表 SkipList** | O(log n) | O(log n) | O(log n + N) | O(log n + k) | 基础×2(1.6MB) | ⭐⭐ 中等 |
| **红黑树** | O(log n) | O(log n)+子树大小维护 | O(N) 遍历 | O(log n + k) | 基础×1.5(1.2MB) | ⭐⭐⭐⭐ 极难 |
| **堆(大顶堆)** | O(log n) | O(n) ❌ | Top1 O(1), TopN O(NlogN) | ❌ 不支持 | 基础(0.8MB) | ⭐⭐ |
| **AVL树** | O(log n)+旋转 | O(log n) | O(N) | O(log n + k) | 基础×1.5(1.2MB) | ⭐⭐⭐⭐⭐ 最难 |

```
选型决策树：

  需要频繁插入/更新分数？
    ├─ 否（静态榜，每天刷新）→ 排序数组 + 二分，最省内存
    └─ 是（实时榜）
         ├─ 只关心 Top1（擂主）？→ 大顶堆
         ├─ 需要查任意玩家排名 / 范围分页？→ 跳表（推荐）或红黑树
         └─ 需要无锁高并发？→ 跳表（CAS 友好）优于红黑树（需全局锁）
```

### ⚡ 实战经验

- **MAX_LEVEL 按玩家量级设**：排行榜上线时只设了 `MAX_LEVEL=8`（支持 2^8=256 节点够用），结果活动爆量到 5 万人，跳表高度不够导致退化成接近单链表，`upsert` 从理论 16 次比较涨到实测 200+ 次，更新延迟从 0.02ms 飙到 3ms，排行榜刷新卡顿。`MAX_LEVEL` 应设为 `⌈log_{1/p}(N)⌉ + 4`（p=0.5 时 10 万人需 ~20 层），留足冗余。
- **同分数玩家的排序稳定性**：两个玩家都是 8500 分，跳表默认按分数排序会乱序。游戏需求是「同分先达到的排前面」——给节点加 `timestamp` 字段，比较时 `score === b.score ? a.timestamp - b.timestamp : b.score - a.score`。忘了加这个逻辑，同分玩家每次刷新排名都跳来跳去，被当成 Bug 投诉。
- **span 数组是算排名的关键，别省略**：初期实现为了省内存去掉了 `span[]`，结果「查询某玩家第几名」只能 O(n) 遍历第 0 层数，10 万人的榜查一次排名要遍历 5 万个节点。补上 `span[]`（每个节点记录到下层跨越的节点数）后，排名查询变成 O(log n) 沿索引层累加 span，从 3ms 降到 0.01ms。Redis 的 `ZREVRANK` 就是这么实现的。
- **客户端本地榜用跳表是过度设计**：一个单机闯关游戏的「好友榜」只有 50 人，用了跳表实现 200 多行代码，其实一个排序数组 `Array.sort() + binarySearch` 30 行搞定，插入 50 人搬移成本可忽略。跳表的收益在 N > 1000 时才显著，小数据规模简单结构更易维护，别为了「显得高级」上复杂数据结构。
- **跨服排行榜的并发更新用分段锁**：全服共享一个跳表实例，高峰期每秒上千次 `upsert`，单把锁成为瓶颈。按分数区间分片成 16 个跳表（0-1000 分一个、1000-2000 一个…），每个分片独立加锁，并发吞吐提升 12 倍。查 Top-N 时从各分片做归并——跳表的范围查询让归并非常高效。

### 🔗 相关问题

1. Redis 的 `ZSET` 底层为什么在元素少时用 `ziplist`（压缩列表），多时才转跳表？这个转换阈值（128 元素 / 64 字节）是怎么权衡的？
2. 如果排行榜需要支持「按多个维度排序」（先按胜率，同胜率按 KD 比），跳表该如何改造？多级索引能否扩展成多维索引？
3. 跳表的 `P_FACTOR` 从 0.5 降到 0.25 会怎样？查询、插入、内存三方面分别如何变化？Redis 为什么选 0.25？
