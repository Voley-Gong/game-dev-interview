---
title: "工厂/建造者/原型模式在游戏中怎么用？敌人波次生成、武器配置、存档克隆分别选哪个？"
category: "architecture"
level: 2
tags: ["工厂模式", "建造者模式", "原型模式", "创建型模式", "设计模式", "架构设计"]
related: ["architecture/object-pool-design-pattern", "architecture/type-object-pattern", "architecture/save-system-architecture"]
hint: "创建型模式不是'new 的语法糖'——工厂解决'谁来造、造哪种'，建造者解决'怎么一步步拼装复杂对象'，原型解决'从已有实例克隆出新实例'；混用它们的标志是类型耦合，选错会让敌人系统和存档反序列化变成 if-else 堆场。"
---

## 参考答案

### ✅ 核心要点

1. **三种创建型模式解决的问题不同**：工厂（Factory）封装"根据类型/参数决定创建哪个具体类"的逻辑，调用方不关心 new 的细节；建造者（Builder）把"复杂对象的分步构造"与"最终表示"分离，同一套构造步骤能产出不同配置；原型（Prototype）通过"复制已有实例"来创建新对象，避免重新走完整构造流程。按"创建决策、构造过程、复制来源"三个维度来选。
2. **工厂模式适合"同类多型、按需选择"**：敌人波次系统里，策划配置"这一波出 3 个 Goblin + 2 个 Orc"，代码不写 `if(type==Goblin) new Goblin()`，而是 `factory.Create(type)`。配合类型对象（Type Object）或注册表，新增敌人类型零代码改动——工厂 + 类型注册是游戏敌人/子弹/特效生成的标准范式。
3. **建造者模式适合"参数多、可选组合复杂"**：一个角色有几十个可选配置（种族、职业、初始装备、技能槽、外观），直接构造函数参数爆炸。Builder 用链式调用 `.Race().Class().Equip().Build()` 逐步装配，清晰且能复用构造步骤（如"所有新手角色都加默认装备"封装成一个 Director）。
4. **原型模式适合"复制已有对象"**：存档反序列化、编辑器复制、同配置批量生成时，从一个"模板实例"克隆出多个副本比重新走工厂+建造者快得多。原型的关键是**深拷贝 vs 浅拷贝**的把控——浅拷贝共享引用会导致多个角色改同一份装备数据。
5. **游戏里常组合使用，配合对象池**：工厂决定"造哪种"，原型/建造者负责"具体怎么造出来"，对象池负责"造好之后复用"。三者分工：类型决策 → 实例构造 → 生命周期复用。理解这条流水线，敌人系统、子弹系统、道具系统的架构就清晰了。

### 📖 深度展开

**三种模式在敌人/武器/存档场景的选型：**

```
场景决策树：
  需要根据配置/类型决定造哪种对象？        → 工厂（敌人波次、子弹类型）
  对象参数多、需分步可选装配？             → 建造者（角色捏脸、装备组合）
  需要从一个已有实例快速复制？             → 原型（存档克隆、编辑器复制、批量同配生成）
```

**工厂 + 类型注册表：敌人波次生成（核心代码）：**

```csharp
// 敌人抽象 + 具体类型
public abstract class Enemy { public abstract void Spawn(Vector3 pos); }
public class Goblin : Enemy { /* ... */ }
public class Orc : Enemy { /* ... */ }

// 工厂：注册"类型键 → 创建委托"，新增敌人只注册不改调用方
public class EnemyFactory {
    private readonly Dictionary<string, Func<Enemy>> _registry = new();
    public void Register(string key, Func<Enemy> ctor) => _registry[key] = ctor;
    public Enemy Create(string key) =>
        _registry.TryGetValue(key, out var ctor)
            ? ctor()
            : throw new ArgumentException($"未知敌人类型: {key}");
}
// 启动注册（或用反射/特性自动扫描注册）：
_factory.Register("goblin", () => new Goblin());
_factory.Register("orc",     () => new Orc());
// 波次配置驱动：策划配 ["goblin","goblin","orc"]，代码循环 Create，零分支判断
```

**建造者模式：角色分步装配（链式 Builder）：**

