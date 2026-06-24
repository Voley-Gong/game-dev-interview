---
title: "游戏宠物/召唤物系统架构怎么设计？如何支撑 AI 跟随、属性继承、养成进化和存储管理？"
category: "architecture"
level: 3
tags: ["宠物系统", "召唤物", "AI跟随", "属性继承", "养成进化"]
related: ["architecture/combat-system-architecture", "architecture/ai-decision-architecture", "architecture/inventory-system-architecture"]
hint: "不是「跟在身后的小人」——是「AI 控制模式 + 属性继承链 + 养成进化管线 + 宠物背包存储」"
---

## 参考答案

### ✅ 核心要点

1. **AI 控制模式（Control Mode）决定宠物行为**：宠物不是纯装饰——它有主动行为，由行为 AI 驱动。常见模式：跟随（Follow，保持主人附近游荡）、协助（Assist，主人进入战斗时自动加入攻击）、守护（Guard，驻守指定点位驱逐敌人）、待命（Stay，原地不动）。模式可手动切换或按战斗状态自动切换，切换要平滑（不能瞬移），行为参数（跟随距离、攻击范围、仇恨范围）全部可配置化。

2. **属性继承链（Stat Inheritance）让宠物随主人成长**：宠物属性不是孤立的——部分继承主人属性（如宠物攻击力 = 宠物基础值 + 主人攻击力 × 继承系数），部分独立成长（宠物自身等级、装备、技能）。继承属性要实时同步（主人换装宠物属性立即跟随变化），且必须严格区分「继承属性」和「独立属性」避免双重加成 Bug（主人和宠物的 buff 叠加导致数值爆炸）。

3. **养成进化管线（Evolution Pipeline）是宠物深度来源**：宠物有养成深度——升级、突破（突破等级上限）、进化（形态变化 + 技能解锁）、好感度、技能学习。进化是关键里程碑（幼体→成体→最终形态），伴随外观、技能组、属性的大幅变化。养成资源消耗必须事务化——不能出现「升级扣了资源但进化失败回滚」导致的状态不一致。

4. **宠物背包/存储（Pet Storage）管理多只宠物**：玩家通常拥有多只宠物——需要专门的宠物容器（类似背包但管理宠物实体），支持出战（active 战斗中）、休息（rest 闲置）、放生/寄存。出战宠物的逻辑更新（跟随/战斗/AI）是高频的，休息宠物只更新冷数据（养成倒计时等）。容器要和背包系统、存档系统联动，并支持「快速切换出战宠物」。

5. **召唤/召回生命周期（Summon Lifecycle）要流畅可控**：召唤（召唤宠物出场）和召回（收回宠物）是高频操作——召唤要播放出场动画但不能卡手（不能「召唤要等 2 秒动画结束才能继续打怪」），召回要处理「宠物正在攻击/受击时召回」的状态（是否打断当前动作）。生命周期要和场景切换联动（切场景时宠物自动召回还是跟随传送，由配置决定）。

### 📖 深度展开

#### 一、AI 控制模式与宠物行为状态机

宠物的「自主行为」本质上是一套参数化的状态机。模式切换不能写死在代码里——必须抽成 `PetAIConfig` 由策划在配置表里调，否则每个宠物变体都要改代码。

