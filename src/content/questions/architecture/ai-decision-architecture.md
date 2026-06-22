---
title: "游戏 AI 决策架构怎么设计？FSM、行为树、GOAP、HTN、Utility AI 怎么选？"
category: "architecture"
level: 4
tags: ["AI架构", "GOAP", "HTN", "Utility AI", "行为树", "决策系统", "分层架构"]
related: ["architecture/fsm-behavior-tree"]
hint: "不是「哪种 AI 算法更强」——是「按决策频率和目标可分解性分层」，反应层用 BT、连续权衡用 Utility、长程规划用 GOAP/HTN。"
---

## 参考答案

### ✅ 核心要点

1. **AI 决策架构不是选「一种算法」而是分层编排**：游戏 AI 是「感知→决策→行动」的栈，不同层级用不同算法。反应层（0.1s 内躲闪/追击）用行为树/FSM，战术层（几秒的目标选择）用 Utility AI，战略层（长程规划）用 GOAP/HTN。现代 3A 几乎都是混合架构而非单算法，面试时一上来就回答「我选 XXX 算法」通常会被追问到分层。
2. **行为树（BT）解决「条件-动作的优先级编排」**：把决策拆成 Selector（选第一个可行子节点）/Sequence（依次执行全部）的组合，适合「状态可枚举」的怪物 AI，例如一只小怪只会「巡逻→发现玩家→追击→攻击→逃跑」这五件事。但目标一多树就膨胀（几十上百个节点），且无法自动「规划」达到目标的多步行动序列——它只会按你写好的优先级跑。
3. **GOAP（目标导向行动规划）解决「从目标反推行动序列」**：每个 Action 自带前置条件/后置效果（世界状态的 diff），给定目标后用 A* 在「世界状态空间」搜索行动序列，NPC 会自主地「先去捡枪、再装弹、再攻击」。经典案例是《辐射3》的 NPC 自主行为，缺点是规划成本高（A* 在状态空间搜索）、调试黑盒（你很难直观知道它为什么选了这条序列）。
4. **HTN（分层任务网络）解决「把大任务分解成子任务」**：类似递归函数调用——Compound Task 按预设规则（Method）分解成子任务，分解到底层的 Primitive Task 才真正执行。比 GOAP 更可控（分解规则是策划手写的、可预测），是 3A 主流方案（《毁灭战士（DOOM）》、《地平线：零之曙光》都在用），代价是灵活性不如 GOAP——能做出什么行为完全取决于策划写了哪些分解规则。
5. **Utility AI 解决「连续打分选最优」**：给每个候选行为用 Consideration 函数打分（0-1），选分数最高的执行，适合「没有明确目标、只需持续权衡」的场景（《模拟人生》、《文明》系列）。它的优势是没有离散状态、过渡平滑，但对策划调参极其敏感（一条曲线改个指数 NPC 就变胆小）、行为不可预测（测试时很难枚举所有打分组合）。
6. **现代 3A 主流是「分层混合架构」**：高层 HTN 规划「下一步做什么」→ 中层行为树编排「执行步骤的子动作」→ 底层 Utility 微调「朝谁开枪、何时换弹」。单一算法很难覆盖从战略到战术的所有决策频率：GOAP 做不了 0.1s 的反应、行为树规划不了长程、Utility 编排不了多步流程，混合才是工程现实。

### 📖 深度展开

**1. 五种决策范式的本质对比**

| 范式 | 决策方式 | 适用频率 | 可控性 | 典型场景 |
|------|----------|----------|--------|----------|
| FSM | 状态间转移（if-then） | 0.1s 反应 | 极高（状态可枚举） | 简单怪物、Boss 阶段切换 |
| 行为树(BT) | 条件-动作优先级遍历 | 0.1-1s 反应/战术 | 高（节点显式编写） | 中等复杂 NPC、小队协同 |
| GOAP | A* 在世界状态空间搜索 | 1-10s 战术/战略 | 中（行为自组合） | 开放世界 NPC 自主行为 |
| HTN | 任务分解（递归 Method） | 1-10s 战术/战略 | 高（分解规则手写） | 3A FPS/动作 NPC |
| Utility AI | 多维度打分取最高 | 0.1-1s 持续权衡 | 中（曲线调参） | 模拟/策略游戏 NPC |

决策频率是一个连续光谱：0.1s 级的反应（躲闪、追击朝向）要低延迟、高可控，FSM/BT 最合适；1s 级的战术选择（换目标、推/守点）需要权衡多个因素，Utility AI 擅长；10s 级的战略规划（清完这层楼、绕后包抄）需要规划多步序列，GOAP/HTN 才能胜任。同一只 NPC 往往横跨整条光谱，这正是分层混合架构的根本动因。

**2. GOAP 的 A* 规划流程**

