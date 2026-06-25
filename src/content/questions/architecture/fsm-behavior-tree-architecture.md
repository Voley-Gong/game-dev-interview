---
title: "有限状态机（FSM）与行为树（BT）如何选型与实现？HFSM 解决了什么问题？"
category: "architecture"
level: 3
tags: ["FSM", "有限状态机", "行为树", "Behavior Tree", "HFSM", "AI 架构", "状态管理", "架构设计"]
related: ["architecture/ecs-architecture", "architecture/event-driven-vs-data-driven", "architecture/strategy-pattern-game"]
hint: "FSM 的状态爆炸问题（N 个状态两两互转 = N² 条迁移）是行为树登场的根本原因。但 BT 不是银弹——简单角色用 FSM 更直观，复杂 AI 才值得 BT 的模块化成本。HFSM 则是两者的中间态。"
---

## 参考答案

### ✅ 核心要点

1. **FSM = 状态 + 迁移 + 动作**：每个状态封装 `OnEnter/OnUpdate/OnExit`，迁移由条件触发。适合**状态少、迁移清晰**的逻辑：角色行为（待机/移动/攻击/受击）、UI 流程、技能阶段机。优点是直观易调试，缺点是状态一多就爆炸。
2. **状态爆炸是 FSM 的致命伤**：N 个状态若两两可迁移，最坏需 N² 条迁移线。比如 BOSS 有"巡逻/追击/普攻/技能/狂暴/逃跑"6 态，加状态后会指数增长，迁移图变成蜘蛛网无法维护——这就是引入 HFSM 或行为树的动机。
3. **HFSM（分层状态机）用嵌套复用迁移**：把"受击"做成所有战斗状态的父级，任何子状态受击时统一切到"硬直"，避免在每个状态里重复写受击迁移。Unity PlayMaker、许多技能系统底层都是 HFSM。
4. **行为树用组合节点表达优先级与顺序**：核心是 `Selector`（或/尝试到成功）、`Sequence`（与/按序全部成功）、`Decorator`（修饰/反转/重复）+ 叶节点（Action/Condition）。树形结构天然模块化、可复用、可热插拔，是复杂 AI 的主流方案。
5. **选型原则：状态 ≤ 6 用 FSM，有明确层级用 HFSM，AI 行为复杂且需复用用 BT**：FSM 胜在简单可预测，BT 胜在可组合可扩展。敌人小兵用 FSM，BOSS/同伴 AI 用 BT 是业界常见搭配。两者不是二选一——一个角色可以 FSM 管"战斗/非战斗"大状态，BT 管战斗内的行为决策。

### 📖 深度展开

**FSM vs HFSM vs 行为树的迁移复杂度对比：**

```
❌ 平铺 FSM（6 状态两两迁移，蜘蛛网）：
  Idle ─┬─→ Move ─→ Attack ─→ ...
        └─→ Hurt ←── (每个状态都要画一条受击线)
  迁移线数 ≈ N²，加状态要改所有相关节点

✅ HFSM（受击提升为父状态，迁移复用）：
  CombatState (父：统一处理受击 → Stagger)
    ├─ Idle (子)
    ├─ Move (子)
    └─ Attack (子)
  任何子状态受击都走父级迁移，无需重复

✅ 行为树（无显式状态，每帧从根重新评估优先级）：
  Selector (按优先级尝试)
    ├─ Sequence [血量<20%] → 逃跑
    ├─ Sequence [敌人在范围内] → Sequence[选技能] → 释放
    └─ 巡逻
```

**泛型 FSM 实现（C#）：**

```csharp
public interface IState {
    void OnEnter();
    void OnUpdate(float dt);
    void OnExit();
}

public class FSM {
    private IState _current;
    private readonly Dictionary<string, IState> _states = new();

    public void Add(string key, IState state) => _states[key] = state;

    public void Change(string key) {
        if (!_states.TryGetValue(key, out var next)) return;
        _current?.OnExit();
        _current = next;
        _current.OnEnter();
    }

    public void Update(float dt) => _current?.OnUpdate(dt);
}

// 角色状态示例
public class AttackState : IState {
    private readonly EnemyAI _ai;
    public AttackState(EnemyAI ai) => _ai = ai;
    public void OnEnter() => _ai.Anim.Play("attack");
    public void OnUpdate(float dt) {
        if (!_ai.InAttackRange()) _ai.Fsm.Change("chase");  // 迁移条件
    }
    public void OnExit() => _ai.Anim.Stop();
}
```

**行为树核心节点实现（C#）：**

