---
title: "装备词条/属性 Roll 系统架构怎么设计？如何实现词缀池、修饰组互斥和确定性 Roll？"
category: "architecture"
level: 4
tags: ["词条系统", "词缀池", "属性Roll", "稀有度分层", "修饰组互斥", "确定性随机"]
related: ["architecture/equipment-enhancement-system-architecture", "architecture/inventory-system-architecture", "architecture/save-system-architecture"]
hint: "不是「随机生成几个属性」——是「词缀池加权采样 + 修饰组互斥 + 稀有度分层 + 确定性种子可复现 + 展示值与计算值分离」"
---

## 参考答案

### ✅ 核心要点

1. **词缀池（Affix Pool）+ 加权采样是词条系统的核心数据结构**：每件装备的词条不是「随便挑几个属性」，而是从一个按权重分布的词缀池里采样——攻击力词条权重 30、暴击词条权重 5、移动速度词条权重 1，权重决定出现概率。词缀池按装备部位（武器/护甲/首饰）和等级分段配置，保证武器不会出「法力回复」、低级装备不会出顶级词条。
2. **修饰组互斥（Mod Group Exclusion）防止矛盾词条叠加**：同一件装备不能同时出现「+火焰伤害」和「-火焰抗性」这种矛盾组合，也不能两个词条都是「+攻击力」（数值叠加混乱）。词缀按 ModGroup 分组（如攻击组/防御组/元素组），同组词条互斥，一次 Roll 中选过的组不再参与后续采样——这是 ARPG 词条系统的基石。
3. **稀有度分层（Rarity Tiering）决定词条数量与数值区间**：白装 1 条词、蓝装 2 条、黄装 4 条、橙装 6 条 +1 条传奇独占词。稀有度不仅决定词条数量，还决定每条词的数值 Roll 区间——稀有度越高，区间上限越高。分层让「装备品阶」有明确感知，是刷刷刷游戏的核心驱动力。
4. **确定性 Roll（Deterministic Roll）保证可审计、可复现、防作弊**：词条生成必须用服务端派生的确定性种子（来源 + 等级 + 实例 ID 派生），相同种子永远生成相同词条。这让客服能复现「为什么我 Roll 出来是垃圾」的客诉，也防止客户端篡改本地随机数刷神装。确定性是服务端权威在掉落系统的直接体现。
5. **展示值与计算值分离（Display vs Computed）避免精度与显示灾难**：词条显示给玩家的是「+15% 暴击」的格式化文本，但底层计算用的是「+0.15 的浮点修饰器」。展示层负责本地化、四舍五入、范围标注（如「12~15」），计算层负责精确数值参与战斗公式。两者分离后，改显示格式不影响战斗逻辑，反之亦然。

### 📖 深度展开

#### 一、词缀池与修饰组互斥架构

词缀系统用「词缀定义 + 修饰组 + 加权池」三层结构。采样时按修饰组互斥逐条挑选，已选组不再参与，保证词条多样性：

```typescript
interface AffixDef {
  affixId: number;
  modGroup: string;              // 修饰组：'offense' | 'defense' | 'element_fire' | ...
  stat: 'atk' | 'crit_rate' | 'move_speed' | 'fire_dmg' | ...;
  weight: number;                // 采样权重（越高越常见）
  rollRange: [number, number];   // 数值 Roll 区间 [min, max]
  tier: number;                  // 词缀品阶（1=最高，影响区间）
  applicableSlots: string[];     // 适用部位：['weapon', 'helmet', ...]
}

interface RolledAffix {
  affixId: number;
  rolledValue: number;           // Roll 出的实际数值
  displayText: string;           // 「+15% 暴击率」格式化文本
}

// 逐条采样：每选一条词，其所属 modGroup 被加入排除集，后续不再采样同组
function rollAffixes(
  pool: AffixDef[], count: number, seed: number, slot: string
): RolledAffix[] {
  const rng = new SeededRNG(seed);
  const excludedGroups = new Set<string>();
  const result: RolledAffix[] = [];
  const candidates = pool.filter(a => a.applicableSlots.includes(slot));
  for (let i = 0; i < count; i++) {
    const available = candidates.filter(a => !excludedGroups.has(a.modGroup));
    if (available.length === 0) break;          // 可用组耗尽
    const picked = weightedSample(available, rng);  // 按权重采样
    const value = lerp(picked.rollRange[0], picked.rollRange[1], rng.next());
    result.push({ affixId: picked.affixId, rolledValue: value, displayText: format(picked, value) });
    excludedGroups.add(picked.modGroup);        // 同组互斥
  }
  return result;
}
```

#### 二、稀有度分层与完整 Roll 流程

稀有度（Rarity）是词条数量和数值区间的总开关，决定一次 Roll 生成几条词、每条词的上限。完整流程是「确定稀有度 → 确定词条数 → 逐条采样 → Roll 数值」：

```
装备生成完整 Roll 流程：

  掉落/掉宝判定
       │
       ▼
  稀有度 Roll（按掉宝率/词缀数量配置）
   ┌───┴────────┐
   │  白 60%    │ → 1 条词
   │  蓝 30%    │ → 2 条词
   │  黄 9%     │ → 4 条词
   │  橙 1%     │ → 6 条词 + 1 条传奇独占
   └────────────┘
       │
       ▼
  词缀数 = rarityTier.affixCount
       │
       ▼
  逐条采样（修饰组互斥，见上一节）
       │
       ▼
  每条词按 tier 区间 Roll 数值
       │
       ▼
  格式化展示值 + 存储计算值
```

