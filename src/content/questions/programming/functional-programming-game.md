---
title: "函数式编程思想在游戏开发中如何运用？"
category: "programming"
level: 2
tags: ["函数式编程", "纯函数", "设计范式"]
related: ["programming/immutable-data-structures", "programming/ecs-architecture"]
hint: "为什么 ECS 和帧同步系统越来越偏爱纯函数？可变状态是 Bug 之源，但游戏又离不开状态——怎么平衡？"
---

## 参考答案

### ✅ 核心要点

1. **纯函数（Pure Function）**：相同输入永远产生相同输出，无副作用。帧同步、回放、单元测试都依赖它来保证确定性
2. **不可变数据（Immutability）**：数据一旦创建就不修改，通过「生成新值」表达变化，天然避免共享状态竞态和撤销/回滚难题
3. **高阶函数（Higher-Order Function）**：函数作为参数或返回值，用 `map/filter/reduce` 替代手写循环，逻辑更声明式、更易组合
4. **函数组合（Composition）**：把小函数串成管道，每个环节职责单一，比深层继承更灵活地复用逻辑
5. **并非全盘 FP**：游戏是状态密集型的，实践中用「核心逻辑纯函数化 + 外层管理可变状态」的混合范式，而非教条式消除一切副作用

### 📖 深度展开

**1. 纯函数：让战斗结算可回放、可测试**

```typescript
// ❌ 不纯：依赖外部随机数和时间，每次结果不同，无法回放
function dealDamageDirty(target: Character) {
  const crit = Math.random() < 0.2;          // 副作用：读取全局随机源
  const dmg = this.atk * (crit ? 2 : 1);
  target.hp -= dmg;                           // 副作用：直接修改入参
  if (Date.now() - this.lastHit > 1000) { }   // 副作用：读取系统时间
}

// ✅ 纯函数：所有依赖通过参数传入，返回新状态而非修改
interface CombatInput { atk: number; rand: number; defenderHp: number; }
interface CombatOutput { damage: number; isCrit: boolean; newHp: number; }

function computeDamage(input: CombatInput): CombatOutput {
  const isCrit = input.rand < 0.2;            // 随机数由外部种子序列提供
  const damage = Math.floor(input.atk * (isCrit ? 2 : 1));
  return { damage, isCrit, newHp: input.defenderHp - damage };
}
// 同样的输入永远得到同样的输出 → 可单元测试、可录制回放、可帧同步校验
```

**2. 高阶函数：声明式处理实体集合**

```typescript
// ECS 系统中筛选并处理实体，用组合替代手写 for + if 嵌套
const aliveEnemies = entities
  .filter(e => e.has(Health) && e.get(Health).hp > 0 && e.team === 'enemy')
  .map(e => ({ id: e.id, dist: distance(e, player) }))
  .filter(r => r.dist < aggroRange)
  .sort((a, b) => a.dist - b.dist)
  .slice(0, maxTargets);

// 函数组合：把校验逻辑抽成可复用的小函数
const isAlive = (e: Entity) => e.get(Health).hp > 0;
const isEnemy = (e: Entity) => e.team === 'enemy';
const inRange = (range: number) => (e: Entity) => distance(e, player) < range;
// 组合成新函数，语义清晰、易于单元测试
const isTargetable = (e: Entity) => isAlive(e) && isEnemy(e) && inRange(5)(e);
```

**3. 不可变更新：安全的状态变更与撤销**

```
可变状态（命令式）            不可变状态（函数式）
  state.hp -= 10               state = { ...state, hp: state.hp - 10 }
  ↑ 原地修改，历史丢失          ↑ 生成新对象，旧状态可保留用于撤销/回滚

优势：撤销栈、时间回溯、React 风格响应式更新都依赖「旧值不被破坏」
代价：每次拷贝有性能开销 → 用结构共享（Persistent Data Structure）缓解
```

```typescript
// 不可变的技能效果叠加：每次返回新 buff 列表，支持回滚到任意历史快照
function applyBuff(buffs: Buff[], buff: Buff): Buff[] {
  return [...buffs, buff];  // 不修改原数组
}
function removeBuff(buffs: Buff[], id: string): Buff[] {
  return buffs.filter(b => b.id !== id);
}
// 撤销系统只需保存每次变更前的 buffs 引用，零拷贝回滚
```

**命令式 vs 函数式范式对比：**

| 维度 | 命令式（OOP/可变） | 函数式（纯/不可变） | 游戏中的取舍 |
|------|-------------------|---------------------|-------------|
| 状态管理 | 原地修改，高效 | 生成新值，安全 | 热点路径用可变，逻辑层用不可变 |
| 可测试性 | 需 mock 大量依赖 | 纯函数直接断言 | 战斗结算优先纯函数 |
| 并发安全 | 需加锁 | 天然无竞态 | Web Worker/多线程受益 |
| 性能 | 高（零分配） | 有拷贝开销 | 每帧万次调用慎用不可变 |
| 回放/撤销 | 难（状态已覆盖） | 易（保留历史） | 录像、存档系统首选 |

### ⚡ 实战经验

- **别在每帧热点路径用不可变**：曾把「每帧更新 5000 个粒子位置」改成不可变 spread，GC 压力暴增导致掉帧。热点路径保留可变数组，逻辑层才用不可变
- **纯函数是帧同步的基石**：把 `Math.random()`、`Date.now()`、`performance.now()` 全部替换成注入的确定性种子源，否则回放一定会不同步——这是排查了 3 天才定位的经典坑
- **函数组合别过度**：超过 4 层的 `pipe(compose(...))` 嵌套会让调试栈变成黑盒。团队约定单个管道不超过 5 步，超了就拆成具名中间函数
- **用 Ramda/lodash-fp 要克制体积**：这类库动辄几十 KB，小游戏（微信小游戏 4MB 限制）建议手写需要的几个工具函数，避免引入整个库

### 🔗 相关问题

- 不可变数据结构的「结构共享」是怎么避免深拷贝开销的？Trie 在其中起什么作用？
- 函数式编程和面向对象在游戏架构中是互斥的吗？ECS 为什么被认为是数据导向而非纯 OOP？
- 柯里化（Currying）和偏应用（Partial Application）有什么区别？在配置系统中有何妙用？
