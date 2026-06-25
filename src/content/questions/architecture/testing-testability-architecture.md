---
title: "如何让游戏代码变得可测试？确定性测试与依赖接缝（Seam）怎么做？"
category: "architecture"
level: 3
tags: ["测试", "可测试性", "确定性", "单元测试", "依赖注入", "架构设计"]
related: ["architecture/layered-clean-architecture-game", "architecture/dependency-injection-lifecycle", "architecture/solid-principles-game"]
hint: "游戏难测试不是因为'游戏特殊'，而是因为代码把时间、随机、输入、Unity 引擎直接硬编码进了逻辑里——把它们抽成可注入的接口（接缝），逻辑就能脱离引擎在毫秒级跑完上万次确定性测试，这是回归测试和录像回放的基础。"
---

## 参考答案

### ✅ 核心要点

1. **可测试性的本质是「消除隐藏依赖」**：逻辑里直接调 `Time.deltaTime`、`Random.Range`、`Input.GetKey`、`UnityEngine.Physics`，就把这段代码焊死在了 Unity 运行环境上，无法脱离编辑器单测。解决方法是把它们抽成接口/参数（接缝 Seam），让测试可以注入受控的替身。
2. **确定性（Determinism）是游戏测试的最高价值**：相同输入永远产生相同输出。一旦战斗逻辑是确定性的（固定种子 RNG、固定步长更新、纯函数伤害计算），就能写"输入序列 → 期望状态"的回归测试，还能支持录像回放、帧同步调试、AI 自我对弈。非确定性逻辑几乎无法做可靠的自动化回归。
3. **测试金字塔在游戏里要变形**：底层是大量纯逻辑单元测试（伤害公式、背包规则、经济结算——毫秒级、无引擎）；中层是集成测试（装配几个系统，跑几帧逻辑）；顶层是少量端到端测试（跑完整场景/战斗，秒级）。游戏特殊在于顶层自动化极难（需要渲染/输入），所以更要压厚底层。
4. **依赖接缝的三种注入方式**：① 构造函数注入（`new BattleSystem(rng, clock)`，最利于测试）；② 服务定位器/接口注入（运行时单例，测试替换实现）；③ 参数注入（把 `deltaTime`、`randomSeed` 直接作为方法参数）。纯函数优先用参数注入，有状态系统用构造注入。
5. **测试不该依赖渲染和真实时间**：好测试在纯 .NET 环境（无 Unity）里跑，用"虚拟时钟"控制时间流逝、用"种子 RNG"复现随机、用"假输入"模拟操作。能在 CI 上每秒跑上千个、不卡顿、不闪烁——这样的测试才会被团队真正持续运行。

### 📖 深度展开

**不可测 vs 可测的对比（时间/随机/输入接缝）：**

```
❌ 不可测（隐藏依赖焊死在 Unity 上）：
  void Update() {
      transform.position += _vel * Time.deltaTime;        // 真实时间，难控制
      if (Random.value < 0.2f) Crit();                     // 真随机，结果飘忽
      if (Input.GetKeyDown(KeyCode.Space)) Jump();         // 真输入，自动化困难
  }
  → 必须在 Unity 编辑器手动跑，无法 CI，改一下数值不知是否回归

✅ 可测（接缝抽离，纯逻辑可注入）：
  public void Tick(float dt, IRng rng, IInput input) {     // dt/rng/input 全是参数
      _pos += _vel * dt;                                   // 用注入的虚拟时间
      if (rng.NextFloat() < 0.2f) Crit();                  // 种子 RNG，结果固定
      if (input.IsPressed(Action.Jump)) Jump();            // 假输入
  }
  → 脱离引擎、毫秒级、确定性、可批量回归
```

**确定性伤害计算 + 回归测试（核心代码）：**

