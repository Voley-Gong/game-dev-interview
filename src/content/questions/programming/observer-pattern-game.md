---
title: "观察者模式在游戏中如何实现？它和事件总线有什么区别？"
category: "programming"
level: 2
tags: ["设计模式", "观察者模式", "解耦", "架构设计", "TypeScript"]
related: ["programming/event-bus-architecture", "programming/decorator-buff-system", "programming/state-pattern-game"]
hint: "面试官想区分的是：Subject 直接持有 Observer 列表的紧耦合模型，和 EventBus 这种中央中介——什么场景用哪个？"
---

## 参考答案

### ✅ 核心要点

1. **观察者模式的本质是「一对多」依赖**：一个 Subject（被观察者）状态变化时，自动通知所有注册的 Observer，观察者做出反应。游戏中典型场景是「血量变化」同时触发血条 UI、伤害飘字、成就判定、死亡逻辑——它们互不知道彼此，只听 Subject 的通知。
2. **Subject 直接持有 Observer 列表是它和事件总线的核心区别**：观察者模式里 Subject 知道「谁在观察我」；事件总线里发布者和订阅者互不感知，只通过中央总线通信。前者是直接耦合，后者是完全解耦。
3. **推（Push）模型传整个数据，拉（Pull）模型只通知、由 Observer 自己来取**：推模型实时性好但可能传了不需要的数据；拉模型灵活但需要 Observer 反向访问 Subject，耦合更紧。游戏中血量这种小数据用推模型，背包这种大数据用拉模型（只通知 slot 变了）。
4. **弱引用是避免泄漏的关键**：Observer 销毁时如果不主动 `detach`，Subject 会一直持有它的引用导致 GC 不掉。用 `WeakRef`（ES2021）或让 Subject 持弱引用，可以让 Observer 被回收后自动失效。
5. **通知顺序不应被依赖**：多个 Observer 监听同一 Subject 时，触发顺序由注册顺序决定，但业务逻辑绝不能假设「血条更新一定在伤害飘字之前」——一旦 Subject 改变存储结构（数组换 Set），隐式顺序就崩了。
6. **观察者适合「少量、稳定、强相关」的监听**：一个角色的血量只有几个固定系统关心；而「金币变化」这种全游戏广播就该用事件总线。混淆两者会导致要么过度耦合、要么过度抽象。

### 📖 深度展开

#### 1. 经典观察者模式的完整实现

```typescript
// === Observer 接口：所有观察者实现统一的通知入口 ===
interface Observer<T> {
  update(data: T): void;
}

// === Subject 基类：管理观察者列表并在状态变化时广播 ===
abstract class Subject<T> {
  private observers: Set<Observer<T>> = new Set();

  attach(observer: Observer<T>): void {
    this.observers.add(observer);
  }

  detach(observer: Observer<T>): void {
    this.observers.delete(observer);
  }

  // 通知时复制一份再遍历，防止 Observer 在回调中 attach/detach 破坏迭代
  protected notify(data: T): void {
    for (const observer of [...this.observers]) {
      observer.update(data);
    }
  }
}

// === 具体业务：角色血量组件 ===
interface HealthChangedData {
  current: number;
  max: number;
  delta: number;       // 本次变化量（正为治疗，负为伤害）
  source: string;      // 伤害来源
}

class HealthComponent extends Subject<HealthChangedData> {
  constructor(private hp: number, private maxHp: number) {
    super();
  }

  takeDamage(amount: number, source: string): void {
    const old = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    this.notify({ current: this.hp, max: this.maxHp, delta: this.hp - old, source });
  }

  heal(amount: number): void {
    const old = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.notify({ current: this.hp, max: this.maxHp, delta: this.hp - old, source: "heal" });
  }
}

// === 各个观察者：互不感知，只对数据做出反应 ===
class HealthBarUI implements Observer<HealthChangedData> {
  update(d): void { this.setBarFill(d.current / d.max); }
  private setBarFill(ratio: number): void { /* 更新血条缩放 */ }
}

class DamageNumberFX implements Observer<HealthChangedData> {
  update(d): void { if (d.delta < 0) this.spawnFloatText(Math.abs(d.delta)); }
  private spawnFloatText(n: number): void { /* 飘字特效 */ }
}

class AchievementTracker implements Observer<HealthChangedData> {
  update(d): void { if (d.current <= 0) this.checkAchievement("first_blood"); }
  private checkAchievement(id: string): void { /* 成就判定 */ }
}

// === 组装：血量变化自动联动 3 个系统 ===
const hero = new HealthComponent(100, 100);
hero.attach(new HealthBarUI());
hero.attach(new DamageNumberFX());
hero.attach(new AchievementTracker());
hero.takeDamage(30, "goblin");  // 血条缩减 + 飘出 -30 + 无成就
```

```
血量组件（Subject）        观察者（Observers）
  HealthComponent    ──notify──►  HealthBarUI      （更新血条）
  hp = 70            ──notify──►  DamageNumberFX   （飘出 "-30"）
                     ──notify──►  AchievementTracker（判定成就）
   │ 直接持有列表
   └─ observers: Set<Observer>  ← Observer 销毁必须 detach，否则泄漏
```

#### 2. 推模型 vs 拉模型

