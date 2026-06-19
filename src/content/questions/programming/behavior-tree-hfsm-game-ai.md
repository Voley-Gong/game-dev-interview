---
title: "游戏 AI 决策用行为树还是分层状态机（HFSM）？各自怎么实现？"
category: "programming"
level: 3
tags: ["AI", "行为树", "状态机", "决策系统", "游戏架构"]
related: ["programming/state-pattern-game", "programming/data-structures-game", "programming/ecs-architecture-game"]
hint: "状态机记'我现在在哪个状态'，行为树记'我该做什么决策'——简单巡逻用 FSM，Boss 战的多层决策用行为树。"
---

## 参考答案

### ✅ 核心要点

1. **FSM/HFSM 适合\"状态驱动\"的简单 AI**：有限状态机（FSM）用「当前状态 + 转移条件」描述行为，巡逻兵「Idle→Patrol→Chase→Attack」就是经典 FSM。分层状态机（HFSM）允许状态嵌套（如「战斗」父状态内含「攻击/防御/闪避」子状态），解决扁平 FSM 状态数爆炸问题，适合中等复杂度 AI。
2. **行为树（BT）适合\"目标驱动\"的复杂 AI**：行为树用「选择节点（在多个方案里挑一个能成功的）+ 序列节点（按步骤执行）」从根到叶每帧重新评估，天然支持优先级和回退。Boss 战的「有技能放技能→没技能就近身→血少就逃跑」这种带优先级的多层决策，行为树比 HFSM 清晰得多。
3. **核心区别在\"转移逻辑在哪\"**：FSM 的转移写在每个状态内部（Attack 状态里写"血量<20%→Flee"），状态一多转移关系网状纠缠；行为树的转移是「树结构天然蕴含的优先级」，不用手写转移条件，加新行为只是挂个新节点，解耦性更好。
4. **行为树六种核心节点**：Sequence（顺序，全成功才成功）、Selector/Fallback（选择，有一个成功就成功）、Parallel（并行，同时跑多个）、Decorator（装饰器，修饰子节点结果如取反/重复）、Condition（条件判断叶子）、Action（执行动作叶子）。掌握这六种就能拼出任意复杂 AI。
5. **现代方案：Utility AI 与 GOAP**：当 AI 需要"权衡多个目标的重要性"（模拟人生的需求系统）用 Utility AI（效用函数打分选行为）；当需要"规划多步动作达成目标"（如杀出重围）用 GOAP（目标导向行动规划，A* 搜动作序列）。行为树是这些高级方案的基础，理解 BT 才能用好它们。

### 📖 深度展开

**1. 行为树核心结构：Selector + Sequence 组合出优先级决策**

```
Boss 行为树（每帧从根重新评估，左侧优先级高）
  Selector（选择：依次尝试，有一个成功就停）
   ├── Sequence（顺序：血量低就逃跑，全成功才算成功）
   │     ├── Condition: HP < 20%        ✓
   │     └── Action: Flee()             ✓
   ├── Sequence（有技能就放）
   │     ├── Condition: SkillReady
   │     ├── Condition: InRange(5m)
   │     └── Action: CastSkill()
   ├── Sequence（否则近身攻击）
   │     ├── Condition: InRange(2m)
   │     └── Action: MeleeAttack()
   └── Action: MoveToTarget()           ← 兜底行为
```

```typescript
// 行为树节点基类：返回 Success / Failure / Running
type NodeStatus = 'success' | 'failure' | 'running';
abstract class BTNode {
  abstract tick(ctx: AIContext): NodeStatus;
}

// Selector：依次尝试子节点，第一个成功的就返回（带回退/优先级）
class Selector extends BTNode {
  constructor(private children: BTNode[]) { super(); }
  tick(ctx: AIContext): NodeStatus {
    for (const child of this.children) {
      const status = child.tick(ctx);
      if (status !== 'failure') return status;  // success 或 running 都停
    }
    return 'failure';  // 全失败
  }
}

// Sequence：依次执行子节点，全成功才成功（任一失败即中断）
class Sequence extends BTNode {
  constructor(private children: BTNode[]) { super(); }
  tick(ctx: AIContext): NodeStatus {
    for (let i = 0; i < this.children.length; i++) {
      const status = this.children[i].tick(ctx);
      if (status !== 'success') return status;  // failure 或 running 都停
    }
    return 'success';
  }
}

// 条件叶子 & 动作叶子
class Condition extends BTNode {
  constructor(private check: (c: AIContext) => boolean) { super(); }
  tick(ctx: AIContext) { return this.check(ctx) ? 'success' : 'failure'; }
}
class Action extends BTNode {
  constructor(private run: (c: AIContext) => NodeStatus) { super(); }
  tick(ctx: AIContext) { return this.run(ctx); }
}

// 组装 Boss 树——加新行为只是插节点，无需改现有逻辑
const bossTree = new Selector([
  new Sequence([new Condition(c => c.hp < 0.2), new Action(c => flee(c))]),
  new Sequence([new Condition(c => c.skillReady), new Action(c => castSkill(c))]),
  new Sequence([new Condition(c => c.distToPlayer < 2), new Action(c => melee(c))]),
  new Action(c => moveToPlayer(c)),
]);
```

**2. HFSM 分层状态机：解决扁平 FSM 的状态爆炸**

