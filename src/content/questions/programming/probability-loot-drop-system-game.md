---
title: "游戏的抽卡掉落系统怎么设计？真随机、伪随机分布(PRD)和保底机制有什么区别？"
category: "programming"
level: 2
tags: ["概率", "抽卡", "掉落表", "PRD", "期望值", "数值平衡"]
related: ["programming/rng-seeded-random", "programming/dynamic-programming-game"]
hint: "不是 rand() < dropRate 这么简单——是 PRD 平滑方差 + 保底兜底 + 期望值工程的系统设计"
---

## 参考答案

### ✅ 核心要点

1. **真随机 vs 伪随机分布(PRD)**：真随机每次独立采样（5% 暴击可能连续 50 次不暴击），方差大、玩家体验差；PRD（Pseudo Random Distribution）每次失败提升下次概率，方差小、更符合玩家直觉。Dota 2、魔兽争霸 3 的暴击都用 PRD，玩家几乎感觉不到"运气差"，但代价是首刀实际概率低于标称值。

2. **保底机制三件套**：硬保底（第 N 抽必出，如原神 90 抽硬保底）、软保底（超过阈值后概率递增，如 75 抽后概率从 0.6% 逐步升到 100%）、井票/兑换券（每抽攒 1 点，N 点兑换指定物品）。保底的本质是把"无限方差"截断成"有界方差"，保证最黑玩家的体验下限。

3. **掉落表设计**：权重表（item → weight，概率 = weight / totalWeight）比概率表（item → probability）更易维护——新增物品不用重算其他概率。条件掉落（首次击杀必掉、组队减半、活动翻倍）通过修饰符层叠在基础权重上，互不干扰。

4. **期望值与方差双控**：设计掉落不仅要算单抽期望（E = Σ p_i × v_i），还要模拟抽数分布（蒙特卡洛 10 万次）看 P99。期望值相同但方差大的方案，会让 1% 玩家爽到、99% 玩家骂街——数值平衡的本质是控制方差，不只是看期望。

5. **服务端权威防作弊**：抽卡结果必须服务端生成、客户端只展示。客户端发起"抽一次"请求 → 服务端用账号种子 + 计数器生成结果 → 返回物品 ID。绝不能让客户端决定随机源，否则改内存就能 100% 出金，游戏经济瞬间崩盘。

### 📖 深度展开

#### 1. PRD 算法（伪随机分布）

Dota 2 / 魔兽争霸 3 的暴击 PRD 算法：基础概率 p，每次失败后实际概率按常数 c 递增。

```typescript
class PRD {
  private counter = 0; // 连续失败计数
  constructor(private c: number) {} // c 是 PRD 常数，由目标概率反查

  roll(rng: () => number): boolean {
    this.counter++;
    const actualP = this.c * this.counter;
    if (rng() < actualP) {
      this.counter = 0; // 触发后重置
      return true;
    }
    return false;
  }
}

// 目标概率 → PRD 常数 c 查找表（经验值，数值策划标定）
// 目标 5% 暴击  → c ≈ 0.0038（首刀只有 0.38% 概率！）
// 目标 15% 暴击 → c ≈ 0.0322（首刀 ~3.2%）
// 目标 25% 暴击 → c ≈ 0.0875（首刀 ~8.75%）
const critPRD = new PRD(0.0038); // 标称 5% 暴击
```

真随机 vs PRD 方差对比（10 万次模拟，标称 5% 暴击）：

| 分布 | 平均连续不暴击 | P95 最长旱期 | P99 最长旱期 | 玩家体验 |
|------|----------------|--------------|--------------|----------|
| 真随机 | 19 次 | ~88 次 | ~135 次 | 玄学骂街 |
| PRD (c=0.0038) | 13 次 | ~26 次 | ~40 次 | 稳定可预期 |

#### 2. 抽卡保底状态机

```typescript
interface GachaState {
  pityCount: number; // 软保底计数
  hardPity: number; // 硬保底计数
  guaranteed: boolean; // 大保底（歪了下次必出 UP）
}

function pull(state: GachaState, rng: () => number): { rarity: 3 | 5; state: GachaState } {
  let p5 = 0.006; // 基础 0.6%
  if (state.pityCount >= 74) p5 += (state.pityCount - 73) * 0.06; // 软保底递增

  const newState: GachaState = {
    ...state,
    pityCount: state.pityCount + 1,
    hardPity: state.hardPity + 1,
  };

  if (newState.hardPity >= 90 || rng() < p5) {
    // 硬保底或概率命中 → 出 5 星
    const isUp = newState.guaranteed || rng() < 0.5; // 50% 是 UP 角色
    return {
      rarity: 5,
      state: { pityCount: 0, hardPity: 0, guaranteed: !isUp },
    };
  }
  return { rarity: 3, state: newState }; // 普通出
}
```