```csharp
public enum NodeStatus { Success, Failure, Running }

public abstract class BTNode {
    public abstract NodeStatus Execute();
}

// Sequence（与）：依次执行，遇到 Failure 立即返回，全 Success 才 Success
public class Sequence : BTNode {
    private readonly List<BTNode> _children;
    private int _idx;  // 记忆断点，支持 Running 续跑
    public Sequence(params BTNode[] c) => _children = new(c);
    public override NodeStatus Execute() {
        for (; _idx < _children.Count; _idx++) {
            var s = _children[_idx].Execute();
            if (s != NodeStatus.Success) return s;  // Failure/Running 提前退出
        }
        _idx = 0;  // 完成，重置
        return NodeStatus.Success;
    }
}

// Selector（或）：依次尝试，遇到 Success/Running 立即返回，全 Failure 才 Failure
public class Selector : BTNode {
    private readonly List<BTNode> _children;
    private int _idx;
    public Selector(params BTNode[] c) => _children = new(c);
    public override NodeStatus Execute() {
        for (; _idx < _children.Count; _idx++) {
            var s = _children[_idx].Execute();
            if (s != NodeStatus.Failure) return s;
        }
        _idx = 0;
        return NodeStatus.Failure;
    }
}

// 叶节点：条件 + 动作
public class ConditionNode : BTNode {
    private readonly Func<bool> _check;
    public ConditionNode(Func<bool> check) => _check = check;
    public override NodeStatus Execute() => _check() ? NodeStatus.Success : NodeStatus.Failure;
}

public class ActionNode : BTNode {
    private readonly Func<NodeStatus> _action;
    public ActionNode(Func<NodeStatus> action) => _action = action;
    public override NodeStatus Execute() => _action();
}
```

**三种方案对比：**

| 维度 | 平铺 FSM | HFSM | 行为树 |
|------|----------|------|--------|
| 状态迁移复杂度 | O(N²) 爆炸 | O(N) 可复用 | 无显式迁移 |
| 模块复用 | 差 | 中 | ✅ 好（节点可组合） |
| 优先级表达 | 难（要手动排） | 中 | ✅ 天然（Selector 顺序） |
| 中断/打断 | 要每个状态手写 | 父级统一处理 | Decorator/Abort 机制 |
| 调试直观度 | ✅ 最直观 | 中 | 树大时需可视化工具 |
| 学习成本 | 低 | 中 | 高 |
| 适用规模 | ≤6 状态 | 中等复杂 | 复杂 AI/BOSS |
| 引擎工具 | PlayMaker(Unity) | - | Behavior Designer/NodeCanvas |

### ⚡ 实战经验

- **行为树一定要配 Blackboard（共享黑板）**：节点间靠 Blackboard 传递"当前目标、巡逻点、仇恨值"，而不是每个节点自己 `GetComponent` 或查全局单例。Blackboard 是 AI 的"工作记忆"，没有它的 BT 会导致节点间隐式耦合、无法复用。但要注意 Blackboard 别塞太多全局状态，否则退化成"全局变量大杂烩"，调试时谁在改哪个值都查不清。
- **FSM 的迁移条件别写在 Update 里轮询，优先用事件触发**：`OnUpdate` 里每帧 `if (hp < 0) Change("dead")` 看着简单，状态一多就满屏 if-else。受击、死亡这类离散事件用事件/回调驱动迁移（`OnDamaged += CheckDeath`），只有"距离判断"这类连续条件才轮询。混用时要明确哪些是事件驱动、哪些是轮询，避免迁移时序混乱（同一帧多个事件触发导致状态反复横跳）。
- **行为树的 Running 状态要正确记忆断点，否则每帧从头跑**：Sequence/Selector 执行到 Running 的子节点后必须保存索引，下一帧从断点继续，而不是重新从第一个子节点评估。新手常忘了存 `_idx`，导致"攻击到一半又重新选目标"的抽搐行为。同时要做 Abort（中止）机制：高优先级条件满足时强制打断低优先级的 Running 节点，否则角色会"打完当前动作才反应"。
- **别用 FSM 做"技能连招系统"——用技能时间轴/状态机混合更合适**：连招涉及帧窗口、输入缓冲、取消点，纯 FSM 表达会极其繁琐。业界做法：技能本身用"阶段机"（前摇/生效/后摇）或配置驱动的 Timeline，FSM 只管"当前在放哪个技能"。把连招判定塞进通用 FSM 是过度抽象，反而比专用系统更难维护。

### 🔗 相关问题

1. 行为树的"条件中止"（Conditional Abort / Decorator）机制如何实现优先级抢占？如何避免低优先级节点占着 Running 不释放？
2. ECS 架构下，FSM/行为树的状态数据应该存成 Component 还是 System 内部状态？如何让 AI 决策支持 Job 并行？
3. 目标导向行动计划（GOAP/Utility AI）相比行为树，在什么游戏类型下更有优势？三者的决策粒度差异是什么？