```
扁平 FSM（10 个状态 → 最多 90 条转移线，维护噩梦）
  Idle ⇄ Patrol ⇄ Chase ⇄ Attack ⇄ Stunned ⇄ Flee ⇄ Dead ...

分层 HFSM（嵌套复用，转移线大幅减少）
  Combat（父状态：管理战斗通用逻辑）
   ├── Attack（子状态）  ⇄  Defend（子状态）
   └── Dodge（子状态）
       父级转移：HP<20% → Flee（子状态不用各自写这个转移）
  Patrol（同级父状态）
   ├── Wander └── Investigate
```

```typescript
// HFSM：状态可嵌套子状态机，进入/退出可复用父状态逻辑
abstract class HState {
  parent?: HState;
  machine?: HierarchicalFSM;
  onEnter(): void {}
  onExit(): void {}
  abstract onUpdate(ctx: AIContext): void;
}

class HierarchicalFSM {
  private current: HState | null = null;
  changeState(state: HState): void {
    // 从当前状态向上找到与目标的最近公共祖先，逐层 onExit
    this.current?.onExit();
    this.current = state;
    state.onEnter();
  }
  update(ctx: AIContext): void { this.current?.onUpdate(ctx); }
}

// Combat 父状态：所有战斗子状态共享"血量低就逃跑"的检查
class CombatState extends HState {
  private subMachine = new HierarchicalFSM();
  onUpdate(ctx: AIContext) {
    if (ctx.hp < 0.2) { this.machine!.changeState(new FleeState()); return; }
    this.subMachine.update(ctx);  // 否则交给子状态机
  }
}
```

**3. 行为树 vs HFSM vs Utility AI 选型对比**

| 维度 | 扁平 FSM | 分层状态机 HFSM | 行为树 BT | 效用 AI Utility |
|------|---------|----------------|----------|----------------|
| 决策方式 | 当前状态+转移条件 | 嵌套状态+转移 | 每帧从根重评估树 | 给所有行为打分取最高 |
| 复杂度上限 | 低（状态一多就乱） | 中（适合中等 AI） | 高（适合 Boss/复杂 AI） | 高（适合模拟类多目标） |
| 加新行为 | 改一堆转移线 | 加子状态+少量转移 | 挂个新节点即可 | 加个评分函数即可 |
| 可读性 | 状态少时直观 | 嵌套深时难追踪 | 树结构清晰、可可视化 | 评分权重需反复调试 |
| 状态记忆 | 强（显式记当前态） | 强 | 弱（每帧重新决策） | 弱 |
| 典型场景 | 小怪巡逻 | 中等敌人 | Boss 战 | 模拟人生/RTS |
| 代表游戏 | 早期 RPG | 多数动作游戏 | 光环/Halo、求生之路 | 模拟人生、全面战争 |

### ⚡ 实战经验

- **别用行为树做\"简单巡逻兵\"**：一个只有「巡逻→发现玩家→追击」的杂兵，用 20 行 FSM 就够了，硬上行为树反而增加理解成本和每帧遍历开销。行为树是给"复杂决策"准备的，简单 AI 上 FSM，复杂 Boss 上 BT，混合使用最务实。
- **行为树每帧从根 tick 是性能隐患**：一棵 50 节点的树每帧全量重评估，1000 个敌人就是 5 万次节点遍历。优化手段：① 条件节点缓存结果、带脏标记只在状态变化时重算；② 对低优先级 AI 降频 tick（杂兵每 5 帧 tick 一次，玩家附近的才每帧）；③ 用"事件驱动"打断——只有感知变化时才重新走树。
- **行为树的 Running 状态容易被忽视导致 Bug**：`CastSkill` 返回 Running 期间，Sequence 会停在这个节点，下帧继续。如果不处理"技能被打断"的退出条件，角色被打晕后技能还在偷偷播。每个 Action 叶子务必明确「何时 success / 何时 failure / 何时 running」，特别是被打断的 failure 路径。
- **Utility AI 的评分函数会\"突变\"**：模拟人生式需求系统里，如果饥饿分从 0 直接跳到 100，AI 会瞬间从"睡觉"切换到"找食物"，行为抖动严重。必须用平滑插值（`score = lerp(score, target, dt*rate)`）和迟滞区间（超过 70 才切换、低于 50 才切回）避免行为频繁抖动，否则 AI 看起来像精神分裂。
- **行为树一定要支持可视化编辑**：纯代码拼行为树后期维护是灾难——策划想加个"血量低于30%狂暴"的需求，要程序员改树结构、发版。接入可视化编辑器（节点拖拽+属性面板）后策划自助配置，研发只维护节点库。光环系列的 AI 就是靠可视化行为树编辑器让策划迭代 AI 的。

### 🔗 相关问题

1. 行为树的「黑板（Blackboard）」是什么？为什么节点之间不该直接共享局部变量，而要通过黑板传递感知数据（敌人位置、血量）？
2. 当 AI 需要"记忆"（如记住玩家上次出现的位置、对玩家产生仇恨）时，行为树这种无状态结构如何持久化记忆？记忆该存在哪？
3. GOAP（目标导向行动规划）和行为树的区别是什么？为什么杀出重围、辐射系列用 GOAP 而光环用行为树？GOAP 的"动作代价"是怎么计算的？