```csharp
// ✅ 纯函数 + 注入 RNG：完全确定，可脱离 Unity 测试
public class DamageCalculator {
    private readonly IRng _rng;
    public DamageCalculator(IRng rng) => _rng = rng;        // 构造注入

    public DamageResult Resolve(AttackInfo atk, DefenseInfo def) {
        bool isCrit = _rng.NextFloat() < atk.CritRate;      // 种子可控
        float raw = atk.Power * (1f - def.Reduction);
        float final = isCrit ? raw * atk.CritDamage : raw;
        return new DamageResult(final, isCrit);
    }
}

// 测试替身：固定序列的假 RNG，让随机变成"可预测"
public class FakeRng : IRng {
    private readonly Queue<float> _values;
    public FakeRng(params float[] seq) => _values = new(seq);
    public float NextFloat() => _values.Dequeue();
}

// ✅ 纯单元测试：无引擎、确定性、毫秒级，CI 可跑上万次
[Test]
public void Crit_WhenRngBelowCritRate_DealsDoubleDamage() {
    var calc = new DamageCalculator(new FakeRng(0.1f));     // 0.1 < 0.25 必定暴击
    var atk = new AttackInfo(Power: 100, CritRate: 0.25f, CritDamage: 2f);
    var def = new DefenseInfo(Reduction: 0f);

    var result = calc.Resolve(atk, def);

    Assert.AreEqual(200f, result.Amount);                   // 100 × 2
    Assert.IsTrue(result.IsCrit);
}
```

**接缝注入方式的取舍：**

| 注入方式 | 写法 | 适用 | 测试友好度 |
|----------|------|------|------------|
| 参数注入 | `Tick(dt, rng)` | 纯函数、无状态工具 | ✅ 最高 |
| 构造注入 | `new Sys(rng, clock)` | 有状态系统、领域服务 | ✅ 高 |
| 接口/服务定位 | `Service.Get<IClock>()` | 跨系统共享设施 | ⚠️ 中（需替换全局） |
| 静态/单例硬编码 | `Time.deltaTime` | ⚠️ 反模式 | ❌ 最低 |

### ⚡ 实战经验

- **"先把核心数值规则抽成纯函数"是投入产出比最高的第一步**：不要一上来就想测整个战斗系统。优先把伤害公式、概率结算、经济收支、属性聚合这些「纯计算」抽成无副作用的静态方法或纯类，配测试替身 RNG——这部分占 bug 的大头，却最容易测，几十行测试能覆盖几千种数值组合的边界（满血、溢出、负数、除零）。
- **录像回放是最好的端到端回归测试**：让战斗逻辑确定性化后，记录每帧的输入序列到文件，测试时回放输入并断言关键帧的状态（血量、位置、死亡时序）。一次录制能反复回归，改完代码跑一遍就知道有没有破坏旧行为。关键前提：RNG 用固定种子、更新用固定步长（FixedTimestep）、禁止逻辑读系统时钟。
- **别测试表现层，测行为契约**：给动画播放、特效生成、UI 刷新写断言极其脆弱（依赖渲染、易闪烁）。正确做法是测「是否调用了正确的接口/事件」（如 `Assert.IsTrue(mockVfx.PlayHitCalled)`），表现层用 Mock 验证调用契约，真实渲染交给人工/QA。表现层 bug 用截图对比、自动化点击等专门手段，不混进逻辑测试套件。
- **测试必须能在 CI 无头环境跑，否则等于没写**：依赖 `[UnityTest]`、必须打开编辑器、必须加载场景的测试执行慢、易失败，CI 一卡团队就会跳过。理想架构让 80% 的测试是纯 .NET 单元测试（NUnit/xUnit，秒级万次），只有 20% 是 `[UnityTest]` 集成测试。这倒逼你把逻辑与引擎解耦——可测性本身就是好架构的度量尺。

### 🔗 相关问题

1. 帧同步（Lockstep）游戏如何利用确定性做"同步测试"——为什么浮点数会破坏确定性？用定点数替代 float 有哪些工程代价？
2. 如何为一个已有的、大量耦合 Unity 的老项目引入单元测试？哪些接缝优先抽、哪些先放过，渐进式改造的策略是什么？
3. 游戏的"快照测试（Snapshot Testing）"——把战斗序列状态序列化成 JSON 做基线比对，相比传统断言有哪些优劣？误报如何治理？
