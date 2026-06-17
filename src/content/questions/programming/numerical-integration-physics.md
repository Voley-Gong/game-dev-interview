---
title: "游戏物理引擎用哪种数值积分方法？为什么不用最精确的 RK4？"
category: "programming"
level: 3
tags: ["数值积分", "物理引擎", "Verlet", "RK4", "数值稳定性", "算法"]
related: ["programming/game-math-vector-matrix", "programming/game-loop-fixed-timestep", "programming/floating-point-precision"]
hint: "不是'越精确越好'——是精度、稳定性、开销三者的权衡，游戏实时模拟要的是'能量不爆'而非天体物理级精度。"
---

## 参考答案

### ✅ 核心要点

1. **数值积分是物理引擎的数学基石**：游戏里的抛体运动、弹簧、碰撞响应大多是常微分方程（ODE），解析解不存在或太贵，只能用离散步进近似——每帧用当前位置/速度/加速度推算下一帧的位置。积分器的选择直接决定模拟是否稳定、是否可信。
2. **显式 Euler 最简单但会能量泄漏**：`v += a*dt; x += v*dt` 一行写完，但对弹簧振子、轨道运动这类"无阻尼振荡系统"，每帧能量都会单调增长，几秒后物体飞出屏幕。这是新手写弹簧相机/绳索时最常见的"为什么会越抖越大"的根因。
3. **半隐式（Symplectic）Euler 几乎免费地稳定**：只要把更新顺序改成 `v += a*dt; x += v*dt` 中先更新速度、再用新速度更新位置（而不是用旧速度），能量就在一个周期内近似守恒，不再单调爆涨。开销与显式 Euler 完全相同，是绝大多数游戏物理引擎的默认选择。
4. **Verlet 积分天然适合约束系统**：位置式 Verlet 不显式存储速度，而是用 `x_new = 2*x - x_old + a*dt²` 从前后两帧位置推算，这让"约束求解"（绳索长度固定、布料不可拉伸）变得极简——直接投影修正位置即可。布料、绳索、软体几乎都用 Verlet。
5. **RK4 精度最高但开销是 Euler 的 4 倍**：四阶龙格-库塔每步要算 4 次导数，精度 O(dt⁵) 远超 Euler 的 O(dt²)。但它不保辛结构，长时间仍会漂移，且 4 倍计算量在几千个实体的实时游戏里不可接受，多用于弹道预计算、轨道模拟等"离线或低频"场景。
6. **积分器选择是三角权衡，没有银弹**：精度（RK4）、稳定性（Symplectic/Verlet）、开销（Euler）三者不可兼得。工程上的通行做法是：默认半隐式 Euler，振荡/约束系统用 Verlet，对确定性敏感的关键弹道用 RK4 离线预演，遇到爆炸/穿模再上子步长（substep）或 CCD。

### 📖 深度展开

**1. 四种积分器的公式与代码对比**

```typescript
// 统一接口：给定当前状态和加速度函数，推进一步
interface Body { pos: Vec3; vel: Vec3; }
type AccelFn = (pos: Vec3, vel: Vec3, t: number) => Vec3;

// ① 显式 Euler：用旧速度推位置。最简单，振荡系统能量发散
function explicitEuler(b: Body, a: AccelFn, dt: number): Body {
  const acc = a(b.pos, b.vel, 0);
  return {
    pos: add(b.pos, scale(b.vel, dt)),     // 用【旧】速度
    vel: add(b.vel, scale(acc, dt)),
  };
}

// ② 半隐式(Symplectic) Euler：先更新速度，再用【新】速度推位置。免费稳定
function symplecticEuler(b: Body, a: AccelFn, dt: number): Body {
  const acc = a(b.pos, b.vel, 0);
  const newVel = add(b.vel, scale(acc, dt));
  return {
    pos: add(b.pos, scale(newVel, dt)),     // 关键：用【新】速度
    vel: newVel,
  };
}

// ③ 位置式 Verlet：不存速度，用前后两帧位置推算。约束系统利器
function verlet(pos: Vec3, prevPos: Vec3, a: AccelFn, dt: number): Vec3 {
  const acc = a(pos, pos, 0);
  // x_{n+1} = 2*x_n - x_{n-1} + a*dt²（含隐式阻尼项可加 *(2-d) 系数）
  return add(sub(scale(pos, 2), prevPos), scale(acc, dt * dt));
}

// ④ RK4：4 次斜率加权平均。精度最高，4 倍开销，非辛
function rk4(b: Body, a: AccelFn, dt: number): Body {
  const k1 = a(b.pos, b.vel, 0);
  const k2 = a(add(b.pos, scale(b.vel, dt / 2)), add(b.vel, scale(k1, dt / 2)), dt / 2);
  const k3 = a(add(b.pos, scale(b.vel, dt / 2)), add(b.vel, scale(k2, dt / 2)), dt / 2);
  const k4 = a(add(b.pos, scale(b.vel, dt)), add(b.vel, scale(k3, dt)), dt);
  const newVel = add(b.vel, scale(add(add(k1, scale(k2, 2)), add(scale(k3, 2), k4)), dt / 6));
  const newPos = add(b.pos, scale(b.vel, dt));  // 简化版，完整版应对 pos 也做加权
  return { pos: newPos, vel: newVel };
}
```

**2. 显式 Euler 能量泄漏：为什么弹簧会爆炸**

