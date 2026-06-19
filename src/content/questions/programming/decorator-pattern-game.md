---
title: "装饰器模式如何实现 Buff 和装备的属性叠加？和子类继承相比优势在哪？"
category: "programming"
level: 2
tags: ["设计模式", "装饰器模式", "Buff系统", "装备系统", "属性叠加"]
related: ["programming/strategy-pattern-game", "programming/composite-pattern-game", "programming/state-pattern-game"]
hint: "不是给角色类加 100 个子类——是用装饰器像套娃一样层层包裹核心对象，每一层加一种修饰，运行时动态组合，拆装只增删外层。"
---

## 参考答案

### ✅ 核心要点

1. **装饰器模式核心是\"用组合代替继承，层层包裹动态叠加行为\"**：装饰器和被装饰者实现同一接口，内部持有一个被包裹的对象（component），调用时先执行自己的附加逻辑、再委托给内部对象。套娃式层层包裹：`(new CritBuff(new AtkBuff(new Hero())))`，最外层先执行。相比继承，装饰器能在运行时动态增删修饰（穿脱装备、加减 Buff），而继承是编译期固定的、新增组合会子类爆炸（攻击Buff × 暴击Buff × 吸血Buff × ... = 排列组合爆炸）。
2. **装饰器保持接口不变是关键契约**：装饰后的对象和原始对象对调用方完全透明——都是 `ICharacter`，调用 `getAttack()` 时层层转发累加。这让装饰器可以无限嵌套、任意顺序组合，调用方无需感知包裹了几层。如果装饰器改变了接口，它就退化成了适配器模式；如果装饰器有多个接口分支，说明职责拆分得不好。
3. **属性叠加的两种语义：乘算 vs 加算必须区分**：加算（additive）装饰器直接 `return component.getAtk() + bonus`；乘算（multiplicative）装饰器 `return component.getAtk() * multiplier`。混合叠加时顺序影响最终值（`(+100) × 1.5 ≠ (+100) × 1.5` 当基础不同时）。游戏里通常约定：基础属性 → 加算 Buff → 乘算 Buff → 最终修正，装饰器嵌套顺序必须严格遵循这个规则，否则伤害计算结果不可预测。
4. **与子类继承的本质区别是\"组合优于继承\"**：继承是静态的（编译期决定）、纵向的（is-a 关系）、子类爆炸的（N 种修饰组合 = 2^N 个子类）；装饰器是动态的（运行时组合）、横向的（has-a 包装）、线性增长的（N 种修饰 = N 个装饰器类，任意组合）。当一个类的可变维度超过 2 个（如角色 × 装备 × Buff × 状态），继承会让子类数量爆炸，装饰器是标准解法。
5. **游戏典型场景：Buff/Debuff 系统、装备属性、技能修饰、UI 组件嵌套**：RPG 的攻击力/防御力/暴击 Buff 叠加（攻击药水 + 武器附魔 + 狂暴技能）；装备系统（武器加攻击、护甲加防御、饰品加速度，穿脱即增删装饰器层）；技能修饰（基础技能 + 范围扩大 + 伤害加深 + 元素附加）；UI 组件（滚动条装饰列表、边框装饰面板、阴影装饰按钮）。

### 📖 深度展开

**1. Buff 叠加系统：装饰器的经典实现**

