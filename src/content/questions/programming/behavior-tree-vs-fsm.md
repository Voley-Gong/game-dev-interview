---
title: "行为树 vs 有限状态机：游戏 AI 决策架构怎么选？"
category: "programming"
level: 3
tags: ["AI架构", "行为树", "状态机", "决策系统", "游戏AI"]
related: ["programming/data-structures-game", "programming/design-patterns-game"]
hint: "FSM 简单直观但状态爆炸，行为树可组合但调试成本高——选型背后是 AI 复杂度的分级治理。"
---

## 参考答案

### ✅ 核心要点

1. **FSM 本质是状态+跳转图**：每个状态封装行为，转换条件决定何时切到下一个状态。简单 AI（巡逻→追击→攻击）用 FSM 一张图就讲清楚了，但当状态超过 8-10 个，转换线呈 N² 增长，变成没人敢动的"毛线团"。
2. **行为树是树形优先级遍历**：从 Root 向下，Selector（选择节点）找第一个成功的子节点执行，Sequence（顺序节点）要求所有子节点都成功。AI 行为被拆成可复用的小节点，通过组合而非连线来表达复杂逻辑。
3. **FSM 有"状态记忆"，行为树是"无状态轮询"**：FSM 停在某个状态等条件触发；行为树每帧从根重新遍历，天然响应环境变化——敌人消失就立刻不再追击，不需要写"退出追击状态"的逻辑。
4. **HFSM（层次状态机）是折中方案**：把状态分组嵌套（"战斗"组含"攻击/闪避/追击"），组内共享转换逻辑，缓解状态爆炸但保留状态机的执行模型。
5. **选型看 AI 复杂度而非"哪个更先进"**：NPC 商店老板用 FSM 足矣，BOSS 战多阶段切换用 HFSM，RTS 单位/开放世界敌人用行为树。工具匹配问题规模，不是反过来。
6. **行为树的杀手锏是数据驱动**：节点可序列化成 JSON，策划在可视化编辑器里拖拽配 AI，程序员只维护节点库——这是大厂 AI 系统标配，FSM 做不到这么自然。

### 📖 深度展开

**1. 行为树核心结构与遍历**

```
Root
 └─ Selector (OR：找一个能跑的)
     ├─ Sequence (AND：必须全成功)
     │   ├─ Condition: HasLowHealth?
     │   ├─ Action: FindHealPoint
     │   └─ Action: MoveToHealPoint
     ├─ Sequence
     │   ├─ Condition: EnemyInRange?
     │   ├─ Selector
     │   │   ├─ Action: CastSkill (优先放技能)
     │   │   └─ Action: MeleeAttack (兜底平A)
     └─ Action: Patrol (以上都不满足就巡逻)
```

```typescript
// 节点基类：每个 tick 返回 Success / Failure / Running
enum NodeStatus { Success, Failure, Running }

abstract class BTNode {
  abstract tick(bb: Blackboard): NodeStatus;
}

// Selector：依次执行子节点，遇到 Success/Running 就返回
class Selector extends BTNode {
  constructor(private children: BTNode[]) { super(); }
  tick(bb: Blackboard): NodeStatus {
    for (const child of this.children) {
      const s = child.tick(bb);
      if (s !== NodeStatus.Failure) return s; // 成功或运行中 → 不往后走
    }
    return NodeStatus.Failure; // 全失败了才返回 Failure
  }
}

// Sequence：依次执行，遇到 Failure 立即短路返回
class Sequence extends BTNode {
  constructor(private children: BTNode[]) { super(); }
  tick(bb: Blackboard): NodeStatus {
    for (const child of this.children) {
      const s = child.tick(bb);
      if (s !== NodeStatus.Success) return s; // 失败或运行中 → 中断序列
    }
    return NodeStatus.Success;
  }
}
```

**2. FSM vs BT vs HFSM 全维度对比**

