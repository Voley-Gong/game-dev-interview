---
title: "如何用装饰器模式实现灵活的技能 Buff 叠加系统？"
category: "programming"
level: 2
tags: ["设计模式", "装饰器模式", "Buff系统", "RPG", "技能系统"]
related: ["programming/design-patterns-game", "programming/command-pattern-undo-redo", "programming/event-bus-architecture"]
hint: "不是继承层层堆叠——用包装链在运行时动态叠加攻防加成，增删 Buff 不影响核心属性接口。"
---

## 参考答案

### ✅ 核心要点

1. **装饰器模式的核心思想**：在不改变原有对象接口的前提下，通过"包装"（Wrap）动态地给对象添加职责。每个装饰器内部持有一个被装饰对象的引用，调用时先做自己的增强逻辑再委托给内层——像俄罗斯套娃一样层层嵌套，外层对内层透明。
2. **Buff 系统是装饰器的天然舞台**：RPG/MOBA 中角色身上同时挂着攻击力加成、暴击率提升、护甲减伤、中毒扣血等多种 Buff，它们各自独立、可叠加可移除、时序不同。用继承（`AngryWarrior extends Warrior`）会引发类爆炸（N 种 Buff 的排列组合 = 2ⁿ 个子类），装饰器则用运行时组合解决。
3. **统一接口是关键约束**：装饰器和被装饰对象必须实现同一个接口（如 `ICombatStats`），这样调用方无需知道外面包了几层——`getAttack()` 永远返回最终叠加值。违反这个约束（让装饰器暴露额外方法）会破坏透明性，导致拆包时类型断言满天飞。
4. **装饰链的顺序敏感性**：`+50%攻击` 和 `+100固定攻击` 谁先算结果不同。加法类 Buff 顺序无关，但乘法类 Buff（百分比加成）和减伤类 Buff 对顺序敏感。必须在文档和实现中明确计算顺序（通常先算加法、再算乘法、最后算减伤）。
5. **Buff 移除是最大工程挑战**：装饰器是链式结构，移除链中间的某个 Buff 不能直接断链——需要重建装饰链或用"标记失效 + 下次重建"策略。很多商业引擎干脆用"全量重算"：移除时清空所有装饰器，重新挂载有效 Buff。

### 📖 深度展开

**1. 装饰器模式实现 Buff 叠加系统**

```typescript
// 所有角色和 Buff 装饰器共同实现的战斗属性接口
interface ICombatStats {
  getAttack(): number;       // 攻击力
  getDefense(): number;      // 防御力
  getCritRate(): number;     // 暴击率
  getMoveSpeed(): number;    // 移动速度
  getName(): string;         // 角色名（用于调试输出）
}

// 被装饰的核心对象：角色基础属性
class Character implements ICombatStats {
  constructor(private baseAttack: number, private baseDefense: number,
              private baseCrit: number, private baseSpeed: number,
              private name: string) {}
  getAttack()   { return this.baseAttack; }
  getDefense()  { return this.baseDefense; }
  getCritRate() { return this.baseCrit; }
  getMoveSpeed(){ return this.baseSpeed; }
  getName()     { return this.name; }
}

// Buff 装饰器基类：持有内层引用，默认全部委托
abstract class BuffDecorator implements ICombatStats {
  constructor(protected inner: ICombatStats, protected remainingTurns: number) {}
  getAttack()    { return this.inner.getAttack(); }
  getDefense()   { return this.inner.getDefense(); }
  getCritRate()  { return this.inner.getCritRate(); }
  getMoveSpeed() { return this.inner.getMoveSpeed(); }
  getName()      { return this.inner.getName(); }
  isExpired()    { return this.remainingTurns <= 0; }
  tick()         { this.remainingTurns--; }
}

// 具体装饰器：攻击力加成（加法）
class AttackBuff extends BuffDecorator {
  constructor(inner: ICombatStats, turns: number, private bonus: number) { super(inner, turns); }
  getAttack() { return this.inner.getAttack() + this.bonus; }
  getName()   { return `${this.inner.getName()} +狂暴(${this.bonus}攻)`; }
}

// 具体装饰器：攻击力百分比加成（乘法，顺序敏感！）
class AttackMultiplierBuff extends BuffDecorator {
  constructor(inner: ICombatStats, turns: number, private multiplier: number) { super(inner, turns); }
  getAttack() { return Math.floor(this.inner.getAttack() * this.multiplier); }
  getName()   { return `${this.inner.getName()} +易伤(${this.multiplier}倍)`; }
}

// 使用：动态叠加多个 Buff
let hero: ICombatStats = new Character(100, 50, 0.2, 300, '战士');
hero = new AttackBuff(hero, 3, 50);              // +50 固定攻击，持续 3 回合
hero = new AttackMultiplierBuff(hero, 2, 1.5);   // 再 ×1.5，持续 2 回合
console.log(hero.getName());  // "战士 +狂暴(50攻) +易伤(1.5倍)"
console.log(hero.getAttack()); // (100 + 50) * 1.5 = 225
```