```typescript
// 统一接口：英雄和所有装饰器都实现它，保证套娃后接口不变
interface ICharacter {
  getAttack(): number;   // 攻击力
  getDefense(): number;  // 防御力
  getSpeed(): number;    // 速度
  getDescription(): string;
}

// 核心对象（被装饰者）：基础英雄
class Hero implements ICharacter {
  constructor(private baseAtk: number, private baseDef: number, private baseSpd: number) {}
  getAttack() { return this.baseAtk; }
  getDefense() { return this.baseDef; }
  getSpeed() { return this.baseSpd; }
  getDescription() { return '基础英雄'; }
}

// 装饰器基类：持有被包裹对象，默认行为是直接转发
abstract class CharacterDecorator implements ICharacter {
  constructor(protected inner: ICharacter) {}
  getAttack() { return this.inner.getAttack(); }
  getDefense() { return this.inner.getDefense(); }
  getSpeed() { return this.inner.getSpeed(); }
  getDescription() { return this.inner.getDescription(); }
}

// 加算攻击 Buff：攻击力 +50
class AtkAddBuff extends CharacterDecorator {
  constructor(inner: ICharacter, private bonus: number) { super(inner); }
  getAttack() { return this.inner.getAttack() + this.bonus; }  // 加算
  getDescription() { return `${this.inner.getDescription()} + 攻击+${this.bonus}`; }
}

// 乘算暴击 Buff：攻击力 ×1.5
class CritMultBuff extends CharacterDecorator {
  constructor(inner: ICharacter, private multiplier: number) { super(inner); }
  getAttack() { return this.inner.getAttack() * this.multiplier; }  // 乘算
  getDescription() { return `${this.inner.getDescription()} + 暴击×${this.multiplier}`; }
}

// 吸血 Buff：不改属性，但给攻击附加吸血效果（行为修饰）
class LifestealBuff extends CharacterDecorator {
  constructor(inner: ICharacter, private ratio: number) { super(inner); }
  // 可以扩展接口或用事件钩子实现"攻击时吸血"
  getDescription() { return `${this.inner.getDescription()} + 吸血${(this.ratio*100)}%`; }
}

// 运行时动态组合：穿装备、吃 Buff 就是套娃
let hero: ICharacter = new Hero(100, 50, 10);
hero = new AtkAddBuff(hero, 50);    // 吃攻击药水：攻击 100→150
hero = new CritMultBuff(hero, 1.5); // 触发狂暴：攻击 150→225
hero = new LifestealBuff(hero, 0.2); // 装备吸血：攻击仍 225，附加吸血
// ✅ 套娃：Lifesteal(Crit(AtkAdd(Hero)))
//    拆装只移除外层，不影响核心和内层，动态生效
console.log(hero.getAttack()); // 225
console.log(hero.getDescription()); // 基础英雄 + 攻击+50 + 暴击×1.5 + 吸血20%
```

**2. 继承 vs 装饰器：当修饰维度爆炸时**

```
需求：角色有 4 种独立修饰维度
  维度1: 攻击Buff（有/无）
  维度2: 防御Buff（有/无）
  维度3: 暴击Buff（有/无）
  维度4: 吸血Buff（有/无）

继承方案（子类爆炸）：
  Hero → AtkHero → AtkDefHero → AtkDefCritHero → AtkDefCritLifestealHero
                          ↘ ...每个维度翻倍，2^4 = 16 个子类
  每加一个维度，子类数翻倍。10 个维度 = 1024 个子类。❌ 不可维护

装饰器方案（线性增长）：
  Hero（1个核心） + 4个装饰器类（AtkBuff/DefBuff/CritBuff/LifestealBuff）
  运行时任意组合，无需为新组合写类。✅ 4 个装饰器搞定 16 种组合
```

| 维度 | 继承方案 | 装饰器方案 |
|------|---------|-----------|
| **扩展方式** | 新增子类 | 新增装饰器类 + 运行时组合 |
| **类数量（N 维度）** | 2^N（指数爆炸） | N + 1（线性） |
| **时机** | 编译期固定 | 运行时动态 |
| **增删成本** | 改代码、重新编译 | 增删外层装饰器对象 |
| **关系** | is-a（纵向） | has-a（横向包裹） |
| **顺序控制** | 无法控制叠加顺序 | 套娃顺序决定执行顺序 |
| **缺点** | 灵活性差、子类爆炸 | 嵌套过深难调试、顺序敏感 |

**3. 顺序敏感性：加算与乘算的陷阱**

