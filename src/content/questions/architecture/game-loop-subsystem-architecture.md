---
title: "游戏主循环（Game Loop）如何设计？固定时间步与子系统拆分的顺序有何讲究？"
category: "architecture"
level: 3
tags: ["游戏循环", "Game Loop", "固定时间步", "Fixed Timestep", "子系统", "帧率独立", "架构设计"]
related: ["architecture/multithreading-job-system-architecture", "architecture/ecs-architecture", "architecture/timer-scheduler-architecture"]
hint: "渲染用可变步长追求流畅，物理用固定步长保证确定性——两者靠累加器（Accumulator）解耦。子系统更新顺序写错会导致相机抖动、UI 滞后一帧等诡异 bug，Unity 的 FixedUpdate/Update/LateUpdate 正是这个模式的引擎封装。"
---

## 参考答案

### ✅ 核心要点

1. **游戏主循环 = 输入 → 更新 → 渲染，周而复始**：每一帧依次处理用户输入、推进逻辑状态、提交渲染命令。与 Web/应用的"事件等待"模型本质不同——游戏是**主动轮询驱动**，即使无输入也每帧 tick，这是实时交互和动画的基础。
2. **物理必须用固定时间步（Fixed Timestep）保证确定性与稳定**：物理积分对步长敏感，可变步长会导致碰撞穿透、叠堆抖动、网络同步不一致。固定 60Hz（1/60 秒）更新物理，无论渲染帧率多少，模拟步长恒定——这是帧率独立的核心。
3. **累加器模式解耦渲染帧率与物理步长**：每帧用真实流逝时间喂给累加器，累加器每攒满一个固定步长就跑一次物理 tick，剩余的小数部分用于**插值渲染**。这样 144Hz 显示器和 30Hz 低端机跑出相同的物理结果，只是渲染平滑度不同。
4. **子系统更新顺序有严格依赖**：典型顺序是 输入 → AI → 物理 → 游戏逻辑 → 动画 → UI → 相机 → 渲染。相机必须在所有运动计算之后更新（否则用上一帧位置渲染导致抖动），UI 在逻辑之后刷新避免显示脏数据。顺序写反是"相机抖动""飘字滞后"的常见根因。
5. **警惕死亡螺旋（Spiral of Death）**：当单帧计算耗时超过固定步长时，累加器会堆积越来越多的待执行 tick，下一帧要补跑更多物理，雪崩式卡死。对策是对 frameTime 设上限（如钳制到 0.25 秒），宁可丢物理精度也不让模拟追不上实时。

### 📖 深度展开

**经典固定时间步主循环（"Fix Your Timestep" 模式）：**

```
渲染帧（可变步长，追求流畅）          物理步（固定 1/60s，保证确定性）
┌─────────────────────┐           ┌──────────────────┐
│ 1. 读取真实流逝时间   │           │ while(accum≥dt): │
│ 2. 累加到 accumulator │──────────→│   processInput() │
│ 3. 攒满就跑物理 tick  │           │   fixedUpdate(dt)│
│ 4. 剩余 alpha 插值渲染 │           │   accum -= dt    │
└─────────────────────┘           └──────────────────┘
```

```csharp
const double FIXED_DT = 1.0 / 60.0;   // 物理固定 60Hz
double _accumulator = 0;
double _currentTime = GetTimeMs();

void GameLoop() {
    double newTime = GetTimeMs();
    double frameTime = (newTime - _currentTime) / 1000.0;
    _currentTime = newTime;

    // ⚠ 钳制帧时间，防止卡顿后累加器爆炸（死亡螺旋防护）
    if (frameTime > 0.25) frameTime = 0.25;

    _accumulator += frameTime;

    // 固定步长跑物理 + 逻辑（可能一帧跑多次，也可能跳过）
    while (_accumulator >= FIXED_DT) {
        ProcessInput();
        FixedUpdate((float)FIXED_DT);   // 物理、AI、游戏逻辑
        _accumulator -= FIXED_DT;
    }

    // 插值因子：上一物理状态 → 当前，避免 144Hz 渲染时画面"阶梯感"
    double alpha = _accumulator / FIXED_DT;
    Render((float)alpha);   // 渲染时用 prev + (cur - prev) * alpha 插值
}
```

