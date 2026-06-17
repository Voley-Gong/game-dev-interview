---
title: "状态模式在游戏开发中怎么用？和有限状态机、策略模式有什么区别？"
category: "programming"
level: 2
tags: ["设计模式", "状态模式", "FSM", "角色控制", "AI"]
related: ["programming/behavior-tree-vs-fsm", "programming/strategy-pattern-game"]
hint: "不是 switch-case 堆出来的状态分支——是把每个状态封装成对象，靠多态消除分支，让新增状态不改老代码。"
---

## 参考答案

### ✅ 核心要点

1. **状态模式的核心是"用多态消灭 switch-case"**：把每个状态抽象成独立的类（State），实现统一接口（enter/update/exit），Context（角色）持有当前状态对象并委托调用。新增状态只需加一个类，不碰已有状态代码——符合开闭原则。传统 `switch(state)` 写法每加一个状态要改所有分支，状态多了成"分支地狱"。
2. **状态自己持有 Context 引用，自己负责转换**：这是状态模式和策略模式最大的区别。`AttackState` 里检测到敌人死亡，自己调用 `context.changeState(new IdleState())`；而策略模式的策略对象是被外部挑选的，自己不知道下一个策略是谁。状态模式把"转换逻辑"内聚到状态里，避免 Context 变成知道所有转换规则的上帝对象。
3. **统一的生命周期 enter/update/exit**：`enter` 做初始化（播动画、设速度）、`update` 每帧执行逻辑（移动、检测输入）、`exit` 做清理（停动画、复位参数）。这套生命周期让状态切换时资源不泄漏，比如从 `AttackState` 退出时必须停掉攻击动画，否则会和下一个状态的动画打架。
4. **与有限状态机（FSM）是不同抽象层级**：状态模式是 OOP 设计模式，强调"状态封装成对象"；FSM 是一种系统架构，强调"状态 + 转换图 + 数据驱动"。简单角色用状态模式手写几个类就够；复杂 AI（几十个状态、上百条转换边）必须用 FSM 框架（转换表/可视化编辑器），或上行为树。状态模式是 FSM 的一种实现方式。
5. **与策略模式结构相同但意图相反**：两者都是"把可变行为委托给外部对象"。但策略由 Client 主动挑选算法（"这次用物理伤害还是魔法伤害"），策略间平等无转换；状态由状态机自动驱动，状态间有明确的转换规则和时序。混淆两者会导致把"策略切换"写成"状态机"，或反之。
6. **游戏场景：角色控制器、UI 面板、加载流程、连招系统**：角色控制器的站立/跑/跳/攻击/眩晕/死亡是最经典应用；UI 面板（打开/关闭/锁定/动画中）用状态模式管理交互；连招系统（轻击→轻击→重击→终结技）用状态链表达输入窗口。

### 📖 深度展开

**1. 角色控制器状态机：状态模式的经典实现**

```typescript
// 状态接口：所有状态必须实现这三个生命周期方法
interface CharacterState {
  enter(ctx: Character): void;   // 进入时：播动画、设参数
  update(ctx: Character, dt: number): void;  // 每帧：逻辑 + 转换检测
  exit(ctx: Character): void;    // 退出时：清理
}

// Context（角色）：持有当前状态，所有行为委托给状态
class Character {
  state: CharacterState;
  velocity = { x: 0, y: 0 };
  hp = 100;

  constructor(initial: CharacterState) {
    this.state = initial;
    this.state.enter(this);  // 初始状态 enter
  }

  changeState(next: CharacterState): void {
    this.state.exit(this);   // ① 退出旧状态（停动画、复位）
    this.state = next;        // ② 切换引用
    next.enter(this);         // ③ 进入新状态（播新动画）
  }

  update(dt: number): void { this.state.update(this, dt); }
}

// 具体状态：每个状态内聚自己的逻辑和转换规则
class RunState implements CharacterState {
  enter(c: Character) { c.playAnim('run'); }
  update(c: Character, dt: number) {
    c.velocity.x = c.inputDir * 5;
    if (c.inputAttack) c.changeState(new AttackState());  // 状态自己决定转换
    else if (!c.isGrounded) c.changeState(new JumpState());
    else if (c.velocity.x === 0) c.changeState(new IdleState());
  }
  exit(c: Character) { c.stopAnim('run'); }
}
// ✅ 新增"滑铲状态"只需写一个 SlideState 类，RunState/IdleState 一行不改
```

**2. State Pattern vs FSM vs Strategy：三者极易混淆，看这张对比表**

