---
title: "工厂模式在游戏实体创建中怎么用？简单工厂、工厂方法、抽象工厂有什么区别？"
category: "programming"
level: 2
tags: ["设计模式", "工厂模式", "实体创建", "数据驱动", "依赖注入"]
related: ["programming/strategy-pattern-game", "programming/design-patterns-game", "programming/typescript-advanced-types-game"]
hint: "不是简单的 new——是把对象创建逻辑封装起来，让调用方不关心具体类型，配合配置表实现策划驱动的实体生成。"
---

## 参考答案

### ✅ 核心要点

1. **封装对象创建过程，调用方只依赖接口**：工厂模式的核心思想是把 `new ConcreteClass()` 这个操作从业务代码中剥离出来——调用方传入一个类型标识符（字符串/枚举），工厂内部决定实例化哪个具体类。好处是调用方不依赖具体类型，只依赖工厂返回的抽象接口，新增实体类型时调用方代码零修改。
2. **三种递进形态：简单工厂 → 工厂方法 → 抽象工厂**：简单工厂（一个函数 + switch）适合类型少、变化不频繁的场景；工厂方法（每个产品一个工厂类）适合需要灵活扩展的场景；抽象工厂（一个工厂创建一族相关产品）适合需要保证产品族一致性的场景（如「暗黑风格 UI 套件」 vs 「卡通风格 UI 套件」）。
3. **游戏实体创建是工厂模式的天然战场**：一个 RPG 游戏有数百种怪物、道具、技能，每种都是从配置表读取数据来构造的。如果在代码里到处 `new Goblin()`、`new HealingPotion()`，加一种怪物就要改 N 处代码。用工厂 + 配置表后，策划在 Excel 加一行数据、程序零修改就能生成新实体。
4. **配合对象池实现高性能创建**：工厂方法返回的对象可以来自对象池而非 `new`——`EnemyFactory.create('goblin')` 先检查池中有没有回收的 Goblin，有就重置属性后返回，没有才 new。这把创建成本从 GC 压力下的 0.1ms 降到 0.001ms（对象复用），是弹幕游戏、割草游戏中成百上千实体高频生成的关键。
5. **依赖注入容器是工厂模式的终极形态**：大型游戏框架（如 Cocos Creator 的组件系统）内部就是一个 DI 容器——注册类型 → 按需创建 → 注入依赖。理解工厂模式是理解引擎底层组件生命周期的基础。

### 📖 深度展开

**1. 简单工厂：配置表驱动的怪物生成**

```typescript
// 实体公共接口
interface Enemy {
  readonly type: string;
  hp: number;
  attack: number;
  speed: number;
  update(dt: number): void;
  takeDamage(amount: number): void;
}

// 具体怪物类
class Goblin implements Enemy {
  readonly type = 'goblin';
  hp = 50;  attack = 8;  speed = 3.5;
  update(dt: number) { /* 哥布林 AI：游荡 + 偷袭 */ }
  takeDamage(n: number) { this.hp -= n; }
}

class Orc implements Enemy {
  readonly type = 'orc';
  hp = 200; attack = 25; speed = 2.0;
  update(dt: number) { /* 兽人 AI：正面冲锋 */ }
  takeDamage(n: number) {
    this.hp -= n * 0.8; // 兽人有 20% 减伤
  }
}

class Slime implements Enemy {
  readonly type = 'slime';
  hp = 30;  attack = 5;  speed = 1.5;
  update(dt: number) { /* 史莱姆 AI：弹跳移动 */ }
  takeDamage(n: number) { this.hp -= n; }
}

// ── 简单工厂：一个 switch 搞定所有类型 ──
class EnemyFactory {
  private static registry = new Map<string, () => Enemy>([
    ['goblin', () => new Goblin()],
    ['orc',    () => new Orc()],
    ['slime',  () => new Slime()],
  ]);

  static create(type: string, config?: EnemyConfig): Enemy {
    const factory = this.registry.get(type);
    if (!factory)
      throw new Error(`未知怪物类型: ${type}（检查配置表 enemyId）`);
    const enemy = factory();
    // 用配置表覆盖默认属性（数据驱动）
    if (config) {
      enemy.hp = config.hp ?? enemy.hp;
      enemy.attack = config.attack ?? enemy.attack;
      enemy.speed = config.speed ?? enemy.speed;
    }
    return enemy;
  }

  // 启动时从配置表批量加载
  static loadFromConfig(table: Record<string, EnemyConfig>): void {
    for (const [id, cfg] of Object.entries(table)) {
      const baseEnemy = this.create(cfg.baseType, cfg);
      EnemyFactory.templates.set(id, baseEnemy);
    }
  }
}
```

**2. 工厂方法 vs 抽象工厂：结构差异**

```
工厂方法（Factory Method）：一个工厂创建一种产品

  EnemySpawner（抽象基类）
    ├── GoblinSpawner.create() → Goblin
    ├── OrcSpawner.create()    → Orc
    └── SlimeSpawner.create()  → Slime

  每个 Spawner 负责一种怪物的完整创建逻辑
  新增怪物 = 新增一个 Spawner 类（开闭原则）


抽象工厂（Abstract Factory）：一个工厂创建一族相关产品

  GameThemeFactory（抽象接口）
    │
    ├── DarkFantasyFactory（暗黑风主题）
    │     ├── createEnemy()  → Skeleton（骷髅兵）
    │     ├── createWeapon() → DarkSword（暗黑剑）
    │     └── createUI()     → GothicPanel（哥特面板）
    │
    └── CartoonFactory（卡通风主题）
          ├── createEnemy()  → HappySlime（开心史莱姆）
          ├── createWeapon() → BubbleWand（泡泡杖）
          └── createUI()     → RainbowPanel（彩虹面板）

  同一个工厂保证所有产品风格一致
  切换主题 = 切换工厂实例
```

