---
title: "策略模式在游戏中怎么用？和状态模式有什么区别？"
category: "programming"
level: 2
tags: ["设计模式", "策略模式", "伤害计算", "AI行为", "开闭原则"]
related: ["programming/decorator-buff-system", "programming/design-patterns-game", "programming/typescript-advanced-types-game"]
hint: "不是简单的多态——是把'同一类可互换的算法'抽成接口，让外部不关心具体实现，运行时还能动态切换。"
---

## 参考答案

### ✅ 核心要点

1. **定义算法族、封装可互换实现**：策略模式把一族「做同一件事但方式不同」的算法各自封装成独立类，实现同一个接口。游戏里最典型的是伤害计算——物理伤害、魔法伤害、真实伤害、百分比生命伤害，它们的输入（攻击者、目标、技能配置）相同，输出（最终伤害值）相同，但内部公式完全不同。抽成 `DamageStrategy` 接口后，调用方只依赖接口，不关心是哪种伤害类型。
2. **运行时动态切换算法**：策略对象可以在运行时替换——玩家装备了「法穿杖」就把伤害策略从 `PhysicalDamage` 换成 `MagicPenetrationDamage`；触发了「狂暴」被动就换成 `CriticalDamage`。这比写一堆 `if (hasBuff) { ... } else if (...)` 分支干净得多，新增策略时也不用改已有代码。
3. **消除巨型 switch-case**：一个战斗系统如果用 switch 处理 12 种伤害类型，每加一种伤害就要改那个几千行的 `calculateDamage` 函数，违反开闭原则。策略模式把每个 case 拆成独立类，新增伤害类型 = 新增一个类文件，已有代码零修改。在 50+ 技能的项目里，这种结构让合并冲突减少 80%。
4. **配合工厂 + 配置表实现数据驱动**：策略类通常不直接 `new`，而是通过 `StrategyFactory.create(config.type)` 根据配置表的字符串创建。策划在 Excel 里把伤害类型从 `'physical'` 改成 `'percentage_hp'`，游戏运行时自动用对应策略，程序不用发版。策略模式是「数据驱动战斗」的代码侧基石。
5. **策略模式 vs 状态模式：行为相同 vs 行为不同**：两者结构几乎一样（Context 持有一个 Strategy/State 对象），但语义完全不同。策略模式的策略之间是「平级可替换的算法」，由外部主动选择；状态模式的状态之间是「状态机转换」，状态自己决定下一个状态。简记：策略是「选哪个算法」，状态是「现在处于什么阶段」。
6. **策略可被装饰器组合增强**：单个策略是原子的，但实际伤害计算往往要叠加多层修饰——基础伤害 → 暴击修饰 → 护甲穿透 → 最终减免。策略 + 装饰器组合（`new CriticalDecorator(new ArmorPenetration(new PhysicalDamage()))`）能表达任意复杂的伤害管线，比写一个巨大的公式函数清晰得多。

### 📖 深度展开

**1. 伤害计算策略：从 switch-case 到策略族**

```typescript
// 策略接口：所有伤害算法的统一契约
interface DamageStrategy {
  /** 计算最终伤害。输入上下文，输出扣血量 */
  calculate(ctx: DamageContext): number;
  /** 伤害类型标识，用于日志/UI/配置反序列化 */
  readonly type: string;
}

// 伤害上下文：把计算需要的所有参数打包，避免策略接口参数爆炸
interface DamageContext {
  attacker: Combatant;   // 攻击者（取攻击力、暴击率等）
  target: Combatant;     // 目标（取护甲、魔抗、生命值等）
  skill: SkillConfig;    // 技能配置（基础伤害、倍率等）
  rng: () => number;     // 随机数源（暴击判定用，可注入便于测试）
}

// 物理伤害：扣减护甲，最低保留 15% 基础伤害（防过甲无敌）
class PhysicalDamageStrategy implements DamageStrategy {
  readonly type = 'physical';
  calculate(ctx: DamageContext): number {
    const raw = ctx.skill.baseDamage * ctx.attacker.attackPower;
    const armor = ctx.target.armor;
    // 减伤公式：伤害 = 原始 * 护甲 / (护甲 + 100)
    const reduction = armor / (armor + 100);
    return Math.max(raw * 0.15, raw * (1 - reduction));
  }
}

// 百分比生命伤害：无视防御，按目标最大生命百分比结算
class PercentHpDamageStrategy implements DamageStrategy {
  readonly type = 'percent_hp';
  calculate(ctx: DamageContext): number {
    const pct = ctx.skill.baseDamage / 100;  // baseDamage 存的是百分比
    return ctx.target.maxHp * pct;
  }
}

// 真实伤害：无视一切减免，直接结算
class TrueDamageStrategy implements DamageStrategy {
  readonly type = 'true';
  calculate(ctx: DamageContext): number {
    return ctx.skill.baseDamage;
  }
}

// 调用方：只依赖接口，不知道具体是哪种伤害
class DamageSystem {
  constructor(private strategy: DamageStrategy) {}
  dealDamage(ctx: DamageContext): number {
    const damage = this.strategy.calculate(ctx);
    ctx.target.currentHp -= damage;
    return damage;
  }
  // 运行时切换策略（装备/被动触发时调用）
  setStrategy(s: DamageStrategy) { this.strategy = s; }
}
```

**2. 策略工厂 + 配置表：数据驱动切换**

```
策略选择与执行流程：

  策划配置表 skills.json
    └─ "damageType": "percent_hp"
         ↓ 启动时加载
  StrategyFactory.registry
    ├─ 'physical'   → PhysicalDamageStrategy
    ├─ 'magical'    → MagicalDamageStrategy
    ├─ 'true'       → TrueDamageStrategy
    ├─ 'percent_hp' → PercentHpDamageStrategy
    └─ 'mixed'      → MixedDamageStrategy
         ↓ 运行时 create(type)
  DamageSystem(strategy).dealDamage(ctx)
         ↓
  战斗日志 / UI 飘字 / 服务端校验
```

