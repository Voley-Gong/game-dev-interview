---
title: "游戏主循环为什么需要固定时间步长？如何实现？"
category: "programming"
level: 2
tags: ["游戏循环", "时间步长", "物理模拟", "帧率"]
related: ["programming/async-coroutine-scheduling", "programming/memory-gc-optimization"]
hint: "为什么 60fps 和 30fps 下物理表现不一致？累积器如何解决浮点漂移？"
---

## 参考答案

### ✅ 核心要点

1. **可变步长的陷阱**：直接用 `deltaTime` 驱动物理模拟，帧率波动会导致碰撞穿透、弹道轨迹不一致、AI 决策不稳定等"看运气"的 Bug
2. **固定步长原理**：物理/逻辑更新使用恒定的 `dt`（如 1/60s），与渲染帧率解耦，保证数值积分的确定性和稳定性
3. **累积器模式**：每帧将真实 `deltaTime` 累加到 accumulator，循环消耗固定步长执行逻辑更新，剩余时间留到下一帧或用于插值
4. **插值平滑渲染**：逻辑更新可能一帧执行多次或零次，渲染时需要根据 accumulator 残余比例对物体位置做线性插值，消除视觉抖动
5. **螺旋死亡（Spiral of Death）**：当逻辑更新耗时超过一个固定步长时，accumulator 持续增长，陷入"追不上"的死循环，必须设置单帧最大更新次数

### 📖 深度展开

**1. 经典固定步长游戏循环**

```typescript
const FIXED_DT = 1 / 60;     // 固定逻辑步长
const MAX_UPDATES = 5;        // 单帧最大更新次数，防止螺旋死亡

let accumulator = 0;
let lastTime = performance.now();
let prevState: PhysicsState;  // 上一次逻辑状态
let currState: PhysicsState;  // 当前逻辑状态

function gameLoop(now: number): void {
  let frameTime = (now - lastTime) / 1000;
  lastTime = now;

  // 防止暂停后回来 dt 暴涨
  if (frameTime > 0.25) frameTime = 0.25;

  accumulator += frameTime;

  let updates = 0;
  while (accumulator >= FIXED_DT && updates < MAX_UPDATES) {
    prevState = currState.clone();
    currState = physicsStep(currState, FIXED_DT); // 固定 dt 更新
    accumulator -= FIXED_DT;
    updates++;
  }

  // 插值因子：accumulator 中残余的时间占比
  const alpha = accumulator / FIXED_DT;
  const renderState = interpolate(prevState, currState, alpha);

  render(renderState);
  requestAnimationFrame(gameLoop);
}

function interpolate(a: PhysicsState, b: PhysicsState, t: number): PhysicsState {
  return {
    pos: a.pos.lerp(b.pos, t),
    angle: a.angle + (b.angle - a.angle) * t,
  };
}
```

**2. 可变步长 vs 固定步长对比**

```
可变步长（Variable Timestep）：

帧1: dt=0.016s → 更新     帧率波动 → 物理行为不确定
帧2: dt=0.030s → 更新     ↓ 碰撞检测可能跳过
帧3: dt=0.008s → 更新     ↓ 弹道轨迹每次运行不同
                          ↓ 无法做确定性回放

固定步长（Fixed Timestep + 累积器）：

帧1: dt_real=0.030s → accumulator=0.030
      → 消耗 1 次 fixed_dt(0.016) → 余 0.014
帧2: dt_real=0.020s → accumulator=0.034
      → 消耗 2 次 fixed_dt(0.016) → 余 0.002
      ✓ 每次物理积分用相同 dt → 确定性
```

| 维度 | 可变步长 | 固定步长 |
|------|---------|---------|
| 物理稳定性 | 差（dt 波动影响数值积分） | 优（恒定 dt 保证一致） |
| 确定性/可回放 | 不可能 | 可实现帧级精确回放 |
| 渲染帧率匹配 | 天然匹配（每帧更新一次） | 需插值，实现更复杂 |
| 低帧率表现 | 物理直接崩坏 | 逻辑仍在正确步进（但可能螺旋死亡） |
| 网络同步 | 无法保证一致性 | 锁步同步的基础 |
| 适用场景 | 简单休闲游戏、无物理 | 动作游戏、物理模拟、竞技游戏 |

**3. 螺旋死亡的成因与防御**

```typescript
// ❌ 危险写法：没有更新次数上限
while (accumulator >= FIXED_DT) {
  physicsStep(FIXED_DT); // 如果单步耗时 > FIXED_DT
  accumulator -= FIXED_DT; // accumulator 不减反增 → 死循环
}

// ✅ 安全写法：限制单帧更新次数
let updates = 0;
while (accumulator >= FIXED_DT && updates < MAX_UPDATES) {
  physicsStep(FIXED_DT);
  accumulator -= FIXED_DT;
  updates++;
}
// 超出上限时丢弃残余时间，接受轻微的逻辑减速
if (updates >= MAX_UPDATES) {
  accumulator = 0; // 重置，避免持续堆积
  console.warn('[GameLoop] 帧率过低，丢弃部分物理更新');
}
```

### ⚡ 实战经验

- **暂停处理**：游戏暂停时不要让 `lastTime` 继续累计，否则恢复后 `frameTime` 暴涨导致一次性执行数百次物理更新。暂停时重置 `lastTime` 或 clamp `frameTime`
- **浮点累积误差**：长期运行后 accumulator 浮点精度会漂移，建议使用整数毫秒累加再转换，或定期校准
- **子步长（Substepping）**：高速移动物体（如子弹）即使在固定步长下也可能穿透，需要进一步将物理更新拆分为更小的子步长做连续碰撞检测
- **帧率上限与功耗**：移动端将固定步长设为 1/30 可显著降低 CPU 负载和发热，但要注意动画过渡和输入响应的流畅度
- **调试用的帧步进**：固定步长使得逐帧调试成为可能——固定 dt 下输入相同就得到相同结果，可以精确定位物理 Bug 的触发帧

### 🔗 相关问题

- 如何实现确定性物理模拟以支持网络锁步同步？
- requestAnimationFrame 的刷新率与显示器刷新率的关系？高刷新率（144Hz）下如何处理？
- 半隐式欧拉积分（Semi-implicit Euler）与 Verlet 积分在游戏中的选择？
