---
title: "游戏主循环中的渲染/物理/AI/UI 等子系统如何编排更新顺序？"
category: "architecture"
level: 4
tags: ["游戏循环", "子系统拆分", "更新顺序", "帧预算", "多线程", "架构设计"]
related: ["programming/game-loop-fixed-timestep", "architecture/ui-framework", "architecture/ecs-architecture"]
hint: "不是每个子系统越快越好——是更新顺序、依赖图和帧预算分配决定表现的确定性和手感一致性。"
---

## 参考答案

### ✅ 核心要点

1. **经典单帧子系统顺序**：一帧的标准执行流是 Input → Logic → AI → Physics → Animation → Render → Audio → UI。顺序错误的代价是「一帧延迟」——比如先渲染再处理 Input，玩家的按键要等到下一帧才反映在画面上，60fps 下会有 16ms 感知延迟，动作游戏里手感明显发粘。

2. **子系统间存在隐式依赖图**：AI 依赖 Input（读取玩家指令），Physics 依赖 AI 输出的位移意图（力/速度），Animation 依赖 Physics 的位置（根运动落地修正），Render 依赖 Animation 的最终姿态矩阵。编排时必须按依赖拓扑排序，否则会出现「上一帧位置渲染、这一帧逻辑」的视觉错位。

3. **帧预算硬约束**：60fps 意味着每帧 16.67ms 总预算，典型分配是 Render ~6ms、Physics ~3ms、Logic+AI ~3ms、UI+Audio ~2ms、引擎开销+余量 ~2.67ms。任何一个子系统超支就会掉帧，需要用 Profiler 逐子系统监控，而不是只看总帧时间。

4. **逻辑帧率与渲染帧率解耦**：逻辑层（AI/战斗/网络）可以降频到 30Hz 省电省算力，渲染层保持 60fps 用插值平滑视觉。移动端尤其依赖这个策略——30Hz 逻辑 + 60fps 渲染比全 60fps 省约 30% 电量，而玩家视觉上几乎无感知差异。

5. **多线程化拆分（Job System）**：单线程循环到瓶颈后，把 Physics 碰撞检测、Animation 骨骼计算、粒子模拟丢到 Job System 并行执行，主线程只负责依赖严格的 Input/Logic/Render 提交。数据竞争用双缓冲（Double Buffer）隔离——逻辑线程写 buffer A，渲染线程读 buffer B，帧末翻转。

6. **面向接口的子系统注册架构**：成熟的引擎（Unity/Unreal）不把子系统顺序写死在 main() 里，而是用 `ISystem.Update()` 注册表 + priority 字段，支持运行时调整顺序、热插拔子系统。后期加网络插值层时，只需注册一个 InterpolationSystem 并设置 priority 插在 Physics 和 Render 之间，零侵入。

### 📖 深度展开

**1. 单帧子系统更新时序图**

```
帧开始 (Frame N)  ──────────────────────────────────────────────▶ 帧结束
│                                                                 │
│  Input(0.3ms) → Logic(1.5ms) → AI(2.0ms) → Physics(2.5ms)      │
│      │              │             │              │              │
│      │ 读取按键      │ 应用游戏规则  │ 行为树决策    │ 碰撞+刚体   │
│      │ 触摸/手柄     │ 技能/Buff    │ 寻路/仇恨     │ 位置积分    │
│      ▼              ▼             ▼              ▼              │
│  Animation(1.5ms) → Render(5.5ms) → Audio(1.0ms) → UI(0.8ms)   │
│      │                │               │              │          │
│      │ 骨骼矩阵计算    │ DrawCall 提交  │ 3D 音源距离   │ HUD刷新   │
│      │ 根运动修正      │ + 后处理       │ 混合         │ 脏标记重绘│
│      ▼                ▼               ▼              ▼          │
│                                                                 │
│  总计 ~15.1ms（60fps 预算 16.67ms，余量 1.57ms）                  │
└─────────────────────────────────────────────────────────────────┘

  ⚠️ 依赖链（必须按此顺序，否则一帧延迟）：
  Input ──▶ AI ──▶ Physics ──▶ Animation ──▶ Render
  （AI 读 Input，Physics 用 AI 的意图，Render 用 Physics 后的位置）
```

**2. 多线程游戏循环架构（Job System + 双缓冲）**