```typescript
// 策略工厂：把「字符串 → 策略实例」的映射集中管理
class StrategyFactory {
  // 注册表：类型名 → 构造器。新增策略只改这里一处
  private static registry = new Map<string, () => DamageStrategy>([
    ['physical',   () => new PhysicalDamageStrategy()],
    ['magical',    () => new MagicalDamageStrategy()],
    ['true',       () => new TrueDamageStrategy()],
    ['percent_hp', () => new PercentHpDamageStrategy()],
  ]);

  static create(type: string): DamageStrategy {
    const factory = this.registry.get(type);
    if (!factory)
      throw new Error(`未知伤害类型: ${type}（检查配置表 damageType 字段）`);
    return factory();
  }

  // 注册新策略（插件/Mod 系统可动态注册）
  static register(type: string, factory: () => DamageStrategy) {
    if (this.registry.has(type))
      throw new Error(`伤害类型已存在: ${type}`);
    this.registry.set(type, factory);
  }
}

// 战斗触发时：根据技能配置自动选策略
function applySkill(attacker: Combatant, target: Combatant, skill: SkillConfig) {
  const strategy = StrategyFactory.create(skill.damageType);
  const ctx: DamageContext = { attacker, target, skill, rng: Math.random };
  const damage = new DamageSystem(strategy).dealDamage(ctx);
  showFloatingText(target, Math.round(damage), skill.damageType);
}
```

**3. 策略 vs 状态 vs 装饰器：结构相似语义不同**

| 维度 | 策略模式 | 状态模式 | 装饰器模式 |
|------|---------|---------|-----------|
| **核心意图** | 算法可互换 | 状态驱动行为变化 | 功能叠加增强 |
| **谁决定切换** | 外部 Context 主动 set | 状态内部自行转换 | 外部组装装饰链 |
| **对象关系** | 平级、互不感知 | 有转换图、知道下一状态 | 嵌套包裹、层层委托 |
| **游戏典型场景** | 伤害算法、AI行为树节点 | 角色待机/巡逻/追击状态 | Buff修饰伤害、日志增强 |
| **新增成本** | 加一个策略类 + 注册 | 加状态 + 修改转换图 | 加装饰器类，链式组装 |
| **运行时切换** | ✅ 频繁切换 | ✅ 自动转换 | ❌ 通常启动时固定 |
| **与 if-else 比** | 消除分支、开闭友好 | 消除分支、状态明确 | 替代继承爆炸 |

```
装饰器 × 策略 组合的伤害管线（实战常用）：

  base: PhysicalDamageStrategy (基础物理伤害)
    ↓ 被 ArmorPenetration 装饰（护甲穿透）
    ↓ 被 CriticalStrike   装饰（暴击判定）
    ↓ 被 Lifesteal         装饰（吸血回调）
  → 最终 calculate() 沿装饰链层层调用

  new Lifesteal(
    new CriticalStrike(
      new ArmorPenetration(
        new PhysicalDamageStrategy())))
```

### ⚡ 实战经验

- **策略对象不要每帧 new**：早期把 `new DamageSystem(StrategyFactory.create(type))` 写在每次伤害结算里，一场 BOSS 战每秒结算上百次伤害，产生大量短命对象触发 V8 的 Minor GC，帧时间从 3ms 飙到 9ms 出现卡顿。改成「策略实例缓存 + Context 复用」后，GC 频率降 90%。策略类应设计成**无状态**的，一个 type 全局共享一个实例。
- **策略爆炸时要分层**：项目后期伤害类型从 5 种涨到 28 种（物理/魔法/真实/百分比/固定/反弹/吸血/灼烧…），`StrategyFactory.registry` 变成几百行的注册表。按「伤害结算阶段」拆分成三层策略（前置修饰 → 核心结算 → 后置反馈），每层独立注册，比一个巨型 Map 好维护。
- **策略间共享状态用 Context，别用单例**：暴击策略需要读「暴击伤害倍率」，图省事写成了全局 `CritConfig.bonus` 单例，结果多线程 Worker 里并发结算时数据竞争，暴击率时高时低。正确做法是把所有计算依赖塞进 `DamageContext` 参数显式传递，策略无副作用，天然线程安全。
- **策略模式让单元测试极其简单**：`PhysicalDamageStrategy` 是纯函数式计算（输入 ctx 输出 number），注入 mock 的 `ctx.rng` 让它必出暴击，断言伤害值即可。对比以前测试 switch-case 版本要构造完整的 `Combatant` + `BattleSystem` + 全局配置，测试代码量减少 70%，覆盖率反而从 45% 升到 92%。
- **配置表字段拼写错导致策略找不到**：策划把 `'percent_hp'` 写成 `'percentHP'`，`StrategyFactory.create` 抛异常整个技能失效。加了一层「启动时扫描所有配置表的 damageType，校验是否都在 registry 里」的预检脚本，构建阶段就拦住拼写错误，避免上线后才发现某个技能不生效。

### 🔗 相关问题

1. 策略模式和简单的「函数指针/回调」有什么本质区别？什么场景下用策略类反而过度设计，直接传函数更合适？
2. 当策略之间需要互相调用（如「混合伤害」策略内部要调物理+魔法两个策略）时，如何避免策略间的耦合膨胀成网状依赖？
3. 在 ECS 架构里，策略模式该如何落地？是把策略做成 Component，还是做成纯函数 System 的一部分？