**2. 装饰链结构与 Buff 移除策略**

```
getAttack() 调用链（从外到内层层委托）：

AttackMultiplierBuff (×1.5)     ← 最外层装饰器，最后包装
  │ getAttack() = inner.getAttack() * 1.5
  ▼
AttackBuff (+50)                ← 中间装饰器
  │ getAttack() = inner.getAttack() + 50
  ▼
Character (baseAttack=100)      ← 核心，最内层
  │ getAttack() = 100

最终结果: (100 + 50) * 1.5 = 225

⚠️ 顺序敏感：如果交换两层 → (100 * 1.5) + 50 = 200，结果不同！
```

```typescript
// Buff 移除难题：链中间的 Buff 不能直接断开
// 解决方案：全量重算法——维护所有生效 Buff 的列表，每次变动重建装饰链
class BuffSystem {
  private buffs: Map<string, BuffDecorator> = new Map();  // buffId → 装饰器工厂配置
  private target: Character;  // 角色基础属性

  // 重新构建装饰链：从 base 开始，按优先级依次包装
  rebuild(): ICombatStats {
    let current: ICombatStats = this.target;
    // 固定优先级：加法类 > 乘法类 > 减伤类，保证计算一致性
    const ordered = [...this.buffs.values()].sort((a, b) => a.priority - b.priority);
    for (const buff of ordered) {
      current = buff.clone(current);  // 用新 inner 重新构造装饰器
    }
    return current;
  }

  addBuff(id: string, buff: BuffDecorator): void {
    this.buffs.set(id, buff);
    this.cachedStats = this.rebuild();  // 触发重建
  }

  removeBuff(id: string): void {
    this.buffs.delete(id);              // 只删配置，链在下次 rebuild 时自然不含它
    this.cachedStats = this.rebuild();
  }

  private cachedStats: ICombatStats;
  get stats(): ICombatStats { return this.cachedStats; }
}
```

**3. Buff 系统架构方案对比**

| 方案 | 核心思路 | 叠加/移除成本 | 顺序控制 | 适用场景 |
|------|----------|--------------|----------|----------|
| **装饰器链** | 套娃式包装，委托计算 | 移除需重建链 O(n) | 包装顺序即计算顺序 | Buff 种类少、逻辑简单 |
| **修饰符列表** | 维护 `Modifier[]`，getAttack 遍历求和 | 增删 O(1) | 需显式排序 | **主流方案**，Buff 种类多 |
| **事件驱动** | Buff 监听 `onAttack` 事件修改结果 | 增删 O(1) | 事件注册顺序，难保证 | 需要副作用（中毒扣血、反击） |
| **数据驱动公式** | 属性 = `base * Π(multipliers) + Σ(additions)` | 增删 O(1) | 公式内固定优先级 | 配置表驱动的商业 MMO |

