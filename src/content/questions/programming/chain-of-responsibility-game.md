---
title: "责任链模式在游戏中如何应用？如何设计一个伤害计算链和 UI 事件传递链？"
category: "programming"
level: 2
tags: ["设计模式", "责任链模式", "行为型模式", "事件系统"]
related: ["programming/event-bus-architecture", "programming/decorator-buff-system", "programming/observer-pattern"]
hint: "不是 if-else 堆叠——请求沿链传递，每个节点决定处理或转发，发送者和接收者彻底解耦。"
---

## 参考答案

### ✅ 核心要点

1. **核心是"链式传递 + 解耦"**：责任链模式（Chain of Responsibility, CoR）让多个处理器（Handler）串成一条链，请求沿链传递，每个处理器决定自己处理、处理后转发、或直接拒绝。发送者不需要知道是谁最终处理——这正是它取代巨型 `if/else if` 分支的根本价值，新增处理逻辑只需插入新节点而非修改既有代码（开闭原则）。
2. **纯链 vs 不纯链**：**纯责任链**（Pure CoR）只有一个处理器最终处理，处理完即停止（如事件冒泡，只有最内层节点响应）；**不纯责任链**（Impure CoR）多个节点都可处理并修改请求，依次传递（如伤害计算链：护盾减伤 → Buff 加成 → 装甲减免 → 最终伤害）。游戏中 90% 场景是不纯链，因为它能组合多个处理器的效果。
3. **变体：处理 + 转发 vs 拦截**：每个节点可以选三种行为——**Transform**（修改请求后传给下游，如伤害链中护盾把 100 伤害改成 70 后传递）、**Terminate**（终止链，如聊天过滤器检测到违禁词直接 return 不发送）、**Pass-through**（不处理直接转发，如某个 Buff 不生效时跳过）。这种灵活性让责任链既能做"流水线加工"也能做"过滤器"。
4. **典型游戏场景**：①**伤害计算链**（护盾→Buff→装甲→血量扣减，每层都可修改伤害值）；②**UI 事件冒泡**（Button → Panel → Dialog → Root，类似 DOM 事件）；③**输入处理管线**（UI 拦截 → 战斗系统 → 镜头控制 → 世界交互，谁先拦截谁消费）；④**聊天/UGC 内容过滤**（本地敏感词 → 链接检测 → 服务端复审，逐层过滤）；⑤**技能效果链**（释放技能 → 检查沉默 → 检查蓝量 → 计算伤害 → 触发被动）。
5. **与装饰器、管道、观察者的边界**：装饰器是"包裹同一接口、增强行为"（同一节点既处理又传给被包裹者）；责任链是"独立节点、顺序处理同一请求"（节点之间是平等串联）。管道（Pipeline）模式本质是不纯责任链的流式 API 形态（`pipe.use(a).use(b).use(c)`）。观察者是"一对多广播"，责任链是"一对一传递"——后者请求只走一条路径。

### 📖 深度展开

**1. 伤害计算链：经典的不纯责任链**

```typescript
// 伤害上下文：沿链传递的可变状态
interface DamageContext {
  attacker: EntityId;
  target: EntityId;
  rawDamage: number;       // 原始伤害（攻击方面板）
  finalDamage: number;     // 最终伤害（沿途被各层修改）
  damageType: 'physical' | 'magic' | 'true';
  cancelled: boolean;      // 某层可置 true 终止链（如无敌）
  modifiers: string[];     // 调试用：记录经过哪些处理器
}

// 抽象处理器：定义"处理-转发"骨架
abstract class DamageHandler {
  protected next?: DamageHandler;
  setNext(h: DamageHandler): DamageHandler { this.next = h; return h; }
  handle(ctx: DamageContext): void {
    if (ctx.cancelled) return;          // 上游已取消，短路
    this.process(ctx);                  // 本节点处理
    if (ctx.cancelled) return;          // 本节点取消，短路
    this.next?.handle(ctx);             // 转发下游
  }
  protected abstract process(ctx: DamageContext): void;
}

// 具体节点：护盾先吸收
class ShieldHandler extends DamageHandler {
  constructor(private shieldComp: ShieldComponent) { super(); }
  protected process(ctx: DamageContext) {
    const absorbed = Math.min(ctx.finalDamage, this.shieldComp.amount);
    this.shieldComp.amount -= absorbed;
    ctx.finalDamage -= absorbed;
    ctx.modifiers.push(`Shield-${absorbed}`);
    if (this.shieldComp.amount <= 0) ctx.modifiers.push('Shield-Break');
  }
}

// 具体节点：Buff 增伤/减伤
class BuffHandler extends DamageHandler {
  constructor(private buffComp: BuffComponent) { super(); }
  protected process(ctx: DamageContext) {
    const amplify = this.buffComp.getDamageAmplify(ctx.attacker, ctx.damageType);
    ctx.finalDamage = Math.floor(ctx.finalDamage * (1 + amplify));
    ctx.modifiers.push(`Buff×${(1 + amplify).toFixed(2)}`);
  }
}

// 具体节点：无敌直接终止
class InvincibleHandler extends DamageHandler {
  constructor(private targetComp: StatusComponent) { super(); }
  protected process(ctx: DamageContext) {
    if (this.targetComp.hasStatus('invincible')) {
      ctx.cancelled = true;             // 🛑 终止链
      ctx.modifiers.push('Invincible-Cancel');
    }
  }
}

// 具体终点：实际扣血
class HealthHandler extends DamageHandler {
  constructor(private healthComp: HealthComponent) { super(); }
  protected process(ctx: DamageContext) {
    this.healthComp.current -= ctx.finalDamage;
    ctx.modifiers.push(`HP-${ctx.finalDamage}`);
  }
}

// 组装链：顺序决定计算结果
function buildDamageChain(target: Entity): DamageHandler {
  const invincible = new InvincibleHandler(target.status);
  const shield = new ShieldHandler(target.shield);
  const buff = new BuffHandler(target.buff);
  const armor = new ArmorHandler(target.armor);  // 类似 Shield
  const health = new HealthHandler(target.health);
  // 链顺序：无敌 → 护盾 → Buff → 装甲 → 扣血
  invincible.setNext(shield); shield.setNext(buff);
  buff.setNext(armor);       armor.setNext(health);
  return invincible;
}
// 调用：ctx.finalDamage 沿链被层层修改
const ctx: DamageContext = { attacker, target, rawDamage: 100, finalDamage: 100,
  damageType: 'physical', cancelled: false, modifiers: [] };
buildDamageChain(target).handle(ctx);
// 输出 ctx.modifiers: ['Shield-30', 'Buff×1.5', 'Armor-10', 'HP-90']
```

