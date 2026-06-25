---
title: "策略模式（Strategy）在游戏中如何应用？它与状态模式、简单工厂有何区别？"
category: "architecture"
level: 2
tags: ["Strategy", "策略模式", "设计模式", "运行时切换", "算法封装", "架构设计"]
related: ["architecture/solid-principles-game", "architecture/command-pattern-undo-redo", "architecture/component-based-architecture"]
hint: "把「做什么」和「怎么做」分开——策略模式把一组可互换的算法各自封装，运行时按需切换，是开闭原则（OCP）的经典落地。"
---

## 参考答案

### ✅ 核心要点

1. **核心定义：定义一系列算法，各自封装成独立类，使它们可以互相替换**。策略模式让算法的变化独立于使用算法的客户端。关键在于"可互换"——不同策略实现同一接口，客户端不关心具体用的是哪个。
2. **消除条件分支的利器**：没有策略模式时，`switch(skillType) { case Fire: ... case Ice: ... case Lightning: ... }` 会不断膨胀。有了策略模式，每种技能是一个 `ISkillStrategy` 实现，新增技能 = 新增类，不改原有代码——这就是开闭原则（OCP）。
3. **与状态模式的区别在于「谁触发切换」**：状态模式中，状态切换由状态自身或上下文的状态机驱动（如 HP<20% 自动进入逃跑状态）；策略模式中，策略切换由外部决策者主动选择（如玩家选了一个技能）。状态知道彼此的存在，策略之间互不感知。
4. **游戏中的典型场景**：① 技能/攻击方式（近战/远程/AOE/治疗）；② 寻路算法切换（A* / Dijkstra / JPS，按地图规模动态选）；③ 排序策略（按等级/按时间/按品质，背包列头点击切换）；④ AI 行为策略（激进/防御/游击，根据局势切换）。
5. **策略选择可数据驱动化**：把策略类名和参数写进配置表，运行时用反射或工厂创建——`config.strategyType = "AStarPathfinding"`，不需要改代码就能新增策略。这是策略模式从"代码可扩展"升级到"策划可配置"的关键一步。

### 📖 深度展开

**条件分支地狱 vs 策略模式：**

```
❌ switch 地狱（每加一种技能改这个巨型函数）：
  void CastSkill(SkillType type, Entity target) {
      switch(type) {
          case Fire:     // 80 行火焰逻辑
          case Ice:      // 60 行冰冻逻辑
          case Lightning: // 70 行闪电逻辑
          case Poison:   // 新需求来了，又加 50 行...
          // 函数越来越长，改一个 case 影响其他
      }
  }

✅ 策略模式（每加一种技能加一个类，互不影响）：
  ISkillStrategy
    ├─ FireSkillStrategy      : ISkillStrategy
    ├─ IceSkillStrategy       : ISkillStrategy
    ├─ LightningSkillStrategy : ISkillStrategy
    └─ PoisonSkillStrategy    : ISkillStrategy  ← 新增只需加类

  void CastSkill(ISkillStrategy skill, Entity target) {
      skill.Execute(caster, target);  // 不关心是什么技能
  }
```

**策略模式核心实现（以技能系统为例）：**

```csharp
// 1. 策略接口 —— 所有算法的共同契约
public interface ISkillStrategy {
    SkillType Type { get; }
    bool CanCast(Entity caster);           // 前置条件（蓝量、CD）
    void Execute(Entity caster, Entity target);  // 执行效果
    float GetCooldown();                   // CD 时间
}

// 2. 具体策略 —— 各自封装，互不依赖
public class FireballStrategy : ISkillStrategy {
    public SkillType Type => SkillType.Fire;
    public float GetCooldown() => 3.0f;

    public bool CanCast(Entity caster) {
        return caster.Mp >= 30 && caster.CooldownLeft <= 0;
    }

    public void Execute(Entity caster, Entity target) {
        caster.SpendMp(30);
        var dmg = CalculateDamage(caster, target);
        target.TakeDamage(dmg, DamageType.Fire);
        VFXManager.Play("fireball_hit", target.Position);
        // 灼烧 DoT 效果
        target.AddBuff(new BurnDebuff(duration: 3f, dps: dmg * 0.1f));
    }

    private float CalculateDamage(Entity caster, Entity target) {
        return caster.MagicAttack * 1.5f * ResistanceModifier(target, DamageType.Fire);
    }
}

public class HealStrategy : ISkillStrategy {
    public SkillType Type => SkillType.Heal;
    public float GetCooldown() => 5.0f;

    public bool CanCast(Entity caster) => caster.Mp >= 25;
    public void Execute(Entity caster, Entity target) {
        caster.SpendMp(25);
        var heal = caster.MagicAttack * 2.0f;
        target.Heal(heal);
        VFXManager.Play("heal_effect", target.Position);
    }
}

// 3. 上下文（Context）—— 持有当前策略，委托执行
public class SkillComponent {
    private readonly Dictionary<SkillType, ISkillStrategy> _skills;
    private ISkillStrategy _current;

    public SkillComponent() {
        // 策略注册 —— 可以改为从配置表反射创建
        _skills = new() {
            [SkillType.Fire] = new FireballStrategy(),
            [SkillType.Heal] = new HealStrategy(),
        };
    }

    public void SetCurrentSkill(SkillType type) {
        if (_skills.TryGetValue(type, out var skill))
            _current = skill;
    }

    public bool TryCast(Entity target) {
        var caster = GetComponent<Entity>();
        if (_current == null || !_current.CanCast(caster)) return false;
        _current.Execute(caster, target);
        return true;
    }
}
```

