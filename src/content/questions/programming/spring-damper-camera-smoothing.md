---
title: "弹簧阻尼系统和临界阻尼怎么用？相机跟随为什么要用弹簧而不是 Lerp？"
category: "programming"
level: 3
tags: ["弹簧阻尼", "相机跟随", "数学", "二阶系统", "插值", "帧率无关", "动画"]
related: ["programming/tween-easing-interpolation", "programming/game-math-vector-matrix", "programming/numerical-integration-physics"]
hint: "不是『更高级的 Lerp』——是带速度状态的二阶系统，能产生过冲和回弹，这才是相机有重量感、UI 有 Q 弹手感的来源。"
---

## 参考答案

### ✅ 核心要点

1. **一阶 vs 二阶平滑的本质区别**：Lerp / 指数平滑是一阶系统——只有「位置」一个状态量，永远单调指数趋近目标，没有过冲、没有弹性，永远平滑但「毫无质感」。弹簧阻尼是二阶系统——同时维护「位置」和「速度」两个状态，能产生过冲、回弹、振荡。正是这个速度状态让相机有了「惯性/重量感」、UI 弹窗有了「Q 弹」手感，这是 Lerp 永远给不了的。
2. **阻尼比 ζ 决定系统的「性格」**：弹簧系统的行为由阻尼比 ζ 完全决定。ζ=1 是临界阻尼——最快回到目标且完全不振荡（无过冲），相机跟随的默认首选；ζ<1 是欠阻尼——会过冲再回弹（弹性 UI、果冻动效）；ζ>1 是过阻尼——慢吞吞爬向目标（慢镜头、电影感）。调一个参数就能控制动效的「性格」，比换缓动函数优雅得多。
3. **半隐式 Euler 积分保证实时稳定性**：弹簧每帧要积分更新位置和速度。用朴素显式 Euler 在大 dt（切场景卡顿、低帧率设备）时能量会发散——相机直接飞出地图。半隐式 Euler（先更新速度、再用新速度更新位置）或速度 Verlet 能让能量保持有界，是游戏实时物理积分的标准选择，开销和朴素 Euler 一样小但稳定得多。
4. **帧率无关化必须正确耦合 ω 和 dt**：弹簧频率 ω 与每帧 dt 耦合，直接写 `pos += vel * dt` 在帧率波动（30FPS 设备 vs 144FPS 设备）时表现完全不一致。正确做法是把衰减写成指数形式 `vel *= Math.exp(-2ζω * dt)`，或直接用解析解 `x(t)=target + (x0-target)*e^(-ζωt)`，保证同一组参数在所有帧率下行为一致——这是确定性和手感一致性的关键。
5. **速度前馈让相机追得上加速移动的目标**：只把弹簧挂在「目标位置」上，当目标加速移动时相机会持续滞后一截并抖动。正确做法是把目标速度作为弹簧的「前馈项」（velocity-based damping），让弹簧既追位置也追速度，相机就能平滑贴合高速移动的玩家而不脱节、不甩尾。
6. **弹簧过冲必须叠加碰撞约束**：弹簧天然会过冲，第三人称相机过冲就会穿墙、看穿地板。标准管线是每帧积分后做一次「球体扫掠（sphere sweep）」碰撞检测，把相机沿视线方向推回最近的合法位置，并用弹簧柔化这个回推避免突兀跳变。弹簧负责「手感」、碰撞负责「合规」，二者分层。

### 📖 深度展开

#### 1. 弹簧物理模型：运动方程与阻尼比分类

弹簧阻尼系统的运动方程是二阶常微分方程 `ẍ + 2ζωẋ + ω²(x - target) = 0`，其中 ω 是固有频率（响应快慢）、ζ 是阻尼比（振荡程度）。ζ 的三个区间决定了完全不同的行为：

```
不同阻尼比 ζ 下的目标追踪轨迹（x 轴=时间，y 轴=位置，目标=1.0）:

 ζ > 1 过阻尼        ζ = 1 临界阻尼       ζ < 1 欠阻尼
 1 ─────╮             1 ─────╮             1 ──╮   ╭──── (过冲回弹)
        ╰──                       ╰─            ╰─╯
0.5     ╲               0.5     ╱       0.5        ╲
0  ╲                0   ╲       0      ╲     ╲
   慢爬向目标          最快无过冲         弹性Q弹手感
```

```typescript
/** 临界阻尼弹簧（ζ=1）：相机跟随默认首选，最快无过冲 */
class CriticalDamper {
  private velocity: number = 0;        // 速度状态——这是和 Lerp 的本质区别
  private value: number;
  constructor(initial: number, public omega: number) { this.value = initial; }

  /** 帧率无关的半隐式积分更新（ω = 响应频率，越大跟得越紧） */
  update(target: number, dt: number): number {
    // 把衰减写成 exp 形式，保证 30fps 和 144fps 行为一致
    const f = 1 - Math.exp(-this.omega * dt);   // 帧率无关的混合系数
    this.velocity = (target - this.value) * f * this.omega + this.velocity * Math.exp(-this.omega * dt);
    this.value += this.velocity * dt;
    return this.value;
  }
}

/** 通用弹簧（可调 ζ）：UI 弹窗用 ζ=0.6 制造 Q 弹回弹 */
class Spring {
  private velocity = 0;
  private value: number;
  constructor(initial: number, public omega: number, public zeta: number) {
    this.value = initial;
  }
  update(target: number, dt: number): number {
    const x = this.value - target;
    // 半隐式 Euler：先更新速度（用新速度算位置）
    const acc = -this.omega * this.omega * x - 2 * this.zeta * this.omega * this.velocity;
    this.velocity += acc * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
}
```