```typescript
// 同样的两个 Buff，包裹顺序不同，结果可能不同
const hero1 = new AtkAddBuff(new CritMultBuff(new Hero(100, 0, 0), 1.5), 50);
// 先乘后加：(100 × 1.5) + 50 = 200

const hero2 = new CritMultBuff(new AtkAddBuff(new Hero(100, 0, 0), 50), 1.5);
// 先加后乘：(100 + 50) × 1.5 = 225

// ✅ 顺序不同，攻击力不同！游戏必须约定固定叠加顺序
// 通常规则：基础 → 所有加算 → 所有乘算 → 最终修正
// 用一个 BuffManager 统一管理装饰器的嵌套顺序，禁止随意套娃

class BuffManager {
  private hero: ICharacter;
  apply(buffs: Buff[]): ICharacter {
    // 按优先级排序：加算类在前，乘算类在后
    const sorted = buffs.sort((a, b) => a.priority - b.priority);
    let result = this.hero;
    for (const buff of sorted) result = buff.wrap(result);  // 按固定顺序套娃
    return result;
  }
}
```

```
装饰器嵌套执行流（从外到内，再从内到外返回）：

getAttack() 调用流向：
  调用方 ──► [CritMultBuff] ──► [AtkAddBuff] ──► [Hero]
     ×1.5         +50              base=100
     返回 225 ◄── 返回 150 ◄────── 返回 100

  外层装饰器先被调用，但返回值是"内层结果 × 自己的修饰"
  像洋葱模型：请求从外穿到内，结果从内裹到外
```

### ⚡ 实战经验

- **嵌套顺序写反导致数值崩盘**：把乘算暴击 Buff 套在加算 Buff 外层 vs 内层，伤害差 13%（200 vs 225）。某次更新把 Buff 施加顺序从"先加后乘"改成"先乘后加"，导致氪金玩家的满 Buff 伤害掉了 15%，被玩家骂了一周。Buff 叠加顺序必须用文档固化 + 单元测试覆盖，`assert finalAtk == expected`。
- **同种 Buff 叠加次数限制**：攻击药水能吃多瓶，每瓶 +50，无限叠就成了 BUG。装饰器本身不限嵌套层数，需要业务层加"同类型最大层数"限制。一个 `BuffStack` 管理器记录每种 Buff 的当前层数，超限拒绝新增装饰器。
- **装饰器引用泄漏导致属性不还原**：Buff 过期后没移除对应装饰器层，`hero` 还持有旧装饰器引用，攻击力永远偏高。解法：装饰器带 `expireTime`，每帧检查过期后重建整条链（移除过期层）。重建比"剪掉中间层"简单——中间层剪掉要重建内层引用，容易出错。
- **调试时嵌套链太深看不清**：5 层装饰器套娃，`getAttack()` 报错时不知道是哪层的问题。给每个装饰器实现 `getDescription()`，打印时能看到完整链条（"基础 + 攻击+50 + 暴击×1.5 ..."），调试效率翻倍。生产环境可以关掉描述拼接省开销。
- **装饰器不要做成单例**：早期把 `AtkAddBuff` 做成单例省内存，结果两个英雄共享同一个装饰器实例，A 英雄的 inner 指向被 B 覆盖了。装饰器持有 per-entity 的 inner 引用，必须每个包裹关系实例化一份，单例化是反模式。

### 🔗 相关问题

1. 当 Buff 之间有互斥关系（如"狂暴"和"冰冻"不能共存）时，装饰器组合如何做冲突检测？是在 BuffManager 层拦截，还是让装饰器自己感知同链上的其他装饰器？
2. 装饰器模式和策略模式都用组合代替继承，区别在哪？策略是"同一时刻选一个算法"，装饰器是"同一时刻叠加多个修饰"——这个边界如何向团队讲清楚？
3. TypeScript 的 `@decorator` 语法（装饰器）和设计模式里的装饰器模式是同一回事吗？它们各自解决什么问题，为什么名字相同但机制完全不同？