| 维度 | 状态模式 | 有限状态机 (FSM) | 策略模式 |
|------|---------|-----------------|---------|
| **抽象层级** | OOP 设计模式 | 系统架构 | OOP 设计模式 |
| **状态/策略谁切换** | 状态自己切换 | 外部转换表驱动 | Client 主动挑选 |
| **有无转换规则** | 有（内聚在状态里） | 有（转换图/表） | 无（策略间平等） |
| **生命周期** | enter/update/exit | 可有可无 | 通常无（无状态） |
| **数据驱动** | 难（状态是代码） | 易（转换表可配置） | 难 |
| **适用规模** | 3-8 个状态 | 10-50 个状态 | 算法族替换 |
| **游戏典型场景** | 角色控制器、UI 面板 | 复杂敌人 AI、任务系统 | 伤害计算、排序算法 |

```
角色状态转换图（状态模式实现的状态机）：
        ┌──────────────────────────────────────┐
        ▼                                       │
     [Idle] ──输入方向──► [Run] ──跳跃──► [Jump] │
        ▲                    │                   │
        │                    ├──攻击──► [Attack] │
        │                    │                   │
        └────落地/移动停止────┘                   │
        │                                        │
        └──────── 受击/死亡 ──────► [Stun]→[Dead] │
                            (转换规则内聚在各状态类内)
```

**3. 分层状态（HSM）：蹲伏时还能跑/跳，如何避免状态爆炸**

```typescript
// 问题：地面状态有 Idle/Run/Jump，空中状态有 Fall/Glide，
// 再乘以"是否蹲伏"，状态数 = 5 × 2 = 10 个，爆炸式增长。
// 解法：分层状态——外层管"在地面/在空中"，内层管"具体动作"。

interface HierarchicalState extends CharacterState {
  subState?: CharacterState;  // 嵌套子状态
  parent: HierarchicalState | null;
}

class GroundedState implements HierarchicalState {
  parent = null;
  subState: CharacterState;  // 内部委托给 Idle/Run/Crouch
  enter(c: Character) { this.subState?.enter(c); }
  update(c: Character, dt: number) {
    if (!c.isGrounded) { c.changeState(new AirborneState()); return; }
    this.subState?.update(c, dt);  // 转发给内层
  }
  exit(c: Character) { this.subState?.exit(c); }
}

// 好处：新增"滑铲"只改 GroundedState 内部，AirborneState 不受影响
// Cocos/Unity 的 Animator 的 Layer 机制本质就是分层状态机
```

| 状态组织方式 | 状态数（5动作×2姿态） | 维护成本 | 转换边数 |
|-------------|---------------------|---------|---------|
| 扁平状态机 | 10 个 | 高（每个都要管姿态） | ~30 条 |
| 分层状态机 (HSM) | 5 + 2 = 7 个 | 低（分层正交） | ~12 条 |
| 并行状态机 | 2 个轨道各 5/2 个 | 中 | ~8 条 |

### ⚡ 实战经验

- **状态对象别复用单例**：早期把每个状态写成单例（`IdleState.instance`）省内存，结果两个敌人共享同一状态对象，A 敌人的 `enter` 把 B 敌人的动画也触发了。状态对象必须每个角色实例化一份，持有 per-entity 数据（如连招计数、技能 CD），内存开销可忽略（几百字节）。
- **exit 里忘记停动画导致播放错乱**：`AttackState` 里播了 0.8 秒攻击动画，exit 时没调用 `stopAnim`，切到 `RunState` 后攻击和跑步动画叠加播放，角色像抽搐。强制规范：每个 enter 里启动的资源必须在 exit 里对应停止，用 try/finally 包裹保证异常也不漏。
- **状态转换在同一帧集中触发会丢帧**：某帧 `Idle→Run→Jump→Fall` 连跳 4 个状态，每个 enter 都播动画、设参数，单帧卡了 6ms。加一个"每帧最多转换一次"的限制，多余转换延迟到下一帧，掉帧问题消失。高频转换链是性能隐患。
- **用 FSM 框架而非手写状态类当状态超过 8 个**：手写到 12 个状态时，转换规则散落各处，策划想加"霸体状态"要改 6 个文件。迁移到可视化 FSM 框架（Cocos 的 Animator、第三方 xstate）后，转换图可视化，策划自己拖连线，迭代速度提升 5 倍。
- **状态模式 + 命令模式做输入录制回放**：把玩家输入录成命令序列，重放时喂给状态机，就能实现录像/回放/撤销。状态模式保证转换确定性（同样输入同样转换），是帧同步录像的基础——某项目用这套做了观战系统，10 分钟录像回放零偏差。

### 🔗 相关问题

1. 当角色同时处于"攻击中"和"霸体中"两个正交状态时，单一状态机表达不了，该如何设计并行状态机（Orthogonal Regions）？状态间如何通信？
2. 状态模式的状态对象如果持有大量 per-entity 数据（技能 CD、Buff 列表），内存布局会不会变差？是否该用数据导向（SoA）的方式把状态数据外提到数组里？
3. 行为树相对于状态模式/FSM，在什么 AI 复杂度下才值得引入？简单的巡逻-追击-攻击敌人用状态机还是行为树更合适？