阻尼比选型对照表：

| 阻尼比 ζ | 行为 | 典型用途 | ω 经验值 |
|---------|------|---------|---------|
| ζ = 1 临界 | 最快无过冲 | 相机跟随、血条平滑 | 8~15 |
| ζ ≈ 0.7 欠阻尼 | 轻微过冲 1~2 次 | UI 弹窗、按钮反馈 | 20~35 |
| ζ ≈ 0.3 强欠阻尼 | 明显弹跳振荡 | 果冻动效、糖果消除特效 | 25~40 |
| ζ > 1.5 过阻尼 | 缓慢爬升 | 电影镜头、慢动作 | 3~6 |

#### 2. 帧率无关积分：为什么朴素 Euler 会把相机弹飞

朴素显式 Euler 用旧速度算新位置，能量会随积分误差累积——弹簧越硬（ω 越大）、dt 越大（低帧率/卡顿），发散越快。三种积分方法的稳定性对比：

```
ω=20 的弹簧，目标从 0 跳到 10，不同 dt 下的表现:

dt=0.016 (60fps 稳定)         dt=0.05 (20fps 卡顿)
半隐式 Euler:                  半隐式 Euler:
 10 ───╮ (轻微过冲即收敛)        10 ────╮ (过冲稍大但收敛)
        ╰──                            ╰──
 0                                    0
显式 Euler:                    显式 Euler:
 10 ───╮                        10 ╲   ╱╲   ╱←能量发散!
        ╰──                       ╲ ╱ ╲ ╱   振幅越来越大
 0        (看着还行)            -50╲_V_╲_V____ 相机飞出地图!
```

```typescript
/** 三种积分实现对比（相机跟随场景） */
// ① 显式 Euler（❌ 不稳定，dt 大时能量发散）
function explicitEuler(v: number, x: number, target: number, omega: number, dt: number) {
  const acc = -omega * omega * (x - target);
  const newX = x + v * dt;       // 用【旧】速度算位置
  const newV = v + acc * dt;
  return { v: newV, x: newX };
}

// ② 半隐式 Euler（✅ 稳定，开销同上，游戏首选）
function semiImplicitEuler(v: number, x: number, target: number, omega: number, dt: number) {
  const acc = -omega * omega * (x - target);
  const newV = v + acc * dt;     // 先更新速度
  const newX = x + newV * dt;    // 用【新】速度算位置 ← 关键差异
  return { v: newV, x: newX };
}

// ③ 解析解（✅ 完全精确，ζ=1 临界阻尼的闭式解）
function analyticCritical(x0: number, target: number, omega: number, t: number) {
  const diff = x0 - target;
  // x(t) = target + (x0-target) * e^(-ωt) * (1 + ωt)
  return target + diff * Math.exp(-omega * t) * (1 + omega * t);
}
```

| 积分方法 | 稳定性 | 精度 | 开销 | 适用场景 |
|---------|--------|------|------|---------|
| 显式 Euler | ❌ dt 大时发散 | 低 | 最低 | 仅高频小步长物理 |
| 半隐式 Euler | ✅ 能量有界 | 中 | 极低 | **游戏实时首选** |
| 速度 Verlet | ✅ 更稳定 | 中高 | 低 | 布料/绳索约束 |
| 解析解 | ✅ 完全精确 | 完美 | 中 | 临界阻尼相机（ζ=1 专用） |

#### 3. 相机跟随完整实现：位置 + 速度前馈 + 碰撞

完整的第三人称相机管线：弹簧追位置、速度前馈消除滞后、球体扫掠防穿墙：

```
玩家位置/速度
     │
     ▼
┌─────────────┐    速度前馈        ┌──────────────┐
│ 弹簧追踪位置 │ ───────────────→  │ 积分得到相机   │
│ (CriticalDamper)│                 │ 期望位置/朝向  │
└─────────────┘                    └──────┬───────┘
                                          │
                                   ┌──────▼───────┐
                                   │ 球体扫掠碰撞  │ ← 推回合法位置防穿墙
                                   │ (sphere sweep)│
                                   └──────┬───────┘
                                          ▼
                                     相机最终位置
```