```typescript
// 宠物控制模式 —— 决定宠物在场景中的行为模板
type PetControlMode = 'follow' | 'assist' | 'guard' | 'stay';

// 行为参数全部可配置：策划在宠物配置表里逐只调
interface PetAIConfig {
  controlMode: PetControlMode;
  followDistance: number;   // 跟随时保持的最大距离（超过则主动靠近）
  attackRange: number;      // 攻击距离（近战 1.5 / 远程 8.0）
  aggroRange: number;       // 自动索敌范围（协助模式生效）
  leashRange: number;       // 牵绳范围：超过此距离宠物瞬移回主人身边（防丢失/防卡墙）
}

class PetAI {
  constructor(
    private cfg: PetAIConfig,
    private nav: NavigationService,
  ) {}

  // 每帧由战斗循环调用，传入主人状态和附近的敌人列表
  update(dt: number, owner: OwnerState, nearbyEnemies: Enemy[]): void {
    const distToOwner = distance(this.pet.pos, owner.pos);

    // 牵绳兜底：所有模式都可能因为寻路失败/卡墙导致离主人太远，统一在入口处兜底
    if (distToOwner > this.cfg.leashRange) {
      this.pet.teleportTo(owner.pos);
      return;
    }

    switch (this.cfg.controlMode) {
      case 'follow':
        // 距离超过 followDistance 主动靠近，否则在原地附近 idle 漫游
        if (distToOwner > this.cfg.followDistance) {
          this.nav.moveToward(this.pet, owner.pos);
        } else {
          this.pet.idleWander(dt);  // 游荡而非完全静止，视觉更自然
        }
        break;

      case 'assist':
        // 协助模式：主人没战斗时表现得像 follow，进入战斗时自动加害
        if (!owner.inCombat) {
          if (distToOwner > this.cfg.followDistance) this.nav.moveToward(this.pet, owner.pos);
          break;
        }
        const target = nearbyEnemies
          .filter(e => distance(e.pos, this.pet.pos) < this.cfg.aggroRange)
          .sort((a, b) => distance(a.pos, this.pet.pos) - distance(b.pos, this.pet.pos))[0];
        if (target) {
          if (distance(target.pos, this.pet.pos) > this.cfg.attackRange) {
            this.nav.moveToward(this.pet, target.pos);
          } else {
            this.pet.attack(target);
          }
        }
        break;

      case 'guard':
        // 守护：驻守在 guardPoint，只攻击进入守护半径的敌人，绝不追击出范围
        const intruder = nearbyEnemies.find(e => distance(e.pos, this.pet.guardPoint) < this.cfg.attackRange);
        if (intruder) this.pet.attack(intruder);
        else this.pet.holdPosition(this.pet.guardPoint);
        break;

      case 'stay':
        // 待命：完全不动，常用于「主人不想让宠物引来巡逻怪」的场景
        break;
    }
  }
}
```

宠物 AI 状态机的流转（横轴是触发条件，纵轴是模式切换）：

```
宠物 AI 状态机：
              ┌──────── 跟随(Follow) ◀──默认模式
              ▼
   主人进入战斗 ──▶ 协助(Assist): 选目标攻击
              │              │
              │     目标死亡/脱离 ◀──┘
              ▼
   手动切守护 ──▶ 守护(Guard): 驻守点位
              │
   超过牵绳范围(leashRange) ──▶ 瞬移回主人身边(防丢失)
```

不同控制模式的资源开销差异显著，策划在做宠物定位时要权衡：

| 控制模式 | 触发条件 | 行为目标 | 资源开销 | 适用场景 |
|---------|---------|---------|---------|---------|
| 跟随(Follow) | 默认 / 离战斗状态 | 靠近主人，idle 漫游 | 低（只做寻路 + 游荡） | 探索、跑图、休闲玩法 |
| 协助(Assist) | 主人 inCombat 自动切 | 主动索敌攻击 | 高（寻路 + 索敌 + 攻击判定） | 通用战斗、副本、PVE |
| 守护(Guard) | 玩家手动指定点位 | 驻守点位、驱逐近敌 | 中（只守不追，索敌范围小） | 守塔、护送、PVP 卡点 |
| 待命(Stay) | 玩家手动切 | 完全不动 | 极低（几乎无 AI 更新） | 潜行、不想引怪、截图 |

#### 二、属性继承链与双来源防重复加成

宠物属性不能独立结算——它要随主人成长，但「继承」和「独立」两个来源必须严格分层。最常见的 Bug 是：光环类 buff 同时作用于主人和宠物，而宠物继承的 `owner.atk` 里已经含了这份 buff，宠物自身又吃了一次，数值直接爆炸。