```typescript
interface RarityTier {
  rarity: 'normal' | 'magic' | 'rare' | 'legendary';
  affixCount: number;            // 该稀有度的词条数
  tierMultiplier: number;        // 数值区间倍率（稀有度越高区间越宽）
  dropWeight: number;            // 掉落权重（用于稀有度 Roll）
  guaranteedAffixes?: number[];  // 传奇独占词（必出）
}

function rollItem(dropSource: string, baseItem: number, seed: number): GeneratedItem {
  const rng = new SeededRNG(seed);
  const rarity = weightedSample(RARITY_TIERS, rng);       // 1. 稀有度 Roll
  const affixes = rollAffixes(                             // 2. 词条采样
    AFFIX_POOL, rarity.affixCount, rng.next(), getSlot(baseItem)
  );
  if (rarity.guaranteedAffixes) {                          // 3. 传奇独占词
    affixes.push(...rollGuaranteed(rarity.guaranteedAffixes, rng));
  }
  return { baseItem, rarity: rarity.rarity, affixes, seed }; // seed 存档可复现
}
```

| 稀有度 | 词条数 | 数值区间 | 掉落权重 | 独占词 | 玩家体感 |
|--------|--------|---------|---------|--------|---------|
| 白装（Normal） | 1 | 基础 ×1.0 | 60 | 无 | 过渡品，直接分解 |
| 蓝装（Magic） | 2 | 基础 ×1.2 | 30 | 无 | 前期主力 |
| 黄装（Rare） | 4 | 基础 ×1.5 | 9 | 无 | 中后期核心 |
| 橙装（Legendary） | 6 | 基础 ×2.0 | 1 | 1 条 | 毕业追求 |

#### 三、确定性种子与展示/计算值分离

确定性种子让词条生成可复现、可审计；展示值与计算值分离让格式化和战斗逻辑解耦。两者都是工程稳健性的关键：

```typescript
// 种子派生：来源 + 物品 + 实例三要素哈希，保证唯一且可复现
function deriveSeed(source: string, itemId: number, instanceId: string): number {
  return hashString(`${source}:${itemId}:${instanceId}`);
}

interface AffixInstance {
  affixId: number;
  computedValue: number;         // 计算值：精确浮点，参与战斗公式
  displayText: string;           // 展示值：格式化、本地化、四舍五入
  rollRange: [number, number];   // 区间（用于显示「12/15」进度条）
}

// 展示层：负责格式化、本地化、范围标注
function formatDisplay(affix: AffixDef, value: number): string {
  const pct = (value - affix.rollRange[0]) / (affix.rollRange[1] - affix.rollRange[0]);
  const quality = pct > 0.8 ? '【极品】' : pct > 0.5 ? '' : '【残次】';
  const num = affix.stat.includes('rate') ? `${(value * 100).toFixed(1)}%` : `${Math.round(value)}`;
  return `${quality}+${num} ${LOCALIZE[affix.stat]}`;
}
// 计算层：computedValue 直接进修饰器链，与展示格式完全无关
```

### ⚡ 实战经验

1. **同组词条叠加灾难**：早期没做修饰组互斥，一件黄装 Roll 出 3 条「+攻击力」（数值叠加），导致该装备攻击力是同级别 2.5 倍，破坏了整个装备品阶体系，发现时已有数千件流入市场需要紧急回收补偿。引入 ModGroup 互斥后，同组词条最多出现一次。修饰组是词条系统的第一条铁律。
2. **客户端随机数被篡改刷神装**：早期词条 Roll 用客户端 Math.random()，外挂通过 Hook 随机函数反复重 Roll 直到出 6 条顶级橙词，一周内全服橙装泛滥，经济崩盘。改为服务端派生确定性种子 + 服务端 Roll + 只下发结果后，外挂彻底失效。词条生成必须服务端权威，客户端零信任。
3. **确定性种子碰撞导致掉落雷同**：种子派生公式用了 `monsterId + dropCount`，导致同一只怪掉的第 N 件装备永远 Roll 出相同词条（种子碰撞），玩家发现「打这个怪掉的装备属性都一样」后丧失刷的动力。改为加入「击杀时间戳哈希」和「玩家 ID」派生后，每件装备种子唯一。种子派生要素要足够丰富防碰撞。
4. **展示值精度与计算值不一致**：展示层把「+0.155」四舍五入显示成「+15%」或「+16%」，但计算层仍用 0.155，导致玩家看面板暴击 65%（4 件 ×16%+基础1%）实际战斗暴击只有 62%（4 × 15.5% + 1%），高频客诉「面板骗人」。修复：展示值与计算值统一来源（都从 computedValue 派生），展示只做格式化不做独立舍入。
5. **词缀池膨胀拖慢采样**：运营两年后词缀池从 50 条膨胀到 800 条（每条都要 applicableSlots 过滤 + 权重采样），每次 Roll 遍历 800 条导致掉落瞬间卡顿 45ms。改为「按部位预分桶 + 稀有度索引」（武器池/护甲池/首饰池预建，采样只在子池内）后，采样降到 2ms。词缀池必须按查询维度预建索引。

### 🔗 相关问题

- 词条的「重 Roll / 重铸」功能（用道具重抽某条词的数值或类型）如何保证不和确定性掉落冲突？重 Roll 后的种子如何管理以保持可审计？
- 传奇装备的「独占词」（只有该传奇才有的特殊机制词）如何在词缀池架构中表达？它和普通词缀的采样流程有何不同？
- 词条系统和装备强化/精炼系统（已经存在的修饰器链）如何协同？词条 Roll 出的属性应该进入修饰器链的哪一层？