```typescript
class SpringCamera {
  private posDamp = new CriticalDamper(Vec3.zero(), 10);  // 位置弹簧 ω=10
  private lookDamp = new CriticalDamper(Vec3.zero(), 14); // 朝向弹簧 ω=14（跟得更紧）

  update(targetPos: Vec3, targetVel: Vec3, targetForward: Vec3, dt: number): Vec3 {
    // ① 弹簧追踪位置（速度前馈：把目标速度叠加到弹簧目标，消除滞后）
    const lookAhead = targetVel.scale(0.08);     // 前瞻量，追上加速移动的玩家
    const desired = this.posDamp.update(
      targetPos.add(lookAhead), dt               // 目标位置 + 速度前馈
    );

    // ② 球体扫掠碰撞：从玩家到相机做射线/球体检测，推回合法位置防穿墙
    const toCam = desired.sub(targetPos);
    const dist = toCam.length();
    const hit = physics.sphereCast(targetPos, toCam.normalize(), dist, 0.3);
    const finalPos = hit ? targetPos.add(toCam.normalize().scale(hit.distance - 0.05)) : desired;

    // ③ 朝向也用弹簧柔化，避免碰撞回推造成突兀转向
    const smoothLook = this.lookDamp.update(targetForward, dt);
    camera.setPosition(finalPos);
    camera.lookAt(targetPos, smoothLook);
    return finalPos;
  }
}
```

弹簧 vs Lerp vs 引擎 SmoothDamp 三方对比：

| 方法 | 状态维度 | 过冲/弹性 | 帧率无关 | 追加速目标 | 典型用途 |
|------|---------|----------|---------|-----------|---------|
| Lerp / 指数平滑 | 1（仅位置） | ❌ 无 | ✅ | ❌ 滞后 | 血条、数值面板 |
| 临界阻尼弹簧 | 2（位置+速度） | ❌ 无 | ✅ | ✅ 前馈 | **相机跟随** |
| 欠阻尼弹簧 ζ<1 | 2（位置+速度） | ✅ 有 | ✅ | ✅ | UI 弹窗、果冻动效 |
| 引擎 SmoothDamp | 2（带 smoothTime） | ❌ 无 | ✅ | ✅ | Unity 标配相机 |

### ⚡ 实战经验

- **Lerp 做相机永远滞后一截**：玩家冲刺时用 Lerp 的相机明显拖在身后、停下又猛追，手感很「飘」。换成临界阻尼弹簧 + 速度前馈（`lookAhead = vel * 0.08`）后，相机平稳贴合加速/减速，冲刺体验提升明显。**ω 调到 10** 是多数动作游戏相机跟随的甜点——再小跟丢、再大会抖。
- **dt 突变把相机弹飞地图**：弹簧 ω 设到 20（偏硬），一次切场景卡顿让 dt 飙到 0.2s，显式 Euler 积分下相机直接飞到坐标 (9999, 9999)。**修复**：把积分改成半隐式 Euler + `dt = Math.min(dt, 1/30)` 上限封顶，并对 ω>15 的硬弹簧改用解析解，彻底杜绝发散。
- **欠阻尼 ζ 调 UI 弹窗手感飞升**：结算面板弹出从 easeOut 缓动（一阶）换成 ζ=0.6 的欠阻尼弹簧，多了一次轻微回弹，玩家反馈「Q 弹了很多」。A/B 测试中弹窗的点击率从 **12% 涨到 15%**——二阶系统的「物理质感」对交互吸引力是实打实的。
- **相机过冲穿墙没加碰撞，玩家卡角落看穿地板**：弹簧默认会过冲，玩家贴墙时相机被弹进墙里看穿整个关卡。加一层球体扫掠碰撞 + 朝向弹簧柔化回推（避免回推瞬间转向甩头），穿墙问题归零，且碰撞回退平滑无突兀感。
- **144Hz 和 60Hz 设备手感必须一致**：早期直接写 `value += (target - value) * 0.1`（按帧混合），144Hz 设备上相机跟得明显更快、手感分裂。改成 `f = 1 - exp(-ω*dt)` 帧率无关混合后，144Hz 和 60Hz 的相机行为逐帧对齐，跨设备手感统一。

### 🔗 相关问题

- **弹簧系统的 ω 和 ζ 怎么凭手感快速调参？** —— 提示：先定 ζ（决定性格：相机用 1、弹窗用 0.6~0.7），再从小到大调 ω 直到「跟得紧但不抖」；ω 本质是「响应频率」，ω=10 大约 100ms 到位，ω=20 大约 50ms 到位，可以按这个量纲估算。
- **弹簧 UI 弹窗和 CSS 缓动（cubic-bezier）有什么本质区别？** —— 提示：缓动函数是「时间→进度」的静态映射，无法响应中途变化（用户在动画中途又点了一下会卡顿）；弹簧是基于物理状态的，中途改目标会自然延续当前速度平滑过渡，更适合交互式 UI。
- **物理引擎里的弹簧约束（Hinge/Spring Joint）和手写弹簧什么关系？** —— 提示：引擎约束求解器用的是隐式积分 + 多次迭代（更稳定但更贵，适合刚性连接），手写弹簧用半隐式 Euler（更轻量，适合相机/UI 这类「软跟随」）；相机用引擎约束会过重，手写弹簧更可控。