| 维度 | 有限状态机 (FSM) | 行为树 (BT) | 层次状态机 (HFSM) |
|------|------------------|-------------|-------------------|
| 核心模型 | 状态 + 转换线 | 树形优先级遍历 | 嵌套状态组 |
| 状态爆炸 | ❌ N² 转换线 | ✅ 节点可复用组合 | ⚠️ 部分缓解 |
| 行为切换响应 | 需手写退出逻辑 | 每帧重评估，自动响应 | 组间切换需手写 |
| 可视化编辑 | 状态图连线 | ✅ 拖拽节点最自然 | 嵌套图较复杂 |
| 调试难度 | 看当前状态即可 | 要理解整棵树上下文 | 层级跳转要追踪 |
| 数据驱动 | ❌ 通常硬编码 | ✅ 天然 JSON 序列化 | ⚠️ 部分 |
| 适用场景 | 简单 NPC、UI 流程 | 复杂战斗 AI、开放世界 | 多阶段 BOSS、多模式角色 |
| 实现成本 | 最低 | 中等 | 中高 |

**3. Blackboard（黑板）——行为树的共享数据层**

```typescript
// Blackboard 是行为树的"工作记忆"，节点间通过它读写共享状态
// 避免 AI 逻辑和角色属性直接耦合
class Blackboard {
  data = new Map<string, unknown>();
  get<T>(key: string): T { return this.data.get(key) as T; }
  set(key: string, val: unknown) { this.data.set(key, val); }
}

// 感知系统每帧往 Blackboard 写入环境信息
class PerceptionSystem {
  update(bb: Blackboard, self: Character) {
    const enemy = findNearestEnemy(self.pos, 10);
    bb.set('target', enemy);
    bb.set('distance', enemy ? dist(self.pos, enemy.pos) : Infinity);
    bb.set('lowHealth', self.hp < self.maxHp * 0.3);
  }
}

// 条件节点只读 Blackboard，行为节点读写——解耦感知与决策
class ConditionNode extends BTNode {
  constructor(private check: (bb: Blackboard) => boolean) { super(); }
  tick(bb: Blackboard): NodeStatus {
    return this.check(bb) ? NodeStatus.Success : NodeStatus.Failure;
  }
}
// 用法：new ConditionNode(bb => bb.get<number>('distance') < 3)
```

```
行为树每帧执行流程：
  Perception → 写入 Blackboard → BT.tick() 读 Blackboard 做决策 → 输出 Action
       ↑                                                          │
       └────────────── 角色执行后状态变化反馈 ←────────────────────┘
```

### ⚡ 实战经验

- **行为树不做"记忆"会反复横跳**：弓箭手在射程边缘时，`EnemyInRange` 每帧 true/false 切换导致走一步射一箭又追一步。加一个 Cooldown 节点或 Hysteresis（滞回区间：进入射程 8m，退出射程 12m）解决抖动，否则看起来像抽搐。
- **Selector 子节点顺序就是优先级**：曾把"巡逻"放在 Selector 最前面，结果角色永远巡逻不去打架——因为 Patrol 总返回 Running，后面的攻击节点永远轮不到。Selector 的子节点必须按优先级从高到低排。
- **FSM 超过 12 个状态就该迁移**：维护过一个 23 状态的 BOSS FSM，每次加技能改 40+ 条转换线，QA 测一轮要 3 天。迁到行为树后策划自己配阶段切换，迭代周期降到半天。
- **行为树序列化要版本兼容**：AI 配置 JSON 上线后有 5 万份策划配置，节点结构改动（加字段/改类型）导致老配置反序列化全崩。必须做 schema 版本号 + 自动迁移脚本，发布前跑全量配置校验。
- **装饰器节点（Decorator）是隐藏的利器**：`Inverter`（取反）、`Repeat`（重复 N 次）、`Cooldown`（冷却）这种修饰节点能大幅减少重复逻辑，很多团队只知道 Selector/Sequence，白白写了大量重复条件判断。

### 🔗 相关问题

1. GOAP（目标导向行动规划）和行为树有什么区别？什么场景下 GOAP 比 BT 更合适（如辐射系列的 NPC 日常）？
2. 行为树如何处理"打断"？比如弓箭手蓄力到一半被眩晕，怎么优雅取消正在执行的 Sequence？
3. 多个 AI 共享同一棵行为树实例安全吗？Blackboard 应该每实例一份还是全局共享？