```typescript
// 宠物基础属性结构
interface PetStats {
  hp: number;
  atk: number;
  def: number;
  critRate: number;   // 0~1
  critDmg: number;    // 0~1
}

// 宠物属性模型：三层来源清晰分离
interface PetStatModel {
  baseStats: PetStats;              // 宠物自身基础（来自配置表，固定）
  inheritedRatio: Partial<PetStats>; // 继承系数 0~1（如 atk: 0.5 表示继承主人 atk 的 50%）
  selfGrowth: PetStats;             // 独立成长（宠物自身等级、装备、技能书加成）
}

// 计算最终属性 —— 关键是给每个数值打上来源标签，便于面板展示和去重
function computeFinalStats(pet: Pet, owner: Owner): PetStats {
  const model = pet.statModel;
  const final: PetStats = { ...model.baseStats };

  // 继承层：实时同步主人当前面板（主人换装 buff 后立即反映）
  // ⚠️ 双重加成 Bug 的根源：
  //   假设有个「全队攻击力 +20%」的 party buff，同时加在主人和宠物身上。
  //   owner.atk 已经含了这份 buff，pet 继承 owner.atk（含一次），
  //   pet 自己的 selfGrowth 又被 party buff 加成了一次 → buff 被算两遍。
  //   修复：给每个 buff 打 source tag（如 'party_buff_xxx'），
  //         合并时按 source 去重 —— 已在 owner.atk 中出现过的 source，pet 不再单独享受。
  const inheritedAtk = owner.atk * (model.inheritedRatio.atk ?? 0);
  const dedupedInheritedAtk = owner.applyBuffDedup(inheritedAtk, pet.activeBuffSources);

  final.atk = model.baseStats.atk + dedupedInheritedAtk + model.selfGrowth.atk;
  final.def = model.baseStats.def + owner.def * (model.inheritedRatio.def ?? 0) + model.selfGrowth.def;
  final.hp = model.baseStats.hp + owner.hp * (model.inheritedRatio.hp ?? 0) + model.selfGrowth.hp;
  final.critRate = model.baseStats.critRate + (model.inheritedRatio.critRate ?? 0) + model.selfGrowth.critRate;
  final.critDmg = model.baseStats.critDmg + (model.inheritedRatio.critDmg ?? 0) + model.selfGrowth.critDmg;

  // 把每项最终值的来源记录下来，供属性面板 tooltip 展示（玩家能看到「+120 来自主人继承」）
  pet.lastStatBreakdown = recordSourceBreakdown(model, owner, final);
  return final;
}
```

属性来源的三层叠加关系（每层独立标记，合并时去重共享 buff）：

```
宠物最终属性 = 三层叠加（每层独立标记来源）：
  ┌─────────────────────────┐
  │ 宠物自身基础 (baseStats)  │  ← 配置表，固定
  ├─────────────────────────┤
  │ 继承自主人 (×继承系数)    │  ← 实时同步主人面板
  ├─────────────────────────┤
  │ 宠物独立成长 (等级/装备)  │  ← 养成系统产出
  └─────────────────────────┘
         ▼ 合并（去重共享 buff）
    最终计算属性（用于战斗结算）
```

#### 三、养成进化管线与事务性消耗

养成进化是宠物系统的「内容深度」所在，但也是 Bug 高发区。最关键的设计原则：**任何消耗资源的养成操作都必须是事务**——预扣资源、执行变更、成功提交或失败退还，三步缺一不可。

```typescript
type EvolutionStage = 'juvenile' | 'adult' | 'ultimate';

// 单步进化配置：fromStage → toStage 的所有条件、消耗和结果
interface EvolutionStep {
  fromStage: EvolutionStage;
  toStage: EvolutionStage;
  requiredLevel: number;            // 进化前必须达到的等级
  consumeItems: { itemId: string; count: number }[];  // 进化石等消耗
  resultModel: {
    appearance: string;             // 新外观资源 ID（换模型 + 换动画）
    unlockedSkills: string[];       // 进化解锁的技能
    statBonus: Partial<PetStats>;   // 进化带来的属性提升
  };
}

// 进化流程 —— 严格的事务语义，保证资源一致性
async function evolve(pet: Pet, step: EvolutionStep): Promise<void> {
  // 1. 前置校验：等级是否达标、当前 stage 是否匹配、材料是否充足
  checkRequirements(pet, step);   // 不满足直接抛错，不动任何资源

  // 2. 预扣资源 —— 先从背包扣除消耗材料，标记为「pending」
  await consumeResourcesTransactional(pet, step.consumeItems);

  // 3. 执行进化变更（外观、技能、属性），并持久化到存档
  try {
    applyEvolution(pet, step);      // 内存中更新宠物状态
    await persist(pet);             // 落库 —— 这一步最可能超时
  } catch (err) {
    // 4. 失败退还：进化失败则把预扣的资源全部退回，宠物状态不变
    await refund(pet, step.consumeItems);
    throw err;  // 向上层抛出，UI 提示玩家「进化失败，材料已退还」
  }
  // 成功路径：资源已扣、状态已存，事务完成
}
```