**2. UI 事件冒泡链：纯责任链（拦截即停止）**

```
玩家点击屏幕坐标 (200, 300)，UI 事件从最内层向外冒泡：

点击坐标 (200, 300)
       ↓ 命中检测
┌──────────────────────────────────────────────────┐
│  Root Layer (全屏)                                │
│  ┌────────────────────────────────────────────┐  │
│  │  Dialog "购买确认"                          │  │  ← 命中：Dialog 拦截事件
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  Panel "商品信息"                      │  │  │
│  │  │  ┌────────────────────────────────┐  │  │  │
│  │  │  │  Button "购买"  ← 命中实际目标   │  │  │  │
│  │  │  └────────────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘

事件链（从内向外）：
  Button.onClick → 处理？✅ 触发购买弹窗确认 → stopPropagation? 决定是否继续
       ↓ (若不 stop)
  Panel.onClick  → 处理？❌ 无逻辑 → 转发
       ↓
  Dialog.onClick → 处理？✅ 关闭弹窗（点空白处自动关闭）→ stopPropagation
       ↓ (若不 stop)
  Root.onClick   → 处理？✅ 取消选中/隐藏菜单
```

```typescript
// UI 事件链：冒泡 + stopPropagation
interface UIClickEvent {
  targetId: string;
  x: number; y: number;
  bubbles: boolean;        // false = stopPropagation 被调用
  defaultPrevented: boolean;
}

abstract class UINode {
  protected parent?: UINode;
  children: UINode[] = [];

  // 捕获阶段（顶层→底层）+ 冒泡阶段（底层→顶层），DOM 标准双阶段
  dispatchClick(event: UIClickEvent): void {
    // 冒泡：从当前节点向上
    let node: UINode | undefined = this;
    while (node && event.bubbles) {
      node.onClick(event);
      node = node.parent;
    }
  }

  protected onClick(event: UIClickEvent): void {
    // 子类覆盖；默认不处理，继续冒泡
  }

  stopPropagation(event: UIClickEvent) { event.bubbles = false; }
}

// 具体节点：Button 消费点击
class Button extends UINode {
  constructor(public id: string, private onTap: () => void) { super(); }
  protected onClick(event: UIClickEvent): void {
    if (event.targetId === this.id) {
      this.onTap();                  // 触发购买
      this.stopPropagation(event);   // 阻止冒泡，避免触发 Dialog 的"点空白关闭"
    }
  }
}
```

**3. 责任链 vs 装饰器 vs 观察者 vs 管道：四种"传递"模式对比**

| 维度 | 责任链 CoR | 装饰器 Decorator | 观察者 Observer | 管道 Pipeline |
|------|-----------|-----------------|----------------|--------------|
| **数据流向** | 单向串行（A→B→C） | 包裹式嵌套（最外层调最内层） | 一对多广播（扇出） | 单向流式（req→resp） |
| **节点关系** | 平等串联 | 嵌套包裹（洋葱模型） | 发布-订阅 | 中间件栈 |
| **处理者数量** | 0~N 个（可全跳过） | 全部都执行 | 全部都通知 | 全部都执行 |
| **可终止** | ✅ 任意节点可短路 | ❌ 必须穿透到核心 | ❌ 无法终止广播 | ✅ 不调 next() 即终止 |
| **请求可变** | ✅ 沿途修改 | ✅ 增强/包装 | ❌ 通常只读 | ✅ 修改 req/resp |
| **游戏场景** | 伤害链、UI 冒泡、输入管线 | Buff 叠加、日志增强 | 事件总线、成就触发 | Express/Koa 中间件、技能释放管线 |
| **代码组织** | `handler.setNext(b).setNext(c)` | `new Dec(new Core())` | `emitter.on(event, cb)` | `app.use(mw1).use(mw2)` |