```
弹簧振子: a = -k*x （k=劲度系数），无阻尼，理论上能量恒定

显式 Euler 每步能量变化 ≈ +k²*x²*dt²/2  （能量单调递增！）
                  ↓
  能量曲线（dt=0.016, k=100）：
  帧 0:  E=1.00  ▓
  帧60:  E=1.18  ▓▓
  帧300: E=4.50  ▓▓▓▓▓
  帧600: E=20.2  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
  → 振子振幅指数增长，最终飞出场景

半隐式 Euler（交换两行顺序）:
  能量在一个周期内小幅振荡，长期有界，永不发散
  帧600: E=1.03  ▓   （仅 3% 漂移，完全可接受）

口诀: "先算速度再用新速度推位置" —— 一行顺序之差，稳定性天壤之别
```

| 积分器 | 精度阶数 | 能量长期行为 | 单步开销 | 是否辛(Symplectic) | 典型游戏用途 |
|--------|---------|-------------|---------|-------------------|-------------|
| 显式 Euler | O(dt) | ❌ 单调发散 | 1× | ❌ | 几乎不用（教学反面） |
| 半隐式 Euler | O(dt) | ✅ 有界振荡 | 1× | ✅ | **刚体/角色默认** |
| Velocity Verlet | O(dt²) | ✅ 有界 | ~2× | ✅ | 分子动力学、高端物理 |
| 位置式 Verlet | O(dt²) | ✅ 有界 | 1× | ✅ | **布料/绳索/软体** |
| RK4 | O(dt⁴) | ⚠️ 缓慢漂移 | 4× | ❌ | 弹道预演、轨道 |

**3. Verlet 约束求解：绳索/布料的核心技巧**

```
Verlet 粒子链（绳索）：节点用位置推算，约束靠"投影修正"

  P0 ── P1 ── P2 ── P3 ── P4     (期望每段长度 = restLen)
   ↑固定

每帧两步：
  ① Verlet 积分：所有节点 pos = 2*pos - prev + gravity*dt²
  ② 约束迭代 N 次（通常 3~10 次）：
     for 每段 (Pi, Pi+1):
       d = distance(Pi, Pi+1)
       diff = (d - restLen) / d
       // 两端各移动一半误差（固定端不移动）
       Pi    -= (Pi    - Pi+1) * 0.5 * diff
       Pi+1  += (Pi    - Pi+1) * 0.5 * diff
```

```typescript
// Verlet 绳索：约束求解比速度积分更关键
class VerletRope {
  points: { pos: Vec3; prev: Vec3; pinned: boolean }[];
  constructor(nodes: Vec3[], private restLen: number) {
    this.points = nodes.map(p => ({ pos: p, prev: p, pinned: false }));
    this.points[0].pinned = true; // 绳头固定
  }
  update(gravity: Vec3, dt: number, iterations = 8) {
    // ① Verlet 积分
    for (const p of this.points) {
      if (p.pinned) continue;
      const vel = sub(p.pos, p.prev);
      p.prev = p.pos;
      p.pos = add(add(p.pos, vel), scale(gravity, dt * dt));
    }
    // ② 约束求解（迭代次数越多绳越硬，但越贵）
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < this.points.length - 1; i++) {
        const a = this.points[i], b = this.points[i + 1];
        const delta = sub(a.pos, b.pos);
        const dist = Math.max(length(delta), 1e-6);
        const diff = (dist - this.restLen) / dist;
        const move = scale(delta, 0.5 * diff);
        if (!a.pinned) a.pos = sub(a.pos, move);
        if (!b.pinned) b.pos = add(b.pos, move);
      }
    }
  }
}
```

### ⚡ 实战经验

- **弹簧相机用显式 Euler 越抖越大**：早期跟随相机写成 `pos += (target - pos) * stiffness`，低帧率（dt=0.033）时 stiffness=15 导致振幅每秒放大 1.4 倍，2 秒后相机甩飞。改成半隐式写法（先更新速度再推位置）后能量有界，又把 stiffness 按帧率归一化 `1 - Math.pow(1 - k, dt * 60)`，30fps 和 144fps 行为一致。
- **轨道运动（行星/绕场）必须用辛积分器**：BOSS 的螺旋弹幕轨迹用显式 Euler 预演，dt=0.02 跑 30 秒后半径从 5 漂到 8.7（+74%），弹幕全飞偏。换成 Velocity Verlet 后 60 秒漂移 < 0.5%，开销只多了约 1.8 倍。
- **布料/旗帜约束迭代次数是性能旋钮**：一件披风 400 节点，约束迭代 3 次时一帧 0.4ms 但会"拉伸"（视觉穿模），迭代 10 次时 1.3ms 太贵。折中 6 次 + 距离约束只解相邻段（不解全连接），降到 0.7ms 且视觉无穿模，整体物理帧预算从 4.1ms 压到 2.3ms。
- **子步长(substep)是稳定性的廉价补丁**：高速碰撞（子弹 200m/s）用单步 dt=0.016 直接穿透薄墙。把物理子步拆成 4 次 dt=0.004 后不再穿模，且因为子步内只跑窄相位检测，整体只多了 35% 开销，比上 CCD 连续碰撞检测便宜得多。
- **RK4 在实时游戏里是奢侈品**：曾对 2000 个粒子的爆炸碎片用 RK4 想要"更真实"，帧时间从 2ms 飙到 9ms 掉到 45fps。粒子的视觉差异肉眼根本看不出（RK4 vs Symplectic Euler 在 0.5s 寿命内位置差 < 2px），果断降回半隐式 Euler。

### 🔗 相关问题

1. 固定步长（fixed timestep）和可变步长对积分器稳定性有什么影响？为什么物理模拟几乎都用固定步长，而渲染用可变 dt？
2. 碰撞响应（冲量解算）应该放在积分的哪一步？位置修正和速度修正的顺序错了会导致"抖动"或"下沉"，怎么解决？
3. 连续碰撞检测（CCD）和子步长（substep）各自解决什么问题？它们的精度和开销如何权衡？
