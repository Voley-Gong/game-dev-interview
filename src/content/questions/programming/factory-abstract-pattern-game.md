---
title: "工厂方法与抽象工厂模式在游戏开发中如何应用？如何设计可扩展的实体创建体系？"
category: "programming"
level: 2
tags: ["设计模式", "工厂模式", "抽象工厂", "创建型模式", "架构设计"]
related: ["programming/object-pool-game", "programming/ecs-architecture-game", "programming/composite-pattern-game", "programming/strategy-pattern-game"]
hint: "new 一个敌人简单，但当你有 50 种敌人、每种还要配武器和技能时，散落在各处的 new 就是维护灾难。工厂模式把'创建逻辑'集中起来，调用方只说'给我一个弓箭手'，不关心它怎么被造出来的。"
---

## 参考答案

### ✅ 核心要点

1. **工厂模式的本质是"创建与使用分离"**：调用方不直接 `new` 具体类，而是通过工厂获取对象。好处是创建逻辑集中（改一处不影响调用方）、解耦（调用方只依赖接口不依赖具体类）、便于扩展（新增类型只加工厂分支）。游戏中敌人/道具/UI 弹窗的创建最适合工厂化——它们的创建过程涉及资源加载、属性初始化、组件挂载，分散在各处会产生大量重复代码。
2. **简单工厂 → 工厂方法 → 抽象工厂是三层演进**：① **简单工厂**：一个工厂类 + 一个 `switch/type` 分支，适合类型少且稳定；② **工厂方法**：每个产品一个工厂类，利用多态消除 switch，新增类型只需新增工厂不改旧代码（开闭原则）；③ **抽象工厂**：创建一族相关产品（如"骑士族"=骑士+剑+骑乘技能），保证产品族一致性。游戏里大部分场景简单工厂就够，跨阵营/种族的成套创建才需要抽象工厂。
3. **游戏中最典型的应用是"实体工厂"**：敌人工厂（按 ID/类型生成不同敌人并初始化血量/AI/掉落）、道具工厂（武器/防具/消耗品实例化）、角色职业工厂（战士/法师/弓手 + 对应技能组）、UI 工厂（根据配置生成不同弹窗）。这些场景的共同点是"类型多、创建步骤固定、后续可能扩展"，工厂把创建步骤封装成 `create(type, config) → Entity` 的统一入口。
4. **工厂要与"数据驱动配置"结合才是终极形态**：硬编码的 switch 工厂每加一种敌人要改代码、重新编译。成熟做法是"配置表（JSON/ScriptableObject/Excel）+ 工厂注册表"：策划在配置表填一行新敌人数据，工厂运行时按 type 查表动态创建，零代码新增类型。这是商业引擎（Unity、Cocos）的标准实践，工厂从"代码模式"升级为"数据驱动的运行时系统"。
5. **工厂与对象池/ECS 天然配合**：工厂负责"造"，对象池负责"复用"——工厂的 `create()` 内部优先从池里取而非 `new`。ECS 架构中工厂退化为"组件装配器"：按配置给 Entity 挂上 `HealthComponent` + `AIComponent` + `RenderComponent`，实体本身只是 ID。工厂不与具体架构冲突，而是适配不同架构的"创建策略"。
6. **警惕过度设计：不是所有 new 都要塞进工厂**：简单、稳定、单一的创建直接 `new` 即可。强行上抽象工厂会出现"为一种产品建一个工厂族"的荒谬结构，增加理解成本却无收益。判断标准：类型 ≥ 3 且有扩展预期、创建步骤 ≥ 2 步、多处调用同一创建逻辑——满足两条以上才值得工厂化。

### 📖 深度展开

**1. 三种工厂模式的 TypeScript 实现对比**

```typescript
// ===== 简单工厂：一个 switch 搞定，类型少时最实用 =====
class EnemyFactory {
  static create(type: EnemyType, level: number): Enemy {
    switch (type) {
      case 'goblin':  return new Goblin(level);   // 哥布林
      case 'orc':     return new Orc(level);       // 兽人
      case 'dragon':  return new Dragon(level);    // 龙
      default: throw new Error(`未知敌人类型: ${type}`);
    }
  }
}
const e = EnemyFactory.create('goblin', 5);  // 调用方无需知道 Goblin 类

// ===== 工厂方法：每个产品一个工厂，多态消除 switch =====
interface EnemyFactory { create(level: number): Enemy; }
class GoblinFactory implements EnemyFactory { create(l) { return new Goblin(l); } }
class DragonFactory implements EnemyFactory { create(l) { return new Dragon(l); } }
// 新增"巫妖"只需加 LichFactory，完全不碰旧代码（开闭原则）
const factory: EnemyFactory = registry.get('dragon');
const boss = factory.create(50);

// ===== 抽象工厂：创建一整族配套产品 =====
interface FactionFactory {
  createSoldier(level: number): Soldier;
  createWeapon(): Weapon;
  createSkill(): Skill;
}
// 人类族：剑士+铁剑+盾击    魔族：魔卒+魔杖+火球
class HumanFaction implements FactionFactory { /* 全套人类装备 */ }
class DemonFaction implements FactionFactory { /* 全套魔族装备 */ }
// 保证一个阵营的兵种、武器、技能风格一致，不会出现"魔族拿圣剑"
```

**2. 数据驱动的工厂注册表（商业项目标配）**