```typescript
// Action 用「世界状态 diff」描述前置条件与效果
interface WorldState { [key: string]: boolean | number }

interface GoapAction {
  name: string
  cost: number                       // A* 的 g 值权重
  preconditions: Partial<WorldState> // 执行前必须满足
  effects: Partial<WorldState>       // 执行后写入世界状态
  execute: (ws: WorldState) => void
}

// 规划：在「世界状态空间」做 A* 搜索
function Plan(
  start: WorldState,
  goal: Partial<WorldState>,
  actions: GoapAction[],
): GoapAction[] | null {
  const open: Node[] = [{ state: start, path: [], g: 0, f: heuristic(start, goal) }]
  const closed = new Set<string>()
  while (open.length) {
    open.sort((a, b) => a.f - b.f)
    const cur = open.shift()!
    if (matchesGoal(cur.state, goal)) return cur.path          // 目标达成
    closed.add(key(cur.state))
    for (const act of actions) {
      if (!meets(cur.state, act.preconditions)) continue        // 邻居 = 可施加的 action
      const next = applyDiff(cur.state, act.effects)
      if (closed.has(key(next))) continue
      open.push({ state: next, path: [...cur.path, act],
                  g: cur.g + act.cost, f: cur.g + act.cost + heuristic(next, goal) })
    }
  }
  return null // 无解
}
```

搜索过程在世界状态空间里分支，每施加一个 Action 就得到一个新状态节点：

```
世界状态: {HasWeapon:false, EnemyNear:true, ...}
   ├─ Action: PickupWeapon  (前置 !HasWeapon → 效果 HasWeapon=true)
   │     └─ 状态: {HasWeapon:true, EnemyNear:true}
   │           └─ Action: Attack (前置 HasWeapon → 目标达成 ✅)
   └─ Action: Flee (前置 EnemyNear → 效果 EnemyNear=false)
         └─ 状态: {HasWeapon:false, EnemyNear:false}  ← 目标未达成，继续扩展
```

A* 的启发函数通常是「目标中尚未满足的字段数」，保证搜索朝目标收敛；分支因子 = 当前可施加的 Action 数量，状态空间大时性能会爆炸。

**3. HTN 分解流程（递归任务网络）**

```typescript
type Task = CompoundTask | PrimitiveTask

interface CompoundTask {
  kind: 'compound'
  name: string
  // 多个 Method，按顺序尝试，第一个 context 满足的用于分解
  methods: { condition: (ws: WorldState) => boolean; subtasks: Task[] }[]
}

interface PrimitiveTask {
  kind: 'primitive'
  name: string
  execute: (ws: WorldState) => void
}

// 递归分解：把根任务一路拆到全是 primitive
function Decompose(tasks: Task[], ws: WorldState, depth = 0): PrimitiveTask[] | null {
  if (depth > 10) return null // 防无限递归
  if (tasks.length === 0) return []
  const [head, ...rest] = tasks
  if (head.kind === 'primitive') {
    head.execute(ws) // 应用效果到世界状态
    return [head, ...(Decompose(rest, ws, depth) ?? [])]
  }
  for (const m of head.methods) {
    if (!m.condition(ws)) continue
    const plan = Decompose([...m.subtasks, ...rest], ws, depth + 1)
    if (plan) return plan // 第一个成功的分解方案即采用
  }
  return null
}
```

分解过程的树形结构（策划手写 Method，结果是确定且可预测的）：

```
Combat (CompoundTask)
├─ Method: 远程武器可用 → RangedAttack
│     └─ RangedAttack (CompoundTask) → [Aim, Fire] (Primitive)
└─ Method: 仅近战 → MeleeAttack
      └─ MeleeAttack (CompoundTask) → [Approach, Strike] (Primitive)
```

与 GOAP 的关键区别：HTN 是「自顶向下分解」（策划写好分解规则），GOAP 是「自底向上搜索」（Action 自由组合）。前者可控、后者灵活。

**4. Utility AI 的 Consideration 打分曲线**

```typescript
// Response Curve：把归一化输入映射到 0-1 权重
type Curve = (x: number) => number
const sigmoid: Curve = (x) => 1 / (1 + Math.exp(-10 * (x - 0.5)))
const inverse: Curve = (x) => 1 - x // 距离越近分越高

interface Consideration { input: (ws: WorldState) => number; curve: Curve }

interface Behavior {
  name: string
  considerations: Consideration[]
  score: (ws: WorldState) => number
}

// Attack 行为：综合血量、敌人距离、弹药三维度
const attack: Behavior = {
  name: 'Attack',
  considerations: [
    { input: (ws) => ws.healthRatio, curve: sigmoid },          // 血多才敢打
    { input: (ws) => ws.enemyDistance, curve: inverse },         // 近才打
    { input: (ws) => ws.ammoRatio, curve: sigmoid },             // 有弹才打
  ],
  score: (ws) => Math.min(1,
    this.considerations.reduce((p, c) => p * c.curve(c.input(ws)), 1)),
}

// 选分最高的行为
function Decide(behaviors: Behavior[], ws: WorldState): Behavior {
  return behaviors.reduce((a, b) => b.score(ws) > a.score(ws) ? b : a)
}
```

最终得分是各 Consideration 的连乘积 `score = ∏ curve_i(input_i)`（也有用加权平均的变体）：

