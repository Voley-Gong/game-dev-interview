---
title: "中介者模式怎么解耦游戏里的 UI 面板和战斗模块？"
category: "programming"
level: 2
tags: ["设计模式", "中介者模式", "UI架构", "模块解耦", "事件通信"]
related: ["programming/event-bus-architecture", "programming/observer-pattern", "programming/chain-of-responsibility-game"]
hint: "不是事件总线——中介者是'知道所有同事'的中心控制器，主动协调它们的交互逻辑，而非被动转发消息。"
---

## 参考答案

### ✅ 核心要点

1. **把网状依赖收拢成星型**：游戏里「背包面板」「装备面板」「属性面板」「金币显示」互相联动——装备物品要刷新属性、卖东西要更新金币、穿装备要更新背包。如果四个面板互相直接引用，就是 4×3=12 条依赖线（N 个模块是 N² 级耦合）。中介者模式引入一个 `UIMediator`，所有面板只和中介者通信，依赖线降到 N 条，新增面板不影响已有面板。
2. **中介者封装交互逻辑，同事互不感知**：每个面板（Colleague）只知道中介者接口，不知道其他面板的存在。背包面板卖出物品时调用 `mediator.onItemSold(item)`，至于这个事件触发了「金币 +100」「属性重算」「任务进度更新」——全是中介者内部决定。背包面板不关心、也不该关心这些副作用，职责单一。
3. **vs 事件总线：主动协调 vs 被动转发**：事件总线是「发布-订阅」的 dumb pipe，只负责把事件从 A 送到 B/C/D，不包含业务逻辑；中介者是「智能协调者」，知道哪些同事该响应什么、以什么顺序响应。事件总线适合「完全解耦的广播」（如全局成就系统），中介者适合「一组紧密协作的模块」（如战斗 HUD 的各面板）。
4. **集中控制降低了变更的连锁反应**：没有中介者时，给「装备面板」加一个新联动（穿上装备后触发成就检测），要改装备面板引用成就系统，而装备面板已经引用了背包、属性、金币……依赖像滚雪球。有中介者后，只在中介者的 `onEquip` 方法里加一行 `achievementSystem.check(...)`，装备面板本身零改动。
5. **警惕中介者退化为「上帝对象」**：中介者集中了所有交互逻辑，很容易膨胀成几千行的巨型类，反而成了新的维护灾难。实践中要把中介者按领域拆分——`BattleMediator`（战斗 HUD 协调）、`InventoryMediator`（背包相关）、`SocialMediator`（社交面板），每个只协调一组紧密相关的面板，跨领域再用事件总线松耦合。
6. **配合命令模式实现 UI 操作撤销**：中介者协调的交互往往是有序操作链（点击装备 → 检查条件 → 扣除金币 → 穿上 → 刷新属性），把每步封装成 Command 对象塞进中介者，操作链天然支持撤销/重做。这在「装备试穿预览」「属性分配撤回」等场景很有用，纯事件总线很难做到有序回滚。

### 📖 深度展开

**1. UI 面板中介者：星型协调装备流程**