**数据驱动的策略选择（配置表 + 反射）：**

```csharp
// config.csv: skillId, strategyClass, mpCost, power, cooldown
// 1001, FireballStrategy, 30, 1.5, 3.0
// 1002, HealStrategy,     25, 2.0, 5.0

public class SkillFactory {
    private readonly Dictionary<int, ISkillStrategy> _cache = new();

    public ISkillStrategy Create(int skillId, SkillConfigRow config) {
        if (_cache.TryGetValue(skillId, out var cached)) return cached;

        // 反射创建策略类 —— 策划在表里加一行就能新增技能
        var type = Type.GetType($"MyGame.Skills.{config.StrategyClass}");
        var strategy = (ISkillStrategy)Activator.CreateInstance(type);

        // 如果策略需要参数，用初始化方法注入（非构造函数，保持无参创建）
        if (strategy is IConfigurable configurable)
            configurable.Configure(config.Power, config.Cooldown);

        _cache[skillId] = strategy;
        return strategy;
    }
}
```

**策略模式 vs 状态模式 vs 简单工厂：**

| 维度 | 策略模式 | 状态模式 | 简单工厂 |
|------|---------|---------|---------|
| 核心目的 | 算法可互换 | 状态驱动行为 | 对象创建封装 |
| 切换触发者 | 外部主动选择 | 内部条件自动切换 | 外部传入参数 |
| 实例间关系 | 互不感知 | 状态知道彼此（转移表） | 无（工厂不持有） |
| 典型游戏场景 | 技能/寻路/排序 | FSM 状态切换 | 创建不同类型敌人 |
| 生命周期 | 通常长期持有 | 频繁切换 | 用完即弃 |
| GoF 分类 | 行为型 | 行为型 | 创建型（非GoF） |

### ⚡ 实战经验

- **策略类应该是无状态的**（或状态极轻）。如果策略内部维护了大量上下文数据，说明它不该是策略而该是组件。纯策略类可以被所有同类实体共享（一个 `FireballStrategy` 实例给所有法师用），避免万级敌人各存一份策略对象的内存浪费。
- **策略切换的权限要收口**：谁有权调用 `SetCurrentSkill`？如果战斗系统、UI 系统、AI 系统都能随便切策略，会出现"UI 刚切了技能，AI 又切回去"的时序冲突。把切换权限集中到一个 `SkillController`，其他系统通过事件请求切换，由 Controller 统一仲裁。
- **警惕策略膨胀**：如果一个系统有 30+ 种策略，说明抽象粒度有问题。通常可以拆分成多个正交维度——比如「伤害类型」和「投射方式」拆成两个独立策略（`IDamageType` + `IProjectilePattern`），组合出 5×6=30 种技能，而不是写 30 个扁平策略类。
- **别为了用模式而用模式**：只有 2-3 种算法且不常新增时，直接 `switch` 反而更清晰易读。策略模式的收益在"算法频繁新增/变更"时才体现——过早抽象策略接口会增加不必要的类爆炸。

### 🔗 相关问题

1. 策略模式和命令模式（Command Pattern）有什么区别？技能系统应该用策略还是命令？
2. 如何用策略模式实现背包排序的「点击列头切换排序方式」？排序策略需要哪些接口设计？
3. 在 ECS 架构中，策略模式如何表达？System 本身是否就是策略的一种演化形态？
