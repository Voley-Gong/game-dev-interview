---
title: "游戏装备强化/精炼系统架构怎么设计？如何兼顾概率公平、属性可叠加和失败保护？"
category: "architecture"
level: 3
tags: ["装备强化", "概率系统", "保底机制", "属性修饰器", "成长系统"]
related: ["architecture/inventory-system-architecture", "architecture/buff-status-effect-system", "architecture/save-system-architecture"]
hint: "不是「丢个随机数判定成败」——是「保底引擎 + 属性修饰器链 + 事务性消耗 + 确定性可审计日志」"
---

## 参考答案

### ✅ 核心要点

1. **保底引擎（Pity System）是现代强化系统的标配**：连败 N 次必成、累计幸运值兑换保底、软保底逐步提升成功率——保底状态必须持久化到存档，不能让玩家退出/掉线丢失进度。保底计数器是反「氪金-退坑」曲线的关键，没有保底的纯随机会让重氪玩家连败后直接弃游。
2. **属性修饰器链（Modifier Stack）统一多套强化维度**：强化/精炼/宝石/附魔/铭文等多套系统叠加在同一件装备上，必须用修饰器链（加法层 / 乘法层 / 最终覆盖层 三阶段流水线）统一计算最终属性，而不是每套系统各自改一份属性快照——否则会出现「加法乘法混用导致实际属性翻倍」的数值崩坏。
3. **概率配置驱动 + 确定性可审计日志**：成功率、暴击率、属性浮动范围必须配置驱动（Excel/JSON/ScriptableObject），策划能热更不改代码；同时每次强化记录「种子值、随机数序列、消耗、结果」到日志，便于客服查证「80% 成功率为什么连失败 5 次」这种高频客诉，给出确定性证据而非「概率就是这样」的敷衍。
4. **失败保护的分层设计**：失败不能让玩家血本无归——常见三档：失败不扣级（只扣材料，温和）、失败降 1 级（扣强化等级，中风险）、失败碎装备（高风险高回报）。三档通过配置切换，且对「碎装备」必须有保险/补偿机制（保护符、保级石）避免客诉爆炸。
5. **事务性消耗与预扣-发放/回退流程**：金币 + 材料 + 保护符的消耗是事务性的——任意一项扣减失败必须整体回滚，否则玩家可能「花了钱没强化成功还啥都没了」。消耗顺序应是「预扣全部材料 → 判定结果 → 发放奖励或回退预扣」。

### 📖 深度展开

#### 一、保底引擎与概率配置

保底引擎的核心是把「纯随机」改造为「有下限保证的伪随机」，避免长尾连败击穿玩家心理：

```typescript
interface EnhanceConfig {
  level: number;                  // 目标强化等级
  baseRate: number;               // 基础成功率 0~1
  softPityFrom: number;           // 软保底：连败N次后开始提升
  softPityIncrement: number;      // 每次软保底提升的成功率
  hardPityAt: number;             // 硬保底：连败N次必成
}

interface PityCounter {
  itemId: number;
  consecutiveFails: number;       // 连败计数（必须持久化到存档）
  totalAttempts: number;          // 累计尝试（用于成就/统计）
}

function rollEnhance(cfg: EnhanceConfig, pity: PityCounter, rng: RNG): boolean {
  let rate = cfg.baseRate;
  // 软保底：连败超过阈值后，每次额外提升成功率
  if (pity.consecutiveFails >= cfg.softPityFrom) {
    const bonus = (pity.consecutiveFails - cfg.softPityFrom + 1) * cfg.softPityIncrement;
    rate = Math.min(1, rate + bonus);
  }
  // 硬保底：连败达到上限必成
  if (pity.consecutiveFails >= cfg.hardPityAt) return true;
  const roll = rng.next();
  const success = roll < rate;
  pity.consecutiveFails = success ? 0 : pity.consecutiveFails + 1;
  pity.totalAttempts++;
  return success;
}
```

| 保底模式 | 机制 | 玩家体验 | 实现复杂度 |
|---------|------|---------|-----------|
| 无保底（纯随机） | 每次独立判定 | 连败无下限，重氪退坑率高 | 低 |
| 硬保底（Pity） | 连败 N 次必成 | 有明确上限，可预期 | 中 |
| 软保底（Soft Pity） | 连败后逐步提率 | 平滑过渡，体感更温和 | 中高 |
| 幸运值兑换 | 累计幸运值可兑换保底 | 玩家有选择权，适合付费道具 | 高 |

#### 二、属性修饰器链（Modifier Stack）

强化/精炼/宝石/附魔四套系统叠加时，必须用统一的三阶段流水线计算最终属性，否则会出现「乘法叠加导致属性翻倍」的灾难：

