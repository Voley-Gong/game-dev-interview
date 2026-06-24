---
title: "游戏合成/制造系统架构怎么设计？如何支撑配方图、材料消耗和大成功率/暴击？"
category: "architecture"
level: 3
tags: ["合成系统", "制造", "配方图", "熟练度", "产出系统"]
related: ["architecture/inventory-system-architecture", "architecture/quest-achievement-system", "architecture/shop-economy-system-architecture"]
hint: "不是「N 个材料换 1 个成品」——是「配方 DAG + 多产出/暴击权重分布 + 事务性消耗 + 熟练度解锁曲线」"
---

## 参考答案

### ✅ 核心要点

1. **配方图（Recipe Graph）作为单一事实来源**：所有合成关系用 DAG 表达（材料 → 中间件 → 成品），配方数据完全配置驱动（JSON/ScriptableObject/Excel），配方解锁条件、前置任务、熟练度要求都挂在配方节点上，避免硬编码「if 配方可合成」的散弹逻辑——一旦配方超过 100 个，硬编码维护成本会爆炸。
2. **多产出与暴击/大成功的权重分布**：合成不是 1:1——有主产物、副产物、概率暴击（双倍产出）、大成功（稀有产物）。产出表用权重数组 + 概率分布配置，支持「90% 普通药水、9% 大药水、1% 传说药水」这种分布；产出采样必须逐次独立，不能用「单次概率 × 批量次数」近似（会高估稀有产出率）。
3. **消耗校验与事务原子性**：多个材料槽 + 可选催化剂的消耗是事务——任意一项不足或扣减失败必须整体回滚；消耗顺序应是「预扣全部材料 → 采样产出 → 发放成品或回退预扣」，避免「材料扣了但没出成品」的客诉，这是合成系统最高频的线上事故。
4. **熟练度/解锁的渐进曲线**：合成系统通常带熟练度——做低级配方提升熟练度，熟练度达标才能解锁高级配方或提升大成功率；熟练度曲线要陡到能形成「肝度」拉活跃，但要有上限避免无限刷，且熟练度必须是每配方独立追踪，不能全系统共用一个进度。
5. **批量合成与防滥用**：玩家会疯狂点「合成 100 次」，必须支持批量合成（一次事务消耗 100 份材料、逐次采样产出）；同时监控短时间大量合成（脚本工作室刷材料变现），用频率限制 + 异常行为告警（同 IP 每小时合成超 500 次锁定）拦截。

### 📖 深度展开

#### 一、配方图与多产出模型

配方是合成的核心数据结构。材料槽、产出权重分布、前置条件都配置驱动，产出采样用加权随机：

```typescript
interface MaterialSlot {
  itemId: number;
  quantity: number;
  isCatalyst: boolean;      // 催化剂：不消耗但提升大成功率
}

interface OutputEntry {
  itemId: number;
  quantity: number;
  weight: number;            // 权重，所有 entry 权重之和=总产出槽数
  isRare: boolean;           // 稀有产出（触发大成功动画）
}

interface Recipe {
  recipeId: number;
  inputs: MaterialSlot[];
  outputs: OutputEntry[];    // 加权产出表
  proficiencyRequired: number;
  baseCritRate: number;      // 大成功率（产出翻倍或出稀有）
  unlockCondition?: string;  // 前置任务ID
}

/** 加权随机采样一个产出 */
function pickOutput(outputs: OutputEntry[], rng: RNG): OutputEntry {
  const total = outputs.reduce((s, o) => s + o.weight, 0);
  let roll = rng.next() * total;
  for (const o of outputs) {
    roll -= o.weight;
    if (roll <= 0) return o;
  }
  return outputs[outputs.length - 1];
}

function craft(recipe: Recipe, rng: RNG): { item: OutputEntry; qty: number } {
  const output = pickOutput(recipe.outputs, rng);
  const crit = rng.next() < recipe.baseCritRate;
  return { item: output, qty: crit ? output.quantity * 2 : output.quantity };
}
```

```
配方 DAG（合成关系图）：

  铁矿 ×2 ─┐
            ├─→ 铁锭 ─┐
  煤炭 ×1 ─┘          │
                       ├─→ 铁剑（成品）
  木棍 ×1 ────────────┘
  │
  └─ 前置：熟练度 ≥ 50、任务「铁匠入门」已完成

  产出权重表（铁剑配方）：
  ├─ 普通铁剑   weight=90  (90%)
  ├─ 精良铁剑   weight=9   (9%, isRare)
  └─ 传说铁剑   weight=1   (1%, isRare)
  大成功率：5%（产出翻倍）
```

| 产出类型 | 触发条件 | 数值影响 | 玩家体感 |
|---------|---------|---------|---------|
| 普通产出 | 默认 | 按权重采样 | 平淡 |
| 暴击（Crit） | baseCritRate | 产出数量 ×2 | 惊喜 |
| 大成功（Rare） | 权重分布 isRare | 出稀有品质 | 狂喜 |
| 失败 | 失败率配置 | 材料消耗无产出 | 挫败（需配合保底） |

#### 二、熟练度与解锁曲线

