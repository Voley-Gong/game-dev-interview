---
title: "二分查找在游戏开发中有哪些实战应用？为什么面试中十有八九写不对？"
category: "programming"
level: 2
tags: ["二分查找", "算法", "性能优化", "数值平衡"]
related: ["programming/skip-list-leaderboard", "programming/sorting-algorithms-game", "programming/tween-easing-interpolation"]
hint: "二分不是只会查数组——它是把优化问题转成判定问题的通用思想。"
---

## 参考答案

### ✅ 核心要点

1. **二分查找的本质是在「单调性」上做 O(log n) 定位**：只要能在 `[lo, hi]` 上确定一个单调判定函数 `check(mid)`（左半一定满足、右半一定不满足，或反之），就能二分。不一定非要是排好序的数组——单调函数、单调序列、单调的答案区间都行。
2. **写不对的头号根因是边界条件**：开闭区间（左闭右闭 `[l,r]` vs 左闭右开 `[l,r)`）、`mid` 的计算（`l+r>>1` 还是 `l+(r-l)/2`）、循环终止（`l<r` 还是 `l<=r`）、缩小方向（`r=mid` 还是 `r=mid-1`）——这四者必须自洽。Java 标准库的 `Arrays.binarySearch` 著名 bug 就是 `mid=(l+r)/2` 在大数组时整型溢出。
3. **三大变体必须分清**：① 精确查找（找到即返回）；② 查找「第一个 ≥ target」（lower_bound，用于插入位置）；③ 查找「最后一个 ≤ target」（upper_bound，用于排行榜名次）。三者的边界写法不同，混用就死循环或差一。
4. **「二分答案」是降维利器**：当「求最优解」难，但「判定某个解是否可行」容易时，对答案区间二分。例如「最少多少次攻击能击杀 BOSS」→ 转成「k 次攻击能否击杀」的判定问题，把 O(指数) 的搜索压成 O(log(值域) × 判定)。
5. **浮点二分用于参数调优与物理求解**：浮点没有精确等号，用 `r - l > eps` 作为终止条件。适合「伤害系数调到多少刚好 3 秒击杀」「抛物线初速多少刚好命中」这类连续值问题，eps 取 `1e-6` 精度足够。
6. **游戏实战场景**：排行榜二分定位名次、动画/特效时间轴寻址、资源热更版本回退、平衡性数值自动调参、分辨率自适应采样。

### 📖 深度展开

**1. 标准模板与边界自洽性**

```
二分写法的四要素必须配对（以「左闭右闭 [l,r]」为例）：

  区间含义    [l, r] 闭区间，答案一定在里面
  循环条件    l <= r           （l==r 时区间还有一个元素，要查）
  mid 计算    l + ((r - l) >> 1)   （防溢出，等价 (l+r)/2）
  收缩策略    命中 → return；去左 → r = mid - 1；去右 → l = mid + 1
```

```typescript
// ❌ 经典溢出 bug：l + r 在数组 > 2^30 时溢出为负数 → 数组越界
// function bsearch(nums: number[], target: number) {
//   let l = 0, r = nums.length - 1;
//   while (l <= r) {
//     const mid = (l + r) / 2;        // ← 整型溢出隐患
//   }
// }

// ✅ 防溢出标准写法：mid = l + (r - l >> 1)
function binarySearch(nums: number[], target: number): number {
  let l = 0, r = nums.length - 1;
  while (l <= r) {
    const mid = l + ((r - l) >> 1);   // 位运算优先级低，括号必加
    if (nums[mid] === target) return mid;
    if (nums[mid] < target) l = mid + 1;
    else r = mid - 1;
  }
  return -1;
}
```

**2. 三大变体（lower_bound / upper_bound）—— 排行榜场景**

```typescript
// lower_bound：第一个 >= target 的下标（target 应插入的位置）
function lowerBound(nums: number[], target: number): number {
  let l = 0, r = nums.length;          // 注意 r = length（左闭右开）
  while (l < r) {                       // 注意 l < r，不是 <=
    const mid = l + ((r - l) >> 1);
    if (nums[mid] < target) l = mid + 1;
    else r = mid;                       // 注意 r = mid，不是 mid-1
  }
  return l;                             // l == r == 插入位置
}

// 游戏排行榜：玩家分数降序数组，二分算出该分数的排名
// scores = [9999, 8500, 8500, 7000, ...]  →  找第一个 <= score 的位置
function getRank(scores: number[], myScore: number): number {
  let l = 0, r = scores.length;
  while (l < r) {
    const mid = l + ((r - l) >> 1);
    if (scores[mid] > myScore) l = mid + 1;  // 降序，比它大的在左边
    else r = mid;
  }
  return l + 1;  // 第 l+1 名（1-indexed）
}
```

```
排行榜二分定位（降序，找 8500 分的名次）：

  下标:   0      1      2      3      4
  分数: [9999] [8500] [8500] [7000] [6000]
          ↑                      ↑
       比8500大               第一个<=8500
  l 从 0 收敛到 2 → 排名 = 2+1 = 第3名（含并列）
```