```typescript
type ModifierStage = 'add' | 'multiply' | 'final';

interface Modifier {
  source: 'enhance' | 'refine' | 'gem' | 'enchant';
  stage: ModifierStage;
  stat: 'atk' | 'def' | 'hp' | 'crit';
  value: number;
}

/** 三阶段流水线：先加法汇总，再乘法汇总，最后最终覆盖 */
function computeFinalStat(base: number, modifiers: Modifier[]): number {
  // 阶段1：加法层（强化加成、附魔加成）
  let result = base;
  for (const m of modifiers.filter(m => m.stage === 'add')) {
    result += m.value;
  }
  // 阶段2：乘法层（精炼百分比、宝石百分比）
  let multiplier = 1;
  for (const m of modifiers.filter(m => m.stage === 'multiply')) {
    multiplier += m.value;   // 如 +0.1 表示 +10%
  }
  result *= multiplier;
  // 阶段3：最终覆盖层（限时Buff、特殊词条覆盖）
  for (const m of modifiers.filter(m => m.stage === 'final')) {
    result += m.value;
  }
  return Math.floor(result);
}
```

```
基础攻击力 100
   │
   ├─[加法层] 强化+10 → +30atk
   ├─[加法层] 附魔烈焰 → +20atk
   │   小计：150
   │
   ├─[乘法层] 精炼+5 → +15%
   ├─[乘法层] 宝石攻击 → +10%
   │   乘数：1.25 → 小计：187
   │
   └─[最终层] 战斗Buff → +50atk
       最终：237
```

#### 三、事务性消耗与失败保护

强化是一次完整的资源事务，必须保证「要么全成功，要么全回滚」，并配套可配置的失败保护策略：

```typescript
async function enhanceTransaction(playerId: string, itemId: number, level: number) {
  const tradeId = generateId();  // 幂等键
  const consumed = await preDeduct(playerId, {
    gold: cfg.goldCost, material: cfg.matCost, protector: cfg.useProtector ? 1 : 0,
  }, tradeId);
  try {
    const success = rollEnhance(cfg, pity, rng);
    if (success) {
      await grantEnhanceLevel(itemId, level + 1);
    } else {
      await applyFailProtection(itemId, cfg.failPolicy, consumed.protector > 0);
      // failPolicy: 'no_down' | 'down_one' | 'destroy'
    }
    await logEnhance({ tradeId, seed: rng.seed, rolls: rng.history, success, consumed });
  } catch (e) {
    await refund(consumed, tradeId);  // 任意步骤失败 → 全额回退
    throw e;
  }
}
```

| 失败策略 | 消耗 | 玩家损失 | 适用场景 |
|---------|------|---------|---------|
| 不掉级（no_down） | 扣材料，不扣强化等级 | 仅材料成本 | 休闲游戏、低等级段 |
| 降 1 级（down_one） | 扣材料 + 降 1 级强化 | 材料累积进度 | 中高等级、主流MMO |
| 碎装备（destroy） | 扣材料 + 装备销毁 | 全部损失（除非用保护符） | 高端玩法、高风险高回报 |

### ⚡ 实战经验

1. **保底状态丢失事故**：早期把 PityCounter 放在内存，玩家退出游戏或服务器重启后清零，一周内收到 200+ 客诉「我的连败计数没了」，改为持久化到存档（save-system）后客诉归零。教训：保底状态和装备本身一样是核心资产。
2. **修饰器顺序错误导致秒杀 BOSS**：强化加成（+30atk）和宝石加成（+10%）都用乘法层叠加，导致 +15 武器 + 5 级宝石的实际攻击力是预期的 1.8 倍，首通 BOSS 被 3 秒秒杀，紧急 hotfix 把宝石改为加法层后平衡。修饰器阶段配置必须用枚举强约束。
3. **概率不可审计的高频客诉**：早期没记种子值，玩家投诉「80% 成功率连失败 5 次」（数学概率约 0.032%，每万活跃玩家每天约发生 1 次，全服必然发生）；加入种子 + 随机数序列日志后，客服能给出「本次 seed=12345，roll=0.81 > 0.80，确实失败」的确定性证据，客诉处理时长从 2 天降到 10 分钟。
4. **碎装补偿机制**：上线 +12 以上失败碎装后，三天内退款投诉激增 300%（玩家认为「我充了钱凭什么碎」），紧急上线「碎装保险」（消耗额外保护符免碎）后投诉回落；高风险失败必须有对冲机制，不能纯靠概率。
5. **跨服交易强化等级处理**：装备跨服交易时，不同服的强化上限/数值表可能不同（A 服 +15 = B 服 +12），必须定义跨服映射规则并锁定强化等级转换，否则会出现「跨服后属性突变」的客诉。

### 🔗 相关问题

- 强化「暴击」（一次强化加 2 级）的概率怎么设计才不会破坏数值平衡？暴击率随强化等级衰减的曲线怎么调？
- 同一件装备上同时有强化、精炼、宝石、附铭四套系统，最终属性的计算顺序为什么必须固定？如果允许玩家自定义顺序会有什么问题？
- 强化系统如何防作弊（客户端篡改概率、内存修改保底计数）？服务端权威的边界在哪？