```csharp
public class CharacterBuilder {
    private readonly Character _c = new();
    public CharacterBuilder Race(Race r)      { _c.Race = r; return this; }
    public CharacterBuilder Class(Class c)    { _c.Class = c; return this; }
    public CharacterBuilder WithDefaultGear() { _c.Equip(StarterKit.For(_c.Class)); return this; }
    public CharacterBuilder Skill(SkillId s)  { _c.LearnSkill(s); return this; }
    public Character Build() {
        // 构造完成校验：必须有种族和职业
        if (_c.Race == null || _c.Class == null) throw new InvalidOperationException("角色未配置完整");
        return _c;
    }
}
// 使用：清晰、可选、可复用构造步骤（Director）
var hero = new CharacterBuilder()
    .Race(Race.Human).Class(Class.Warrior)
    .WithDefaultGear()                       // 复用"新手默认装备"步骤
    .Skill(SkillId.Whirlwind)
    .Build();
```

**原型模式：存档克隆（深拷贝要点）：**

```csharp
// 原型接口：Clone 返回深拷贝副本
public interface IPrototype<T> { T DeepClone(); }

public class CharacterState : IPrototype<CharacterState> {
    public string Name;
    public Vector3 Position;
    public List<ItemStack> Inventory;          // ⚠️ 引用类型，必须深拷贝
    public CharacterDef Def;                    // ⚠️ 共享配置可浅拷贝（只读）

    public CharacterState DeepClone() {
        return new CharacterState {
            Name = Name,
            Position = Position,                          // 值类型，直接复制
            Inventory = Inventory.ConvertAll(i => i.Clone()), // ✅ 列表逐项深拷贝
            Def = Def                                      // ✅ 配置定义只读，共享引用即可
        };
    }
}
// 存档反序列化 / 编辑器"复制角色"：从模板克隆，省去重新走 Builder 的开销
var newInstance = templateState.DeepClone();
```

**工厂 / 建造者 / 原型 对比：**

| 维度 | 工厂模式 | 建造者模式 | 原型模式 |
|------|----------|------------|----------|
| 核心问题 | 造哪种？怎么隐藏 new？ | 怎么分步拼装复杂对象？ | 怎么从已有实例复制？ |
| 调用方式 | `factory.Create(key)` | `builder.A().B().Build()` | `prototype.Clone()` |
| 创建来源 | 从零构造 | 从零分步构造 | 从已有实例克隆 |
| 适用 | 多类型、配置驱动 | 参数多、可选装配 | 存档/批量同配/复制 |
| 与对象池 | 配合：工厂造、池复用 | 通常单独用 | 配合：克隆模板入池 |
| 典型游戏场景 | 敌人/子弹/特效生成 | 角色/装备捏造 | 存档/编辑器/批量怪 |

### ⚡ 实战经验

- **别用"上帝工厂"把所有类型塞一起**：一个 `GameFactory` 同时造敌人、子弹、UI、特效，违反单一职责，膨胀成几千行的 if-else。按领域拆分：`EnemyFactory`、`BulletFactory`、`EffectFactory`，每个工厂只注册自己领域的类型，配合命名空间和接口隔离，新增类型时只动对应工厂。
- **原型模式深浅拷贝搞错是最隐蔽的数据污染 bug**：浅拷贝导致两个角色共享同一个背包 List，玩家 A 捡装备时 B 的背包也变了——这种 bug 不报错、难复现。铁律：可变集合、可变引用类型必须深拷贝；只读配置/定义（Type Object、ScriptableObject）可以浅拷贝共享。存档系统尤其要严格区分"实例状态（深拷贝）"与"配置引用（共享）"。
- **建造者的 Build() 一定要做完整性校验**：链式调用容易漏配，`new CharacterBuilder().Race(Human).Build()` 忘了职业就构造出半成品，后续逻辑全崩。`Build()` 里对必填字段做断言/抛异常，越早暴露配置错误越好。别让"不完整对象"流入系统——这是空引用和逻辑错误的常见根源。
- **工厂 + 对象池配合时，注意"创建"与"复用"的边界**：工厂负责"造出一个初始状态正确的对象"，池负责"归还时重置 + 复用"。常见错误是在工厂的创建委托里塞了重置逻辑，导致每次 Get 都重复初始化。清晰分工：工厂只管"首次构造"，池的 `OnSpawn`/`OnDespawn` 管理复用时的状态复位，两者职责不重叠。

### 🔗 相关问题

1. 用反射 + 特性自动注册敌人类型到工厂，相比手动 Register，在启动性能、IL2CPP 裁剪、热更新场景下各有什么坑？
2. 原型模式的深拷贝在包含循环引用（角色↔队伍、装备↔穿戴者）时如何正确克隆？为什么序列化/反序列化常被当作通用深拷贝手段？
3. 抽象工厂（Abstract Factory）在游戏里何时才真正需要？它和"工厂 + 类型注册表"在跨平台/多画风项目里如何取舍？