```typescript
// 管道式 API：责任链的流式封装，技能释放管线
class SkillPipeline {
  private handlers: Array<(ctx: SkillContext, next: () => void) => void> = [];

  use(h: (ctx: SkillContext, next: () => void) => void): this {
    this.handlers.push(h);
    return this;
  }

  async execute(ctx: SkillContext): Promise<void> {
    let idx = -1;
    const dispatch = async (i: number) => {
      if (i <= idx) throw new Error('next() called multiple times');
      idx = i;
      const handler = this.handlers[i];
      if (!handler) return;            // 链结束
      await handler(ctx, () => dispatch(i + 1));  // 调 next() 触发下游
    };
    await dispatch(0);
  }
}

// 使用：组装技能释放管线（Koa 风格中间件）
const skillPipe = new SkillPipeline()
  .use((ctx, next) => {                         // 1. 检查沉默
    if (ctx.caster.hasStatus('silenced')) { ctx.cancelled = true; return; }
    next();
  })
  .use((ctx, next) => {                         // 2. 扣蓝
    if (ctx.caster.mana < ctx.skill.cost) { ctx.cancelled = true; return; }
    ctx.caster.mana -= ctx.skill.cost; next();
  })
  .use((ctx, next) => {                         // 3. 计算伤害（委托给伤害链）
    if (ctx.skill.dealsDamage) {
      buildDamageChain(ctx.target).handle(ctx.damageCtx);
    }
    next();
  })
  .use((ctx, next) => {                         // 4. 触发被动
    ctx.caster.triggerPassive('onCast', ctx); next();
  });
// 任意节点不调 next() 即终止——比 setNext 链式更易组合、易测试
```

### ⚡ 实战经验

- **链顺序敏感，要写测试**：伤害链中"护盾在前 vs Buff 在前"结果差异巨大——护盾先扣（护盾按 100 算吸收 30，剩 70 再 ×1.5 = 105）vs Buff 先算（100×1.5=150，护盾吸收 30 剩 120）。一次线上 BUG 是策划调整 Buff 顺序导致 BOSS 伤害突然翻倍团灭玩家。固定顺序 + 黄金路径单测（输入 100 伤害、断言每层 modifier 数值），每次改动 PR 必须更新单测。
- **链节点不要持有强状态**：早期把当前请求缓存到 Handler 实例字段（`this.currentCtx = ctx`），结果同帧多次伤害调用互相覆盖，玩家 A 的伤害用了玩家 B 的护盾值。Handler 必须无状态，所有上下文通过参数传递；需要状态的（如护盾当前值）从 Entity 组件查，绝不缓存在 Handler。
- **链过长影响性能**：一个伤害链曾堆叠到 18 个节点（多层 Buff、装备、天赋、宠物、神器...），每次伤害计算 0.4ms，60 帧战斗中 100 次伤害 = 40ms，占帧预算 67%。优化：①把不常变化的节点合并（多个 Buff 计算合并成一次循环）；②对"必定执行"的节点直接 inline；③只有条件性节点保留链形态。最终降到 7 节点，0.08ms/次。
- **UI 事件冒泡的 stopPropagation 时机**：列表项点击默认会冒泡到父容器，曾出现点击列表项按钮触发了"列表选中"逻辑（父容器监听 click），表现为购买按钮按下同时选中该项闪烁。修复：Button 处理后立即 `stopPropagation`。但要小心——某些场景需要冒泡（如长按手势检测在父层），不要无脑全 stop。
- **链节点要支持热插拔**：Buff/装备系统动态变化（玩家装备/卸下、Buff 增删），如果链是启动时一次性 build 的，运行时无法调整。改为每次伤害计算都根据目标当前状态动态 build 链（成本低，节点对象轻量），或维护"必选节点 + 动态节点列表"按需拼装。前者实现简单（~50ns build 成本可接受），后者性能更优但复杂度高。

### 🔗 相关问题

1. 责任链和事件总线都解决"解耦发送者与接收者"，二者何时选谁？如果一个伤害事件既要经过伤害计算链（顺序敏感）又要触发成就/任务（顺序无关），应该如何组合两种模式？
2. 在 ECS 架构中，责任链的"Handler 节点"应该实现为 System、Component 还是单独的服务？组件化的 Buff 系统如何与责任链协同？
3. 责任链在分布式/网络场景中如何应用？例如游戏服务器的请求处理管线（鉴权 → 限流 → 协议解析 → 业务逻辑 → 日志），它与客户端责任链有何工程差异？