**为什么渲染要插值？** 若物理只跑 60Hz 而渲染 144Hz，不插值的话画面会出现"停顿-跳变"的阶梯感。用上一帧物理状态和本帧状态按 `alpha` 线性插值，渲染对象的位置就平滑过渡。代价是要存两份状态（prev/current），但换来肉眼可见的流畅度。

**子系统更新顺序及其依赖原因：**

```
每帧执行顺序（关键依赖链）：
  ┌─ Input        ← 最早，捕获本帧输入
  ├─ AI/决策      ← 依赖输入生成指令
  ├─ Physics      ← 固定步长，推进刚体/碰撞
  ├─ GameLogic    ← 处理碰撞结果、伤害结算
  ├─ Animation    ← 根据逻辑状态切换动画
  ├─ VFX/Audio    ← 跟随逻辑事件触发
  ├─ UI           ← 刷新 HUD，读最新逻辑数据
  ├─ Camera       ← 必须在所有运动之后！否则用旧位置渲染→抖动
  └─ Render       ← 最后提交 GPU
```

**Unity 生命周期与该模式的对应：**

| 概念 | 引擎封装 | 触发频率 | 用途 |
|------|----------|----------|------|
| 固定物理步 | `FixedUpdate` | 固定间隔（默认 0.02s） | 刚体、物理模拟 |
| 可变逻辑帧 | `Update` | 每渲染帧 | 输入、AI、计时 |
| 后处理帧 | `LateUpdate` | Update 全部完成后 | 相机跟随、后处理逻辑 |
| 渲染提交 | 内部渲染循环 | 每帧末 | 上屏 |

Unity 把"累加器跑 FixedUpdate"封装好了，但**`Update` 里调用 `Time.deltaTime` 是可变值**，新手误用它做物理积分会导致不同帧率下行为不一致——物理相关逻辑必须放 `FixedUpdate` 用 `Time.fixedDeltaTime`。

### ⚡ 实战经验

- **相机跟随务必放 LateUpdate，否则必定抖动**：相机在 `Update` 里读角色位置，但角色可能在同一帧的物理/动画中还在移动，相机用到了中间态位置渲染就产生 1 像素抖动。铁律：所有运动计算完成后再更新相机（LateUpdate），渲染时角色和相机处于同一最终状态。这是 Unity 最常见的"画面抖动"根因，排查时第一反应就是查相机更新时机。
- **`Time.deltaTime` 和 `Time.fixedDeltaTime` 别混用**：`Update` 里用 `fixedDeltaTime`、`FixedUpdate` 里用 `deltaTime` 都会导致速度计算错误。更隐蔽的是跨平台时帧率不同（PC 144fps vs 手机 30fps），用错时间步会让角色移动速度差 4 倍。建议封装统一的 `GetStepDt()` 按上下文返回正确值，并在 CI 里写帧率差异的自动化测试。
- **死亡螺旋的真实场景：加载卡顿 + 物理追帧**：切换场景时主线程卡了 800ms，恢复后累加器要补跑 ~50 次物理 tick，又卡住……恶性循环。除了钳制 frameTime，更彻底的方案是在 Loading 期间暂停主循环或重置累加器。网络同步游戏尤其要注意——服务端追帧会导致客户端预测和服务器纠正大幅偏离，表现为"瞬移回滚"。
- **多线程下别在 Job 里直接读主循环状态**：Unity Job System 的物理 Job 在固定步并行跑，但它读的 Transform/逻辑状态是帧初快照。若主线程在 Job 执行期间改了状态会产生竞态。正确做法：主循环收集本帧输入生成指令 → Job 消费快照并行计算 → 同步点合并结果，严格按照"收集-并行-合并"的阶段划分，别在 Job 里做跨系统副作用。

### 🔗 相关问题

1. 固定时间步下如何实现"慢动作"和"子弹时间"效果？是缩放 FIXED_DT 还是用 Time.timeScale？对物理确定性和网络同步有什么影响？
2. 网络游戏（如帧同步/锁步）如何保证所有客户端的物理模拟完全一致？固定步长之外还需要哪些确定性保证（浮点、容器遍历顺序）？
3. 子系统拆分后，如何用"子系统优先级 + 依赖图"自动推导正确的更新顺序，而不是手动维护一个硬编码的调用序列？