**3. 「二分答案」—— 平衡性自动调参**

```
问题：「BOSS 血量 10000，玩家每秒输出浮动，求最少多少秒能击杀」
       直接枚举秒数 1,2,3... 效率低且可能很大

转化：判定函数 canKill(seconds) = {该秒数内最大输出 >= 10000}
      单调性：秒数越多，累计输出越大 → 单调递增 → 可二分！

  答案区间 [1, 100000]
        ↓ 二分
  mid=50000 → canKill? ✅ → 答案 <= 50000，去左
  mid=25000 → canKill? ❌ → 答案 > 25000，去右
        ↓ O(log 1e5) ≈ 17 次判定
      收敛到精确值
```

```typescript
// 二分答案模板：求满足 check 的最小值（最大化最小/最小化最大同理）
function bsearchAnswer(lo: number, hi: number, check: (k: number) => boolean): number {
  // 找第一个使 check 为真的值（假设 check 单调：false...false true...true）
  while (l <= r) {           // 注：用闭区间写法
    const mid = lo + ((hi - lo) >> 1);
    if (check(mid)) hi = mid - 1;   // 满足 → 尝试更小
    else lo = mid + 1;              // 不满足 → 必须更大
  }
  return lo;
}

// 实战：自动调伤害系数，使「3 秒击杀」刚好成立（浮点二分）
function tuneDamage(baseDps: number, bossHp: number, targetSec: number): number {
  let lo = 0, hi = bossHp;            // 倍率范围 [0, bossHp]
  const eps = 1e-6;
  while (hi - lo > eps) {
    const mid = (lo + hi) / 2;
    const totalDmg = baseDps * mid * targetSec;  // 倍率 × 秒数
    if (totalDmg >= bossHp) hi = mid;            // 够了 → 降倍率
    else lo = mid;
  }
  return lo;  // 精确到 1e-6 的伤害倍率
}
```

| 维度 | 精确二分 | lower_bound | 二分答案 | 浮点二分 |
|------|----------|-------------|----------|----------|
| 典型场景 | 在数组中查某值 | 插入位置/排名 | 求最优解 | 连续参数调优 |
| 终止条件 | `l <= r` 或命中 | `l < r` | `l <= r` | `hi-lo < eps` |
| mid 计算 | `l+(r-l>>1)` | 同左 | 同左 | `(l+r)/2` |
| 收缩方式 | `mid±1` | `r=mid` / `l=mid+1` | 看 check 方向 | `hi/l=mid` |
| 常见坑 | 溢出、差一 | 死循环（l=mid 漏 +1） | check 单调性搞反 | eps 太大精度不够 |

### ⚡ 实战经验

- **排行榜百万数据查找必须二分，不能线性扫**：一款 MMO 的天梯榜存了 50 万条降序分数，玩家打开榜单要显示自己的排名。最初用 `indexOf` 线性查，平均 8ms，低端机 25ms 卡顿。改成二分后 0.02ms，肉眼无感。注意降序数组的判定方向要反过来（`>` 而非 `<`）。
- **「二分答案」救活了一个卡死的数值平衡需求**：策划要求「装备强化到某等级时，3 秒内刚好击杀同等级怪」。枚举等级 1~100 每个都要跑模拟，100 万次运算。改成对「等级」二分（判定=「该等级能否 3 秒击杀」），只需 7 次模拟（log2 100），从卡顿秒出。
- **整型溢出 bug 在 Web 小游戏也踩过**：用 TypeScript 的 `number` 理论上不会溢出，但把代码移植到 C#/Unity（`int` 32 位）后，`mid = (l + r) / 2` 在排行榜超过 2^30 条目时溢出为负，`nums[mid]` 直接越界崩溃。统一改成 `l + (r - l) / 2` 后修复。跨语言移植务必换写法。
- **浮点二分的 eps 选错会导致精度问题或死循环**：调「跳跃高度刚好碰到平台」的初速度，eps 用了 `1e-3`（太大），结果玩家偶发穿模（差 0.005 判定不到）。改 `1e-7` 后稳定。但 eps 过小（`1e-15`）会因浮点精度耗尽 `hi-lo` 永远 > eps 导致死循环——浮点有效位约 15 位，eps 别小于 `1e-12`。
- **动画时间轴寻址别用线性查**：一个 10 分钟过场动画有 5000 个关键帧事件，播放时每帧要找「当前时间触发哪些事件」。线性扫 5000 条 × 60fps = 30 万次/秒。按事件时间排序后二分定位起点，单次 O(log 5000)≈13 次比较，CPU 占用降 99%。

### 🔗 相关问题

1. 二分查找的「左闭右闭」和「左闭右开」两种写法，分别对应怎样的循环条件和收缩策略？为什么混用会死循环？
2. 如果判定函数 `check(mid)` 不是严格单调（存在平台段，一段区间都满足），二分答案还能用吗？会返回什么？
3. 跳表（Skip List）和有序数组的二分查找在时间复杂度上都是 O(log n)，为什么排行榜更常用跳表而非数组二分？