保底状态机流转：

```
[抽卡] → rng() < 0.6%？
   ├─ 是 → 出 5 星 → 歪了？(50%)
   │       ├─ 是 → guaranteed=true → 下次 5 星必是 UP
   │       └─ 否 → 出 UP，guaranteed=false，计数清零
   └─ 否 → pityCount++
              ├─ pityCount >= 74 → 下次概率 +6%（软保底递增）
              └─ pityCount >= 90 → 必出 5 星（硬保底）→ 重置计数
```

#### 3. 掉落表加权采样

```typescript
interface DropEntry {
  itemId: number;
  weight: number;
  minQty: number;
  maxQty: number;
}

class DropTable {
  private cumulative: { itemId: number; threshold: number; min: number; max: number }[] = [];
  private totalWeight = 0;

  constructor(entries: DropEntry[]) {
    let acc = 0;
    for (const e of entries) {
      acc += e.weight; // 累积权重
      this.cumulative.push({ itemId: e.itemId, threshold: acc, min: e.minQty, max: e.maxQty });
    }
    this.totalWeight = acc;
  }

  sample(rng: () => number): { itemId: number; qty: number } {
    const r = rng() * this.totalWeight; // [0, totalWeight)
    const entry = this.cumulative.find((e) => r < e.threshold)!;
    const qty = entry.min + Math.floor(rng() * (entry.max - entry.min + 1));
    return { itemId: entry.itemId, qty };
  }
}
```

加权采样 vs 概率表对比：

| 方案 | 新增物品 | 概率调整 | 浮点累积误差 | 适用场景 |
|------|----------|----------|--------------|----------|
| 概率表 (p1+p2+...=1) | 重算所有 p | 牵一发动全身 | 有（求和≠1） | 固定掉落池 |
| 权重表 (Σ weight) | 直接加 weight | 局部调整 | 无 | 动态池、活动加成 |

### ⚡ 实战经验

- **PRD 首刀陷阱**：Dota 2 PA（幻影刺客）标称 15% 暴击，但 PRD 实现下首刀实际只有 ~3.2% 概率暴击（c=0.0322，counter=1 时 actualP = c×1）。职业选手都知道"先打两下小兵暖手"再 Gank，这是利用 PRD 的计数器累积提高关键刀的暴击率。数值策划必须理解 c 是反查出来的，不是直接等于标称概率。

- **方差模拟必要性**：1% SSR 单抽，纯随机下 1000 个玩家里最黑的那个可能抽 600+ 抽才出（P99.9 ≈ 690 抽）。上线前用蒙特卡洛跑 10 万次模拟，发现 0.5% 玩家体验极差，于是加 120 抽软保底把 P99 压到 120 抽以内，差评率从 8% 降到 1.2%。

- **保底重置漏洞**：早期版本保底计数存客户端 localStorage，玩家清缓存就重置保底——刷保底薅羊毛。修复：保底计数存服务端账号表，客户端只读不写，每次抽卡服务端用乐观锁原子更新（UPDATE ... WHERE version = ?），杜绝并发刷抽。

- **跨日重置坑**：每日签到"保底 10 次必出稀有"，但服务器 0 点重置时把所有玩家保底计数清零，结果有玩家 23:59 抽了 9 次、0:01 计数归零又要重头攒——客诉炸锅。修复：保底计数按"首次抽卡时间 + 24h"滚动窗口，不按自然日重置，跨日玩家体验连续。

### 🔗 相关问题

- 如果要做"可重现的抽卡"（回放、录像），随机种子怎么和保底计数器配合？（种子 + 抽数作为确定性输入流，服务端记录每抽的 RNG 输出供回放校验）
- 大规模抽卡活动（万人同时抽）服务端 RNG 怎么避免种子碰撞？（每账号独立种子 + 全局熵池补充，避免相邻账号序列相关）
- 概率公示和实际实现怎么保证一致？（自动化测试：跑 100 万次采样，实测频率 vs 设计频率做卡方检验，CI 每天跑）