不同养成维度的事务复杂度和回滚策略差异很大，必须分别设计：

| 养成维度 | 资源类型 | 触发方式 | 风险点 | 回滚策略 |
|---------|---------|---------|---------|---------|
| 升级（经验） | 经验药水 / 战斗经验 | 经验条满自动升级 | 经验条溢出未结算 | 幂等写入，重算即可 |
| 突破（等级上限） | 突破材料 + 金币 | 玩家手动点击 | 扣料后突破动画中断 | 预扣 + 失败全额退还 |
| 进化（形态变化） | 进化石 + 专属道具 | 玩家手动触发 | 持久化超时、模型加载失败 | 完整事务：预扣→执行→提交/退还 |
| 好感度（互动） | 互动道具 / 时间 | 喂食、抚摸、送礼 | 多次快速点击重复扣道具 | 操作节流 + 客户端乐观锁 |
| 技能学习（技能书） | 技能书 + 金币 | 玩家手动选择技能 | 技能书已扣但技能未写入 | 事务包裹，失败退还技能书 |

### ⚡ 实战经验

1. **宠物瞬移跟随卡顿**：宠物跟随用「距离超过阈值就瞬移到主人身边」的简单实现，结果主人快速移动时宠物每 2 秒瞬移一次，视觉上宠物「闪现」，且瞬移瞬间触发寻路重算导致 40ms 卡顿。改为基于 Steering 的平滑跟随（预测主人位置 + 插值移动 + leashRange 兜底只在丢失时瞬移）后，跟随流畅度大幅提升，卡顿消失。

2. **属性双重加成数值爆炸**：宠物攻击力继承主人攻击力（系数 0.5），同时主人有个「全队攻击力 +20%」的光环 buff。结果宠物 final.atk 被算了两次光环（继承的主人 atk 含一次，宠物自己又吃了一次），宠物的伤害比玩家本体还高 30%。修复：给每个 buff 打 source 标签，继承时只取「宠物未单独享受过」的来源。教训：多来源属性合并必须做来源去重。

3. **进化失败资源不一致**：宠物进化消耗 5 个进化石，进化石扣了但 applyEvolution 阶段抛异常（服务器持久化超时），结果玩家少 5 个石头宠物还没进化，客服补偿到手动处理。改为「预扣资源 → 执行进化 → 成功提交 / 失败退还」的完整事务后，资源一致性 100%。养成消耗类操作都必须事务化。

4. **多宠物快速切换闪烁**：玩家有 3 只宠物，快速连续点击切换出战，导致前一只宠物召回动画还没播完新宠物就召唤出来，画面上同时出现 2 只宠物且位置错乱闪烁。加入「切换锁」（切换中 0.5s 内忽略新的切换请求）+ 召回完成回调后才允许召唤新宠物后，切换丝滑。高频切换类操作都需要节流/锁。

5. **召唤动画卡手影响战斗**：召唤宠物要播 1.5 秒的出场动画，期间玩家无法移动和攻击，PVP 中成了「召唤即送死」。改为「动画与逻辑解耦」：宠物召唤瞬间就生效（能立即战斗），出场动画只是视觉表现（不阻塞玩家操作），动画播放期间宠物用渐显（fade-in）方式出现。教训：任何功能性的动画都不能阻塞核心玩法。

### 🔗 相关问题

- 宠物 AI 如果要做得更聪明（如主动治疗低血量主人、优先攻击远程敌人、躲避 BOSS 的范围技能），需要引入什么决策架构？简单的 if-else 控制模式与行为树/Utility AI 的边界在哪？
- 多人 MMO 中每个玩家都有宠物，同屏可能有上百只宠物实体，如何控制性能开销？宠物 LOD（远距离降级 AI 频率/关闭动画）、宠物数量上限、服务端 vs 客户端宠物模拟的分工如何设计？
- 宠物的「好感度系统」如何与对话系统、剧情 Flag 联动？好感度阈值触发特殊对话或剧情分支时，如何保证触发时序正确（好感度变化 → 检查阈值 → 触发对话，不能在战斗中弹对话）？
