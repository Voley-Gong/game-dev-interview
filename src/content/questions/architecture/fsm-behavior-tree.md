---
title: "有限状态机（FSM）和行为树怎么选？如何实现？"
category: "architecture"
level: 3
tags: ["状态机", "行为树", "AI架构", "架构设计"]
related: ["architecture/skill-system", "architecture/ecs-architecture"]
hint: "FSM 适合状态明确、切换简单的逻辑；行为树适合复杂 AI 决策。两者还能混用。"
---

## 参考答案

### ✅ 核心要点

1. **FSM 三要素**：状态（State）、转移条件（Transition）、事件驱动切换
2. **分层 FSM（HFSM）**：状态可嵌套父子关系，解决状态爆炸问题
3. **行为树节点类型**：选择节点（Selector）、顺序节点（Sequence）、装饰器、动作/条件节点
4. **决策模型差异**：FSM 是"状态+转移"的图；行为树是"自顶向下"每帧重估的树
5. **可数据驱动**：状态机和行为树都应支持配置化（JSON/可视化编辑器），而非硬编码

### 📖 深度展开

**FSM 基础实现：**

```typescript
// 状态接口
interface IState {
  onEnter(prev: string | null): void;
  onUpdate(dt: number): void;
  onExit(next: string): void;
}

// 通用状态机
class FSM {
  private current: IState | null = null;
  private currentName: string | null = null;
  private states = new Map<string, IState>();
  private transitions: Record<string, Record<string, string>> = {};

  addState(name: string, state: IState) { this.states.set(name, state); }
  // fromState --(event)--> toState
  addTransition(from: string, event: string, to: string) {
    (this.transitions[from] ||= {})[event] = to;
  }

  fire(event: string) {
    const next = this.transitions[this.currentName!]?.[event];
    if (next) this.changeTo(next);
  }

  changeTo(name: string) {
    this.current?.onExit(name);
    const prev = this.currentName;
    this.currentName = name;
    this.current = this.states.get(name)!;
    this.current.onEnter(prev);
  }

  update(dt: number) { this.current?.onUpdate(dt); }
}

// 注册：Idle --(seeEnemy)--> Chase --(inRange)--> Attack
fsm.addTransition('Idle', 'seeEnemy', 'Chase');
fsm.addTransition('Chase', 'inRange', 'Attack');
fsm.addTransition('Attack', 'lostEnemy', 'Idle');
```

**分层状态机（HFSM）解决状态爆炸：**

```
普通 FSM：每个状态两两连线 → N 个状态最多 N² 条转移，难维护

HFSM（父子嵌套）：
  Combat（父：战斗中）
    ├── MeleeAttack（子：近战）
    ├── RangedAttack（子：远程）
    └── Dodge（子：闪避）
  Patrol（父：巡逻中）
    ├── Wander
    └── Guard

子状态只处理自己关心的事，通用逻辑（如"血量低就逃"）放父状态
父状态 onEnter/onExit 包裹整组子状态，减少重复连线
```

**行为树结构：**

```
        Selector（选择：有一个成功就返回，逐个尝试）
       /        |        \
   Condition  Sequence  Attack
  (敌在视野?)  /     \
           Condition  Move
          (血量>30%)  (靠近敌人)

执行顺序（每帧从根开始遍历）：
  1. Selector 试第 1 个孩子：Condition(敌在视野?) → 失败 → 试下一个
  2. 试第 2 个孩子 Sequence：先 Condition(血量>30%)
     - 若血量低 → Sequence 失败 → 试第 3 个孩子 Attack(盲打)
     - 若血量够 → 继续 Move → 成功
  3. 行为树每帧重新评估，天然适应动态变化
```

**节点类型速查：**

| 节点 | 行为 | 成功/失败语义 |
|------|------|----------------|
| Sequence（顺序） | 依次执行子节点 | 全成功才成功，遇失败即停 |
| Selector（选择） | 依次尝试子节点 | 有一个成功即成功，全失败才失败 |
| Parallel（并行） | 同时执行多个 | 按策略（AND/OR）汇总结果 |
| Decorator（装饰器） | 包装单个子节点 | 如 Repeater（重复）、Inverter（取反） |
| Condition | 条件判断叶子 | 返回 true/false |
| Action | 执行动作叶子 | 执行后返回成功/失败/运行中 |

**FSM vs 行为树对比：**

| 维度 | FSM | 行为树 |
|------|-----|--------|
| 结构 | 显式状态图 | 树形优先级 |
| 决策时机 | 事件触发转移 | 每帧重估 |
| 状态复用 | 状态爆炸风险 | 节点可复用组合 |
| 可读性 | 状态少时清晰 | 复杂 AI 更清晰 |
| 调试 | 转移链路难追 | 节点路径可视化 |
| 适用 | 角色控制、UI 流程 | 复杂怪物/Boss AI |

### ⚡ 实战经验

- **角色控制用 FSM，怪物 AI 用行为树**：玩家操作状态明确（走/跑/跳/攻击）适合 FSM；Boss 决策复杂适合行为树
- **警惕行为树的性能**：每帧从根重估，节点多时会反复执行 Condition；用"黑板（Blackboard）"缓存感知结果，避免重复计算
- **数据驱动配置**：状态转移表和行为树结构都用 JSON/可视化编辑器配置，策划可调，程序不参与每次改 AI
- **混用才是常态**：行为树的 Action 节点内部可以是一个 FSM（如"攻击"动作内含前摇/命中/后摇状态）

### 🔗 相关问题

- 目标导向行动规划（GOAP）和行为树有什么区别？
- 如何在网游中同步 AI 状态机？
- 技能系统中的前摇/后摇时序如何用状态机管理？