```typescript
// 主流方案：修饰符列表——比装饰器链更灵活，增删 O(1)
enum ModifierType { FlatAdd, PercentMul, Override }  // 加法/乘法/覆盖

interface StatModifier {
  source: string;        // buffId，用于移除
  type: ModifierType;
  value: number;
  priority: number;      // 同类型内的排序
}

class StatContainer {
  private base: number;
  private mods: StatModifier[] = [];

  getValue(): number {
    // 1. 覆盖型优先（如"沉默"直接让攻击力为 0）
    const override = this.mods.filter(m => m.type === ModifierType.Override);
    if (override.length) return override[0].value;

    // 2. 加法类（固定值加成）
    let flat = this.base + this.mods
      .filter(m => m.type === ModifierType.FlatAdd)
      .sort((a, b) => a.priority - b.priority)
      .reduce((sum, m) => sum + m.value, 0);

    // 3. 乘法类（百分比加成），累乘
    const result = this.mods
      .filter(m => m.type === ModifierType.PercentMul)
      .sort((a, b) => a.priority - b.priority)
      .reduce((val, m) => val * m.value, flat);

    return Math.floor(result);
  }

  addModifier(mod: StatModifier): void { this.mods.push(mod); }
  removeBySource(source: string): void { this.mods = this.mods.filter(m => m.source !== source); }
}
```

### ⚡ 实战经验

- **装饰器深度超过 5 层性能急剧下降**：一个身上挂 20 个 Buff 的 BOSS，每次 `getAttack()` 都要遍历 20 层装饰链委托，战斗中每帧调用几十次属性查询，Profile 显示 `getAttack` 占了 8% 的 CPU。改为修饰符列表方案后降到 0.3%——装饰器适合教学和小规模，商业项目首选列表。
- **浮点百分比累加导致属性漂移**：连续叠 3 个 `×1.1` 的攻击 Buff，理论是 `base × 1.331`，但每层 `Math.floor` 取整后实际是 `floor(floor(floor(100×1.1)×1.1)×1.1) = 132` 而非 133。在排位赛中 1 点攻击力差值可能改变对局结果，后端必须用整数运算（攻击力 ×1000 存储，显示时除回去）。
- **Buff 过期时序的回合影集**：回合制游戏中，"持续 2 回合"的 Buff 在自己的回合结束时扣减还是敌方回合结束时扣减？两个角色互相施加同名 Buff 时过期顺序如何？必须在战斗系统层面统一定义——我们项目曾因这个不明确导致"先手玩家永远多吃 1 回合 Buff"的不平衡 Bug，上线三天被玩家发现。
- **永久属性 vs 临时 Buff 的边界模糊**：装备一把武器增加 50 攻击力，这是基础属性还是 Buff？如果用装饰器实现，卸下装备时要正确从链中移除。最佳实践是：装备影响 base 值（静态），技能/药品/buff 用修饰符（动态），两者分开管理避免"穿装备也变成 Buff"的混乱。
- **Buff 堆叠上限与唯一性**：同名 Buff 能否叠加（如两个毒叠加还是刷新持续时间）？策划通常需要配置 `maxStacks`（最大叠加层数）和 `stackRule`（叠加/刷新/替换）。装饰器方案天然支持叠加（多包几层），但要实现"刷新而非叠加"需要先检测同名 Buff 并移除旧的，工程上用修饰符列表 + `source` 去重更简单。

### 🔗 相关问题

1. 装饰器模式与组合模式（Composite）在结构上很相似（都是树/链结构），它们的设计意图有什么本质区别？
2. 如何将 Buff 系统的状态序列化到存档中？装饰器链的动态结构如何保证存档/读档的一致性？
3. 当 Buff 之间有互斥关系（如"无敌"期间不能被上毒）或触发链（"被攻击时 30% 概率反击"）时，架构该如何演进？