```typescript
// 中介者接口：定义所有同事能上报的事件
interface UIMediator {
  onItemEquipped(item: Item, slot: EquipSlot): void;
  onItemUnequipped(slot: EquipSlot): void;
  onItemSold(item: Item, price: number): void;
  onAttributeChanged(attr: AttributeType, delta: number): void;
}

// 同事基类：持有中介者引用，不持有其他面板
abstract class UIPanel {
  constructor(protected mediator: UIMediator) {}
  abstract show(): void;
  abstract hide(): void;
}

// 背包面板：只负责展示物品、处理点击，不关心点了之后发生什么
class InventoryPanel extends UIPanel {
  onEquipClicked(item: Item, slot: EquipSlot) {
    // 只上报「想装备」，后续逻辑全交给中介者
    this.mediator.onItemEquipped(item, slot);
  }
  refresh() { /* 重新渲染物品列表 */ }
}

// 装备面板：不知道背包、属性面板的存在
class EquipmentPanel extends UIPanel {
  equip(item: Item, slot: EquipSlot) { /* 更新装备槽显示 */ }
  unequip(slot: EquipSlot) { /* 清空装备槽 */ }
}

// 属性面板：只听「属性变化」事件
class AttributePanel extends UIPanel {
  applyDelta(attr: AttributeType, delta: number) { /* 更新数值显示 */ }
}

// 具体中介者：集中编排所有面板的交互逻辑
class GameUIMediator implements UIMediator {
  constructor(
    private inventory: InventoryPanel,
    private equipment: EquipmentPanel,
    private attribute: AttributePanel,
    private player: Player,
  ) {}

  // 装备一件物品的完整编排：验证→扣除→穿戴→刷新（顺序由中介者保证）
  onItemEquipped(item: Item, slot: EquipSlot): void {
    // 1. 校验等级/职业限制
    if (!this.player.canEquip(item)) {
      this.showToast('等级不足或职业不符');
      return;
    }
    // 2. 如果该槽位已有装备，先卸下
    const oldItem = this.player.getEquipped(slot);
    if (oldItem) this.player.unequip(slot);
    // 3. 穿上新装备，更新各面板
    this.player.equip(item, slot);
    this.equipment.equip(item, slot);
    this.inventory.refresh();
    // 4. 属性差值结算，驱动属性面板更新
    const attrDelta = this.player.recalcAttributes();
    for (const [attr, delta] of Object.entries(attrDelta)) {
      this.attribute.applyDelta(attr as AttributeType, delta);
    }
    // 5. 如果卸下了旧装备，要把它加回背包
    if (oldItem) this.player.addToInventory(oldItem);
  }

  onItemSold(item: Item, price: number): void {
    this.player.gold += price;
    this.player.removeFromInventory(item);
    this.inventory.refresh();
    this.updateGoldDisplay();
  }
  // ... 其他交互编排
  private showToast(msg: string) { /* ... */ }
  private updateGoldDisplay() { /* ... */ }
}
```

**2. 星型 vs 网状：耦合度可视化**

```
【无中介者】4 个面板互相引用（网状耦合，N² 级依赖）：

  Inventory ─────► Equipment
      ▲ ╲           ▲
      │  ╲          │
      │   ╲         │
      │    ▼        │
  Attribute ◄──── Gold

  依赖线：4×3 = 12 条。新增第 5 个面板 → 再加 4 条 = 16 条
  改 Inventory 的接口，Equipment/Attribute/Gold 全受影响

【有中介者】所有面板只依赖中介者（星型，N 级依赖）：

            UIMediator
           ╱    │    ╲
         ╱      │      ╲
  Inventory  Equipment  Attribute
         ╲      │      ╱
           ╲    │    ╱
             Gold

  依赖线：4 条。新增第 5 个面板 → 只加 1 条 = 5 条
  改 Inventory 接口，只有 UIMediator 受影响，其他面板无感
```

| 维度 | 直接引用（网状） | 中介者模式（星型） | 事件总线（广播） |
|------|----------------|------------------|----------------|
| **依赖线数** | O(N²) | O(N) | O(N)（只依赖总线） |
| **面板间感知** | ✅ 强耦合，互相持有引用 | ❌ 只认识中介者 | ❌ 完全不感知 |
| **交互逻辑位置** | 散落在各面板 | 集中在中介者 | 散落在各订阅者 |
| **执行顺序可控** | ❌ 难（各自触发） | ✅ 中介者显式编排 | ❌ 订阅顺序不确定 |
| **调试链路** | 难（跳来跳去） | 易（看中介者方法） | 难（事件溯源） |
| **新增面板成本** | 改所有相关面板 | 只改中介者 | 加个订阅即可 |
| **适用场景** | ❌ 避免 | 紧密协作的模块组 | 完全松耦合的广播 |

**3. 中介者分层：避免上帝对象 + 与事件总线协作**