```typescript
// 面向接口的子系统注册表 —— 顺序可配置，支持热插拔
interface ISystem {
  readonly name: string;
  readonly priority: number;  // 越小越先执行
  update(context: FrameContext): void;
}
class SystemRegistry {
  private systems: ISystem[] = [];
  register(sys: ISystemModule): void {
    this.systems.push(sys);
    this.systems.sort((a, b) => a.priority - b.priority);
  }
  updateAll(ctx: FrameContext): void {
    for (const sys of this.systems) sys.update(ctx);
  }
}
// 多线程化：把可并行的 Physics/Animation 派发到 Job 队列
class ParallelPhysicsSystem implements ISystem {
  readonly name = "Physics";
  readonly priority = 30;
  update(ctx: FrameContext): void {
    // 将 N 个刚体的碰撞检测切分成 Job，丢入线程池并行
    const jobs = this.splitColliders(ctx.entities, 8); // 8 线程
    ctx.jobScheduler.dispatch(jobs); // 非阻塞派发
    ctx.jobScheduler.waitAll();      // 等待本帧物理 Job 全部完成
  }
  private splitColliders(_e: unknown[], _n: number): Job[] { return []; }
}
```

```
多线程帧循环（主线程协调 + Job 工作线程）：

  主线程:  Input → Logic → [派发AI/Physics/Animation Jobs] → 等待 → Render → UI
                                      │                          ▲
                    ┌─────────────────┼──────────────────┐       │
                    ▼                 ▼                  ▼       │
                 Job线程1          Job线程2           Job线程3    │
                 (刚体A-H)         (刚体I-P)         (骨骼计算)   │
                    │                 │                  │       │
                    └─────────────────┴──────────────────┘       │
                                      ▼                          │
                              双缓冲翻转：逻辑buffer A → 渲染buffer B │
                                      └──────────────────────────┘
  关键：Job 完成前主线程阻塞在 waitAll()，确保 Render 读到一致的数据快照
```

**3. 不同平台的帧预算分配对比**

| 平台/帧率 | 总预算 | Render | Physics | Logic+AI | UI+Audio | 余量 | 策略 |
|-----------|--------|--------|---------|----------|----------|------|------|
| PC 60fps | 16.67ms | 7ms | 3ms | 3ms | 2ms | 1.67ms | 全子系统满频 |
| 主机 60fps | 16.67ms | 6ms | 3ms | 4ms | 2ms | 1.67ms | GPU/CPU 均衡 |
| 移动端 60fps | 16.67ms | 5ms | 2ms | 2ms | 1.5ms | 6.17ms | 逻辑降频30Hz省电 |
| 移动端 30fps | 33.33ms | 12ms | 5ms | 8ms | 3ms | 5.33ms | 低端机兜底帧率 |
| VR 90fps | 11.11ms | 4ms | 2ms | 2ms | 1ms | 2.11ms | 极致并行，ASW插帧 |
| 电竞 144fps | 6.94ms | 3ms | 1ms | 1.5ms | 0.5ms | 0.94ms | 输入延迟优先 |

### ⚡ 实战经验

- **Input 顺序错位导致手感发粘**：一款动作手游把 Input 采集放在 Physics 之后，导致按键到画面响应延迟一帧（16ms），玩家反馈「操作不跟手」。把 Input 移到帧首后，操作延迟感知从 50ms 降到 34ms，好评率显著提升——动作游戏 Input 必须是帧内第一个执行的子系统。
- **AI 与 Physics 串行拖垮帧预算**：1000 个 NPC 的行为树决策耗时 4ms，与 Physics（3ms）串行后 Logic+AI 段达到 7ms，60fps 预算吃紧。拆分成「AI 决策每 2 帧执行一次（分帧）」后，平均每帧 AI 降到 2ms，NPC 行为延迟增加 33ms 但玩家几乎无感知。
- **移动端逻辑降频 UI 不降的坑**：逻辑层降到 30Hz 省电，但 UI 列表滚动也跟着降到 30fps 更新，滚动明显卡顿。正确做法是 UI 交互（滚动/拖拽）保持 60fps 渲染，只有游戏世界逻辑（战斗/AI）降频——UI 和游戏逻辑必须独立帧率控制。
- **子系统顺序硬编码的迁移成本**：自研引擎把 Update 顺序写死在 main() 的 switch 里，后期想加「网络插值层」插在 Physics 和 Render 之间，被迫改核心循环代码、回归测试全部系统。改成 priority 注册表架构后，新系统注册一行代码搞定，迁移成本从 3 天降到半天。
- **Job System 数据竞争的隐蔽 Bug**：Physics Job 并行写 Transform，Render 线程同时读，偶现角色闪烁。根因是没用双缓冲——逻辑帧写 buffer A、渲染帧读 buffer B、帧末原子翻转。引入双缓冲后闪烁消失，代价是 Transform 内存翻倍（10000 个实体约 +480KB，可接受）。

### 🔗 相关问题

1. 固定时间步长（Fixed Timestep）的物理更新和可变帧率的渲染更新如何在同一帧循环中协调？插值的 alpha 是怎么计算的？
2. 如果某个子系统（比如 AI 寻路）偶发超支导致单帧超过预算，应该丢弃这一帧的剩余更新，还是允许螺旋死亡风险？容错策略怎么设计？
3. 移动端多核 CPU（4 大核 + 4 小核）上，Job System 的任务调度应该如何分配大核和小核？哪些子系统适合跑在小核上？