```typescript
// 配置表驱动：策划填 Excel/JSON，工厂运行时按 type 查表创建，零代码扩展
interface EnemyConfig { type: string; cls: string; hp: number; speed: number; ai: string; drop: string; }
const configTable: Record<string, EnemyConfig> = loadJSON('enemies.json');

// 注册表：type → 构造器，新增敌人只需注册一行
const registry = new Map<string, () => Enemy>();
function register(type: string, ctor: () => Enemy) { registry.set(type, ctor); }

class DataDrivenFactory {
  create(type: string): Enemy {
    const cfg = configTable[type];              // 查配置
    const ctor = registry.get(cfg.cls);          // 查注册表拿构造器
    const enemy = ctor();                         // 创建实例
    enemy.init(cfg.hp, cfg.speed, cfg.ai, cfg.drop); // 用配置初始化
    return enemy;
  }
}
// 策划在 enemies.json 加一行 {"type":"lich_boss","cls":"Lich",...}，
// 代码里 register('Lich', () => new Lich())，立即生效，无需改工厂逻辑
```

```
创建流程对比：

硬编码工厂：                    数据驱动工厂：
策划提需求 → 程序改代码          策划改 JSON → 热重载生效
  → 编译 → 测试 → 上线            → 游戏内即时验证
  [周期：天级]                    [周期：分钟级]
  新增 50 种敌人 = 50 次发版      新增 50 种敌人 = 改 50 行 JSON
```

| 维度 | 简单工厂 | 工厂方法 | 抽象工厂 | 数据驱动工厂 |
|------|---------|---------|---------|------------|
| 新增类型成本 | 改 switch（违反开闭） | 加工厂类 | 加工厂族 | 改配置+注册 |
| 适合类型数 | ≤10 | 任意 | 产品族 | 任意 |
| 产品一致性 | 不保证 | 单产品 | ✅ 族内一致 | 按配置保证 |
| 策划可维护 | ❌ | ❌ | ❌ | ✅ 改表即可 |
| 典型场景 | 快速原型 | 类型多且扩展 | 阵营/种族 | ✅ 商业项目 |

**3. 工厂 + 对象池：创建与复用的协同**

```typescript
// 工厂内部优先从池取，池空才 new——兼顾"统一创建入口"和"零 GC"
class PooledEnemyFactory {
  private pools = new Map<string, ObjectPool<Enemy>>();  // 每种类型一个池
  create(type: string, level: number): Enemy {
    const pool = this.pools.get(type);
    const enemy = pool ? pool.get() : this.fallbackNew(type); // 池优先
    enemy.reset(level);                        // 复用对象必须重置
    return enemy;
  }
  destroy(enemy: Enemy, type: string): void {
    this.pools.get(type)?.release(enemy);      // 销毁=归还池
  }
}
```

### ⚡ 实战经验

- **简单工厂的 switch 膨胀到 800 行**：项目初期用简单工厂，敌人类型从 5 种涨到 60 种，`switch` 分支膨胀到 800 行且每个分支都有独特初始化逻辑，改一个分支怕影响其他。重构为"注册表 + 数据驱动"后，工厂核心代码降到 30 行，新增敌人零代码修改。教训：类型超过 10 种就别用 switch 工厂，早点上注册表。
- **滥用抽象工厂导致类爆炸**：一个只有"战士/法师"两种职业的游戏，却为每种职业建了 `WarriorFactory`+`MageFactory`，再配 `WeaponFactory`+`SkillFactory` 组成抽象工厂族，总共 8 个类，调用方要 new 4 个工厂才能创建一个角色。实际只需要一个简单工厂 + 配置表。教训：产品族 ≤ 2 且不频繁扩展时，抽象工厂是负担不是帮助。
- **工厂创建的对象忘记池化导致 GC**：怪物工厂的 `create()` 每次都 `new`，刷怪频繁时每秒产生上百个敌人对象，GC 尖峰卡顿。工厂内部接入对象池后，同屏 200 个敌人的 GC 频率从每秒 3 次降到 0。工厂是引入对象池的最佳切入点——因为所有创建都经过它，加池化只改一处。
- **配置表与代码不同步的运行时崩溃**：策划在 JSON 填了新敌人 `type:"ice_golem"`，但忘了在代码里 `register('IceGolem', ...)`，游戏运行到该敌人刷新点直接抛 `未知类型` 异常崩溃。解法：启动时校验配置表所有 type 是否都已注册，缺失的在编辑器里红色警告而非运行时崩溃。配置驱动必须配套校验机制。

### 🔗 相关问题

1. 工厂模式和原型模式（Prototype）如何配合？当敌人创建成本高（需加载模型/贴图）时，先工厂创建一个"模板原型"，之后用深拷贝快速复制——这种"原型工厂"在 Unity 的 `Instantiate(prefab)` 中如何体现？
2. ECS 架构下工厂模式是否还有意义？实体只是一组组件的 ID，"创建敌人"变成了"给 Entity 挂上 Health+AI+Render 组件"——这时工厂是退化为"组件装配函数"还是演变为"Archetype（原型组合）"系统？
3. 当游戏需要支持 MOD（玩家自定义敌人）时，工厂如何从"编译期注册"进化为"运行期动态加载脚本定义新类型"？Lua/JS 热更新沙箱与工厂注册表如何对接？