```
大型项目的中介者分层架构（实战推荐）：

  ┌─────────────────────────────────────────────┐
  │           EventBus（全局松耦合广播）          │
  │   战斗开始 / 玩家升级 / 成就解锁 / 聊天消息    │
  └──────▲──────────────▲──────────────▲────────┘
         │              │              │
  ┌──────┴────┐  ┌──────┴────┐  ┌─────┴─────┐
  │ Battle    │  │ Inventory │  │  Social   │
  │ Mediator  │  │ Mediator  │  │ Mediator  │
  │ (战斗HUD) │  │ (背包装备) │  │ (社交面板) │
  └──┬──┬──┬──┘  └──┬──┬──┬──┘  └──┬──┬─────┘
     │  │  │        │  │  │        │  │
   HP 技能 BUFF   背包 装备 属性   好友 公会

  原则：
  - 同领域紧密协作 → 用 Mediator（有序、强类型、易调试）
  - 跨领域松耦合   → 用 EventBus（广播、解耦、可插拔）
  - 一个 Mediator 只管 3-6 个面板，超过就拆分
```

```typescript
// 分层中介者：BattleMediator 只协调战斗 HUD，不碰背包逻辑
class BattleMediator implements UIMediator {
  constructor(
    private hpBar: HpBarPanel,
    private skillBar: SkillBarPanel,
    private buffBar: BuffBarPanel,
    private eventBus: EventBus,  // 跨领域通信走事件总线
  ) {}

  onDamaged(amount: number, source: DamageType) {
    this.hpBar.update(-amount);
    // 战斗内联动：受击时刷新技能可用性
    this.skillBar.refreshCooldowns();
    // 跨领域：通知成就系统（通过事件总线，不直接引用）
    if (amount > 1000) {
      this.eventBus.emit('big_damage_dealt', { amount, source });
    }
  }

  onBuffApplied(buff: Buff) {
    this.buffBar.add(buff);
    this.hpBar.showBuffOutline(buff);  // 同领域联动，中介者编排
  }
}
```

### ⚡ 实战经验

- **中介者别跨领域**：早期把所有 UI 交互塞进一个 `GameUIMediator`，半年后涨到 2800 行，涵盖战斗、背包、社交、商城、设置——改一个商城的交互逻辑，战斗 HUD 的方法也在同一个文件里被误改，引发线上 Bug。按领域拆成 5 个中介者后，每个 200-400 行，冲突率降 90%，Code Review 也更聚焦。
- **中介者方法要做事务性校验**：`onItemEquipped` 里先扣金币再穿装备，如果穿装备那步抛异常，金币扣了但装备没穿上，玩家损失。把整个编排包在 `try-catch` + 状态快照里，失败时回滚（金币加回、装备移除），或者用 Command 模式让每步可撤销。曾因没做事务校验，一个空指针异常导致 3% 玩家装备丢失，客服手动补偿了一周。
- **面板引用中介者要用接口而非具体类**：背包面板构造函数写成 `constructor(mediator: GameUIMediator)`，结果单元测试要 mock 整个 2000 行的中介者。改成 `constructor(mediator: UIMediator)`（接口）后，测试时传一个假的 `MockMediator` 只实现需要的方法，测试代码量减半。依赖接口而非实现，是中介者模式可测试性的关键。
- **中介者内部逻辑别超过 50 行**：`onItemEquipped` 一度写到 180 行（校验、扣费、穿戴、属性、特效、音效、日志全堆一起），后来拆成 `validateEquip()` / `doEquip()` / `refreshPanels()` / `playFeedback()` 四个私有方法，主方法只剩编排顺序。单个方法超过 50 行基本意味着职责没拆干净，中介者应该是「协调者」而非「实现者」。
- **性能敏感场景慎用中介者中心转发**：战斗中每帧的受击伤害原本直连 `hpBar.update()`，后来统一走 `BattleMediator.onDamaged()`，多了层函数调用 + 条件判断，100 个怪物同时受击时多了 0.8ms。高频热路径（每帧执行）可以保留直接引用，低频交互（点击、装备、升级）才走中介者——别为了模式纯洁性牺牲帧率。

### 🔗 相关问题

1. 中介者模式和 MVC/MVVM 架构里的 Controller/ViewModel 是什么关系？ViewModel 本身就是一种中介者吗？
2. 当中介者需要协调的模块分布在不同进程（如客户端 UI + 服务端战斗逻辑）时，如何把中介者模式扩展到分布式场景？
3. 中介者模式和 Flux/Redux 的单一 Store 有什么异同？Redux 的 reducer 是不是一种「函数式的中介者」？