| 行为 | health×dist×ammo | score | 是否选中 |
|------|------------------|-------|----------|
| Attack | 0.8 × 0.9 × 0.7 | 0.504 | ✅ 最高 |
| Flee | 0.2 × 0.9 × 1.0 | 0.180 | ❌ |
| Reload | 0.8 × 0.1 × 0.3 | 0.024 | ❌ |

Consideration 之间用乘法而非加法，能保证任一维度为 0 时整体行为被否决（没子弹就不该 Attack），但任一曲线调参都会非线性放大，这是 Utility AI 难调的根源。

**5. 分层混合架构案例（3A FPS NPC）**

```
┌─────────────────────────────────────────────┐
│  战略层 (HTN)        决策频率 ~1-5s          │
│  「清空这层楼」→ 分解为 [推进, 清房, 搜索]    │
└──────────────────┬──────────────────────────┘
                   │ 选中目标任务序列
┌──────────────────▼──────────────────────────┐
│  战术层 (Behavior Tree)  决策频率 ~0.2-1s    │
│  编排「清房」的子动作: 移动→站位→开镜→射击   │
└──────────────────┬──────────────────────────┘
                   │ 当前动作
┌──────────────────▼──────────────────────────┐
│  反应层 (Utility AI)    决策频率 ~每帧       │
│  微调「朝谁开枪/何时换弹/闪避手雷」          │
└─────────────────────────────────────────────┘
        ▲ 感知系统(黑板)同时喂给三层
```

单一算法覆盖全栈必然失配：行为树规划不了「清空整层楼」这种长程目标（节点爆炸且无规划能力）；GOAP 做 0.1s 级反应太慢（每帧 A* 搜索吃满帧预算）；Utility AI 无法表达「先去捡枪再射击」这种有严格时序的多步流程（它每帧独立打分，没有状态记忆）。分层之后每层用最合适的算法，层与层之间通过黑板/任务队列解耦，这才是 3A 的工程现实。

### ⚡ 实战经验

- **GOAP 规划成本要预算**：单 NPC 单次 replan 典型 0.5-2ms，50 个 NPC 同帧 replan 直接卡帧（帧预算 16ms 吃掉一半以上），必须分帧调度（每帧只 replan N 个，轮询覆盖全部 NPC）+ 缓存结果直到世界状态显著变化（血量/敌人可见性等关键字段变化才触发重规划），否则掉帧。
- **HTN 分解规则要防无限递归**：分解规则一旦写成循环（A 分解出 B，B 又分解出 A），会栈溢出崩溃。《地平线：零之曙光》团队踩过这个坑——必须有 max decomposition depth 保护（典型设 8-10 层），超限直接判失败并 fallback 到默认行为。
- **Utility AI 的 Response Curve 选错会抖动**：用线性曲线代替 sigmoid 会导致 AI 在两个分数接近的行为间反复横跳（每帧切换），表现就是 NPC 原地来回走。解决：加「滞回阈值」（当前行为分数必须比次高行为低 15% 以上才切换），牺牲一点灵敏度换稳定性。
- **行为树感知数据要每帧 tick 前刷新**：黑板里的「敌人位置/血量」如果用上一帧的值，1 帧延迟（16ms）就可能导致 NPC 朝已经死掉的敌人开枪、或撞上已经移动的掩体。感知系统必须在 `BT.Update()` 之前刷新黑板，保证决策基于当前帧的感知快照。
- **AI 决策必须可「回放调试」**：上线后「NPC 为什么卡住了」根本无法靠肉眼复现。必须记录每帧每个 NPC 的决策栈（哪个 BT 节点 active / HTN 选了哪条分解 / Utility 各行为分数），出 Bug 时回放定位。单帧日志压缩后约 200B/NPC，100 NPC × 60fps × 60s ≈ 70MB，完全可以接受。

### 🔗 相关问题

- 行为树和 Utility AI 能结合吗？典型结合方式是什么？例如在 BT 的某些决策节点上用 Utility 打分来选择子节点，既保留 BT 的流程编排能力，又获得 Utility 的连续权衡——这种「Utility 节点」在《最后生还者》《杀戮地带》里都有应用，但要小心打分抖动传染到整棵树。
- GOAP 和 HTN 在「策划可控性」上有什么本质区别？为什么 3A 更偏爱 HTN？GOAP 让 NPC 自由组合 Action，行为涌现但难预测；HTN 把分解规则（Method）交给策划手写，输出完全可控、可测试。3A 项目周期长、要做大量 QA 与关卡 review，可控性 > 灵活性，所以 HTN 成为主流。
- 如何对 AI 决策系统做性能剖析和帧预算分配？多个 NPC 的 replan 怎么调度？要按「决策频率分层」分配预算：反应层每帧但轻量、规划层分帧轮询、战略层低频；replan 用时间片轮转 + 优先级队列（玩家附近的 NPC 优先），并对每个 planner 设置 ms 上限超时即 fallback，保证帧时间稳定。
