---
title: "模板方法模式在游戏开发中如何应用？"
category: "programming"
level: 2
tags: ["设计模式", "模板方法", "生命周期", "好莱坞原则", "继承"]
related: ["programming/strategy-pattern-game", "programming/factory-pattern-game", "programming/state-pattern-game"]
hint: "不是策略模式换算法——是父类定算法骨架、子类填具体步骤，好莱坞原则'别调用我们，我们调用你'。"
---

## 参考答案

### ✅ 核心要点

1. **父类定义算法骨架，子类填空具体步骤**：模板方法在父类用一个具体方法把执行顺序串死，把可变的步骤声明为抽象方法让子类实现。变化点被严格限制在"填哪个空"，执行顺序由父类锁住，避免每个子类各自重写流程导致行为不一致——这是它与"子类随便重写"最大的区别。
2. **好莱坞原则 (Don't call us, we'll call you)**：父类主动调用子类的方法，控制反转的方向是"高层调用低层"，子类永远不主动驱动整体流程。这把控制权收拢到父类一处，新增子类只补步骤、不破坏顺序，符合"对扩展开放、对修改封闭"。
3. **具体方法 / 抽象方法 / 钩子方法三件套**：具体方法=固定不变的基础步骤（父类实现）；抽象方法=`abstract` 声明、必须由子类实现的必填步骤；钩子方法=空实现的可选覆盖点（如 `canSkip()` 默认返回 false），父类用 `if (hook())` 控制流程分支，子类按需覆写。
4. **与策略模式的本质区别是继承 vs 组合**：模板方法靠"继承"替换个别步骤，整体流程在编译期固定、不可运行时替换；策略模式靠"组合"替换整个算法，运行时可热切换。流程稳定、步骤多变选模板方法；整个算法需运行时替换选策略模式。
5. **游戏典型场景非常密集**：场景/关卡生命周期（`load→init→enter→exit`）、回合制战斗结算流程、抽卡/抽奖流程（洗牌→保底判定→奖励生成）、新手引导步骤机、资源加载骨架（预加载→校验→解析→缓存）、技能释放流水线（前摇→命中判定→伤害结算→后摇）。
6. **TS 用 abstract + protected 模拟，JS 靠约定**：TypeScript 用 `abstract` 声明必填步骤、`protected` 限定只让子类覆写、模板方法本身保持 `public final`（TS 无 `final`，靠约定下划线或 `@final` 注释）；JavaScript 没有访问修饰符，靠下划线命名约定 + 运行时检查兜底，不如 TS 安全。

### 📖 深度展开

**1. 场景生命周期模板：最经典的应用**

```typescript
// 父类：锁死生命周期顺序，把可变步骤声明为 abstract
abstract class GameScene {
  // 模板方法：final，子类不许重写，保证所有场景流程一致
  public runLifecycle(): void {
    this.onLoad();                          // 1. 加载资源（抽象，子类填）
    if (this.canSkipPreload()) {            // 2. 钩子：跳过预加载
      this.onPreload();
    }
    this.onInit();                          // 3. 初始化（抽象）
    this.onEnter();                         // 4. 进入（具体，默认实现）
    this.onStart();                         // 5. 开始（钩子，可选）
  }

  protected abstract onLoad(): void;        // 必填：每个场景资源不同
  protected abstract onInit(): void;        // 必填：每个场景逻辑不同
  protected onPreload(): void { /* 默认空 */ }
  protected onEnter(): void { this.node.active = true; }
  protected onStart(): void { /* 钩子：默认空，子类按需覆写 */ }
  protected canSkipPreload(): boolean { return false; }
}

// 战斗场景：只关心填空，不操心流程顺序
class BattleScene extends GameScene {
  protected onLoad() { this.loadMonsters(); }
  protected onInit() { this.spawnPlayers(); this.bindUI(); }
  protected onStart() { this.countdown(3); } // 利用钩子加倒计时
}
```

```
GameScene.runLifecycle()  ← 唯一入口，顺序由父类锁死
   │
   ├─► onLoad()        [abstract]  → BattleScene: loadMonsters
   │                              → LoadingScene: loadBundle
   ├─► canSkipPreload() [hook]    → 默认 false；Loading 场景覆写为 true
   ├─► onPreload()     [具体]     → 父类默认实现，子类通常不碰
   ├─► onInit()        [abstract] → BattleScene: spawnPlayers+bindUI
   ├─► onEnter()       [具体]     → node.active = true（所有场景共用）
   └─► onStart()       [hook]     → BattleScene: countdown(3)
```

**2. 模板方法 vs 策略模式 vs 回调钩子：何时选哪个**