| 维度 | 推模型（Push） | 拉模型（Pull） |
|------|---------------|---------------|
| 通知数据 | Subject 把变化数据整个传过去 | 只通知「我变了」，Observer 主动回查 |
| Observer 知道多少 | 只拿到 delta，看不到 Subject 全貌 | 可访问 Subject 任意字段 |
| 耦合方向 | 数据流向 Observer（松） | Observer 反向引用 Subject（紧） |
| 性能 | 数据小则快；数据大则每通知都深拷贝 | 按需查询，避免无效传输 |
| 游戏场景 | 血量、金币、状态机变化 | 背包、技能列表、大配置变更 |

```typescript
// 推模型：notify 直接传 HealthChangedData（小对象，适合）
class HealthComponent extends Subject<HealthChangedData> { /* 见上 */ }

// 拉模型：只广播"哪一格变了"，UI 自己去 InventoryService 取最新数据
interface InventoryChangedHint { slotId: number; }  // 只传索引
class Inventory extends Subject<InventoryChangedHint> {
  private items: Map<number, Item> = new Map();
  removeItem(slotId: number): void {
    this.items.delete(slotId);
    this.notify({ slotId });  // 不传 Item 全量数据（可能含图标纹理引用）
  }
  getItem(slotId: number): Item | undefined { return this.items.get(slotId); }
}
```

#### 3. 观察者模式 vs 事件总线：到底用哪个？

```
观察者模式（直接耦合）              事件总线（中央中介）
  HealthComponent ──┐                HealthComponent ──emit("PlayerDamaged")
                    │                                   │
   直接持有 Observer 列表                  谁都不认识谁，只认识 Bus
                    │                                   │
  ┌─────────────────┴┐                ┌─────────────────┴────────┐
  HealthBar  DamageFX  Achievement    HealthBar  DamageFX  Achievement
  (Subject 必须存在才能监听)          (Bus 是全局单例，随时可监听)
```

| 对比维度 | 观察者模式 | 事件总线 |
|---------|-----------|---------|
| 耦合度 | Subject ↔ Observer 双向知晓 | 完全解耦，双方只认 Bus |
| 生命周期 | Subject 销毁则监听消失 | Bus 是全局单例，需手动 off |
| 类型安全 | 容易做到（Subject 泛型绑定数据） | 需映射类型才能强类型 |
| 事件来源追踪 | 简单（直接看 Subject） | 难（emit 散落各处） |
| 适用规模 | 单实体上的少数监听（一个角色的状态） | 全局广播（金币、登录、关卡切换） |
| 内存泄漏风险 | 中（Subject 持强引用） | 高（Bus 持久存在，易忘 off） |

**决策原则**：监听者就是被观察对象身上的「部件」（血条是角色的一部分）→ 观察者模式；监听者和发布者没有直接关系（成就系统监听全服击杀）→ 事件总线。混用最常见：角色内部用观察者联动部件，跨系统用事件总线广播。

### ⚡ 实战经验

- **Observer 忘记 detach 是头号泄漏**：某 RPG 的伤害飘字 Observer 创建后没在特效播完时 detach，一场 Boss 战创建 2000+ 个飘字 Observer 全挂在 Boss 的 Subject 上，Boss 不死则永远回收不掉，内存从 80MB 涨到 600MB。解法是给一次性 Observer 用「播完即 detach」或改用 `WeakRef`。
- **通知时遍历被破坏的集合**：Boss 死亡时 `notify` 遍历 Observer 列表，其中一个 Observer（死亡逻辑）在回调里把另一个 Observer（血条）detach 了，导致 `Set` 迭代中修改报错或跳过。必须复制成数组 `[...this.observers]` 再遍历。
- **隐式顺序依赖酿成 Bug**：早期代码假设「先扣血再判定死亡」，于是 AchievementObserver 依赖 HealthBarObserver 先执行。后来把存储从数组改成 Set，顺序乱了，Boss 满血时就触发死亡成就。规则：Observer 之间不允许有执行先后依赖，需要顺序就合并成一个 Observer 或显式分阶段通知。
- **高频通知淹没 Observer**：毒伤每 0.1 秒触发一次血量 notify，10 个 Observer 每次都全量响应，60 帧下额外多了 600 次/秒回调。改成「血量变化超过阈值或整数位变化才 notify」，回调量降到 1/10。
- **拉模型里 Observer 持有 Subject 引用也要清理**：背包拉模型 Observer 反向持有 `Inventory` 引用来查数据，切换场景时 Observer 销毁了但 Inventory 还在，反之亦然——双向引用极容易成环。要么统一在场景卸载时断开，要么改用 ID + 服务查询代替直接引用。

### 🔗 相关问题

1. 如何用 `WeakRef` / `FinalizationRegistry` 实现「Observer 被回收后自动从 Subject 列表移除」？它和手动 detach 各有什么坑？
2. 如果一个 Subject 有上万个 Observer（如全服在线玩家监听世界 Boss 血量），如何做批量通知和分帧推送避免单帧卡顿？
3. 响应式编程（RxJS 的 Observable）和经典观察者模式有什么关系？游戏中数据流（如「血量低于 30% 时触发狂暴」）用 RxJS 表达有什么优势？