```typescript
// ── 抽象工厂：保证产品族一致性 ──
interface Enemy {}
interface Weapon {}
interface GameUI {}

// 抽象工厂接口：创建一族相关产品
interface GameThemeFactory {
  createEnemy(config: EnemyConfig): Enemy;
  createWeapon(config: WeaponConfig): Weapon;
  createUI(): GameUI;
}

// 暗黑风工厂：所有产品都是暗黑风格
class DarkFantasyFactory implements GameThemeFactory {
  createEnemy(config: EnemyConfig): Enemy {
    return new Skeleton(config);   // 骷髅兵
  }
  createWeapon(config: WeaponConfig): Weapon {
    return new DarkSword(config);  // 暗黑剑
  }
  createUI(): GameUI {
    return new GothicPanel();      // 哥特面板
  }
}

// 卡通风工厂：所有产品都是卡通风格
class CartoonFactory implements GameThemeFactory {
  createEnemy(config: EnemyConfig): Enemy {
    return new HappySlime(config); // 开心史莱姆
  }
  createWeapon(config: WeaponConfig): Weapon {
    return new BubbleWand(config); // 泡泡杖
  }
  createUI(): GameUI {
    return new RainbowPanel();     // 彩虹面板
  }
}

// 使用：切换主题只需换工厂实例
class GameManager {
  constructor(private theme: GameThemeFactory) {}
  setTheme(theme: GameThemeFactory) { this.theme = theme; }
  spawnWave(waveConfig: WaveConfig) {
    for (const cfg of waveConfig.enemies)
      this.theme.createEnemy(cfg);  // 风格自动一致
  }
}
```

**3. 三种工厂模式对比与选型**

| 维度 | 简单工厂 | 工厂方法 | 抽象工厂 |
|------|---------|---------|---------|
| **结构复杂度** | 低（一个 switch/Map） | 中（每产品一个工厂类） | 高（工厂创建产品族） |
| **新增产品** | 改工厂 switch | 加新工厂类（不改旧代码） | 加新工厂类 + 产品族 |
| **开闭原则** | ❌ 违反（改 switch） | ✅ 符合 | ✅ 符合 |
| **产品维度** | 单一产品 | 单一产品 | 多个相关产品（产品族） |
| **游戏场景** | 怪物/道具生成 | 技能效果创建 | 主题/皮肤/季节活动 |
| **典型用法** | 配置表→实体 | 插件系统扩展 | UI 套件切换 |
| **过度设计风险** | 低 | 中 | 高（产品族少时别用） |

### ⚡ 实战经验

- **简单工厂够用就别上工厂方法**：项目初期有 8 种怪物，团队为了「正确性」给每种怪物写了独立的工厂类，结果 8 个工厂类代码量是实体本身的 3 倍，新增怪物时要改工厂接口 + 工厂实现 + 注册代码。后来重构回简单工厂（一个 Map + `() => new X()`），代码量减少 70%，新增怪物只需加一行注册。产品种类 <20 且不常变化时，简单工厂是最务实的选择。
- **配置表字段和工厂注册不一致是高频 Bug**：策划在配置表写了 `enemyId: "golin"`（拼写错误），工厂 registry 找不到抛异常，整个波次生成失败关卡卡死。加了一层「构建时校验脚本」——扫描所有配置表的 typeId 字段，检查是否都在工厂 registry 中存在，CI 阶段就拦截拼写错误，上线后此类 Bug 归零。
- **工厂 + 对象池让弹幕游戏从卡顿到流畅**：东方弹幕游戏同屏 800+ 弹幕，每帧创建销毁数百个 Bullet 对象，V8 的 Minor GC 每秒触发 4-5 次造成 5-8ms 卡顿。改造后 `BulletFactory.create()` 优先从对象池取（复用已回收的 Bullet），`destroy()` 不 delete 而是回收到池中。GC 频率降到每秒 0.2 次，帧时间稳定在 3ms 以内。
- **工厂方法在 ECS 架构中变成 System 注册器**：纯 ECS 架构不再 new 实体，而是用 `world.spawn(archetype)` 组装 Component。这本质上还是工厂模式——World 是工厂，Archetype 是类型标识，Component 是产品。理解这个映射关系后，从 OOP 工厂迁移到 ECS 的思路就清晰了：把「工厂创建实体」拆成「World 分配 Entity ID + System 填充 Component」。
- **抽象工厂的跨主题资源一致性**：万圣节活动需要同时替换怪物模型、UI 皮肤、BGM、特效，如果用简单工厂分散创建很容易遗漏（换了怪物但忘了换 UI 皮肤）。用抽象工厂后，`HalloweenFactory` 一次性保证所有产品都是万圣节风格，活动下线只需把工厂实例换回 `NormalFactory`，零遗漏。

### 🔗 相关问题

1. 工厂模式和建造者模式（Builder）有什么区别？什么场景下应该用 Builder 而不是 Factory？
2. 在数据驱动的游戏架构中，如何用 JSON/Excel 配置表完全替代工厂中的 switch-case？序列化和反序列化如何配合工厂使用？
3. 如果工厂需要创建的对象之间有依赖关系（如怪物创建时需要注入场景引用、事件总线），如何实现依赖注入而避免工厂变成「上帝对象」？