| 维度 | 模板方法 | 策略模式 | 回调/钩子函数 |
|------|----------|----------|---------------|
| 核心机制 | 继承，覆写步骤 | 组合，替换算法 | 函数注入，运行时传参 |
| 流程控制权 | 父类锁死顺序 | 无固定流程 | 调用方控制 |
| 变化粒度 | 单个步骤 | 整个算法 | 单个动作点 |
| 扩展方式 | 新增子类 | 新增策略类 | 传新函数 |
| 运行时切换 | 不支持 | 支持 | 支持 |
| 适用 | 生命周期、流程骨架 | 伤害算法族、排序 | 事件回调、单次定制 |
| 游戏场景 | 场景生命周期 | 物理/真实/百分比伤害 | 按钮点击 onDone |

```typescript
// 同一个"技能释放"流程，三种实现对比
// ① 模板方法：固定 前摇→命中→伤害→后摇 顺序，子类只换伤害计算
abstract class Skill { cast() { this.windup(); this.hit(); this.damage(); this.recover(); } }

// ② 策略模式：整个伤害算法可热切换，流程由调用方决定
class Skill { constructor(private dmg: IDamageStrategy) {} cast() { this.dmg.compute(ctx); } }

// ③ 回调：流程交给引擎，只在关键点插逻辑
engine.playSkill(skillId, { onHit: (t) => applyDamage(t), onDone: () => endAnim() });
```

**3. 钩子方法：让模板可配置而无需继承**

```typescript
// 用钩子避免"为了改一行而继承整个类"的滥用
abstract class TurnBasedRound {
  public resolveRound(units: Unit[]): void {
    const ordered = this.sortUnits(units);        // 抽象：排序规则子类定
    for (const u of ordered) {
      if (this.beforeAction(u)) {                 // 钩子：返回 false 跳过本回合
        this.executeAction(u);                    // 抽象：行动逻辑子类定
      }
      this.afterAction(u);                        // 钩子：默认空，做日志/连击
    }
    if (this.isRoundEndHookEnabled()) {           // 钩子：是否触发回合结束
      this.onRoundEnd();
    }
  }
  protected abstract sortUnits(u: Unit[]): Unit[];
  protected abstract executeAction(u: Unit): void;
  protected beforeAction(u: Unit): boolean { return u.hp > 0; } // 默认：死亡跳过
  protected afterAction(u: Unit): void { /* 默认空 */ }
  protected isRoundEndHookEnabled(): boolean { return true; }
  protected onRoundEnd(): void { /* 默认空 */ }
}
// 新手副本：覆写钩子禁用回合结束事件，只改 1 行而不是重写整个 resolveRound
class TutorialRound extends TurnBasedRound {
  protected isRoundEndHookEnabled() { return false; }
}
```

```
钩子 vs 抽象方法的取舍：
  抽象方法 → 强制每个子类实现，缺了编译报错（必须的差异）
  钩子方法 → 默认空实现，子类"按需"覆写（可选的差异）
  ── 经验：90% 的定制点应该是钩子，只有"流程缺它就跑不动"的才是抽象方法
```

### ⚡ 实战经验

- **别让子类重写模板方法本身**：曾有同事把 `runLifecycle` 也标成 `protected`，结果一个新手在子类覆写时漏掉了 `onInit()`，场景进入后 UI 全白、排查了 2 小时。模板方法必须 `public` + 命名上加 `final` 约定（如 `runLifecycle`、`execute`），并在代码评审里卡死"不允许重写"。
- **继承层级别超过 2 层**：项目里出现 `BaseScene → BattleScene → PvpBattleScene → RankedPvpScene` 四层继承后，钩子和抽象方法的覆盖关系变得极难追踪，改一个钩子要读 4 个文件。超过 2 层立刻考虑改用组合/策略拆分，或把共享逻辑下沉成独立的 LifecycleManager。
- **钩子默认实现要"无副作用"**：把 `onRoundEnd` 钩子的默认实现写成"清场+播放音效"，结果一个忘了覆写的副本场景触发了意外的清场动画。钩子的默认实现必须是空方法或纯查询（返回 true/false），任何有行为的逻辑都让子类显式实现。
- **JS 无 protected，靠运行时检查兜底**：纯 JS 项目里子类误把 `onInit` 当成入口直接外部调用，跳过了 `onLoad`。加了一行 `if (!this._loaded) throw new Error('必须先调 runLifecycle')` 的状态守卫后杜绝了误用——TS 项目直接用 `protected` 一劳永逸。
- **回合制战斗用模板方法后调参变快**：把伤害结算流程拆成 `前摇/命中/伤害/后摇` 四个抽象步骤后，策划要加"霸体免疫后摇"，只需要在一个子类覆写 `recover()` 返回 noop，不用动主流程——迭代速度从改 1 天降到改 10 分钟。

### 🔗 相关问题

1. 模板方法模式和策略模式都能"换实现"，一个 MMORPG 的技能系统（流程固定 + 伤害算法多变）应该用哪个？能不能两者结合？
2. TypeScript 的 `abstract` 在编译成 JavaScript 后就消失了，运行时如何防止子类"忘记实现"某个抽象方法？有没有比手动 throw 更优雅的方案？
3. 如果游戏需要支持"模组(Mod)"由玩家自定义关卡流程，模板方法（继承）的开放性是否还够用？是否需要转向数据驱动的流程编排？