熟练度是合成系统的「肝度」骨架。曲线形状直接决定留存与商业化：

```typescript
interface ProficiencyTracker {
  recipeId: number;          // 每配方独立追踪
  current: number;
  unlocks: Record<string, boolean>;  // 解锁的配方/特权
}

/** 熟练度增长曲线：线性 / 对数 / 阶梯三种 */
function gainProficiency(tracker: ProficiencyTracker, recipe: Recipe): number {
  const gain = 1;
  let newProf = tracker.current;
  // 线性曲线：每次固定+1（前期快后期慢）
  // 对数曲线：gain = 10 / log10(current + 10)（陡峭衰减）
  // 阶梯曲线：每 50/200/500 次解锁一档
  if (curve === 'log') {
    newProf += Math.max(0.1, 10 / Math.log10(newProf + 10));
  } else {
    newProf += gain;
  }
  // 检查解锁
  for (const unlock of UNLOCK_TABLE[recipe.recipeId] || []) {
    if (newProf >= unlock.threshold && !tracker.unlocks[unlock.key]) {
      tracker.unlocks[unlock.key] = true;
      grantUnlock(unlock);  // 解锁新配方/提升crit率
    }
  }
  return newProf;
}
```

| 曲线类型 | 增长特征 | 玩家体验 | 适用场景 |
|---------|---------|---------|---------|
| 线性 | 每次固定 +N | 前期快、后期漫长 | 休闲合成、低上限 |
| 对数 | 高次衰减 | 前期爽、后期极肝 | 重氪 MMO、长线养成 |
| 阶梯 | 分段突进 | 节点感强、可预期 | 主流手游、3 日/7 日留存设计 |

#### 三、事务性消耗与批量合成

合成是完整资源事务，批量合成是性能与概率正确性的双重挑战：

```typescript
async function craftTransaction(playerId: string, recipeId: number, batch: number) {
  const tradeId = generateId();
  const recipe = recipeTable[recipeId];
  // 预扣全部材料（×batch）
  const consumed = await preDeduct(playerId, scaleInputs(recipe.inputs, batch), tradeId);
  try {
    const results: OutputEntry[] = [];
    // 逐次采样，不能用「概率 × batch」近似（会高估稀有产出）
    for (let i = 0; i < batch; i++) {
      results.push(craft(recipe, rng));
    }
    await grantOutputs(playerId, aggregate(results), tradeId);
    await gainProficiency(playerId, recipe, batch);
    await logCraft({ tradeId, recipeId, batch, seed: rng.seed, results });
  } catch (e) {
    await refund(consumed, tradeId);  // 整批回退
    throw e;
  }
}
```

| 维度 | 单次合成 | 批量合成（100次） |
|------|---------|-----------------|
| 事务开销 | 1 次预扣 + 1 次发放 | 1 次预扣 + 1 次发放（合并） |
| 概率正确性 | 天然正确 | 必须逐次采样 |
| UI 响应 | 即时 | 需异步进度条 |
| 反作弊 | 难（单次频率低） | 易（频率告警阈值） |

### ⚡ 实战经验

1. **配方硬编码维护灾难**：早期把每个合成配方写成 if-else，100+ 配方后改一个数值要改 5 个文件（前端展示、后端校验、客户端日志...），策划完全无法独立迭代；重构为配置驱动（Excel → JSON → 热更）后策划能独立维护，配方迭代速度提升约 5 倍。
2. **批量合成概率偏差事故**：早期批量合成用「单次概率 × 100」计算产出（独立性假设错误），导致 1% 稀有物品的实际产出率比理论值高约 15%（方差被压缩），经济系统被稀释；改为逐次独立采样后准确率回到 ±0.5%。
3. **熟练度曲线过陡击穿留存**：上线初期熟练度增长用对数曲线，玩家做 1000 次低级药水才能解锁中级配方，肝度过高导致 3 日留存下降约 8%；调整为阶梯式（50/200/500 次解锁三档）后留存回升，玩家反馈「有奔头」。
4. **工作室刷材料变现**：开放「金币 → 材料 → 合成 → 成品 → 拍卖行」闭环后，工作室用脚本 24 小时刷合成挂拍卖行变现，一周通胀率上升 12%；上线「同 IP 每小时合成超 500 次锁定 + 新账号 7 天禁用拍卖行」规则后封禁 3000+ 账号，通胀回落。
5. **催化剂不消耗的设计坑**：催化剂设计为「不消耗但提升大成功率」时，玩家会无限堆催化剂把大成功率刷满；正确做法是催化剂消耗但提供倍率，或设置大成功率硬上限（如 20%），避免数值崩坏。

### 🔗 相关问题

- 配方图如果出现循环依赖（A 合成 B、B 合成 A），如何在配置加载阶段检测并阻止？拓扑排序怎么用？
- 大成功率如果和玩家熟练度挂钩（熟练度越高暴击率越高），架构上怎么实现才不会让老玩家无限刷暴击破坏经济？
- 合成系统的「自动合成」（满足条件时自动消耗材料持续合成）怎么设计才不会卡 UI？如何在中断（玩家离线/切场景）时安全恢复？
