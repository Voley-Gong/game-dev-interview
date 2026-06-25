---
title: "Clean Architecture / 分层架构在游戏中如何落地？依赖倒置与端口适配器怎么用？"
category: "architecture"
level: 4
tags: ["Clean Architecture", "分层架构", "依赖倒置", "端口适配器", "架构设计", "可维护性"]
related: ["architecture/solid-principles-game", "architecture/dependency-injection-lifecycle", "architecture/module-decoupling-bus-signal"]
hint: "Clean Architecture 不是画几个同心圆就完事——它的核心是「依赖方向永远指向内层」，让战斗规则、经济数值这类核心领域逻辑不依赖 Unity、不依赖网络、不依赖 UI；做不到这点，所谓的分层只是把代码挪了文件夹。"
---

## 参考答案

### ✅ 核心要点

1. **核心思想：依赖方向单向指向内层**：架构分为若干同心层（外→内：基础设施 → 适配器 → 用例 → 领域核心）。内层不知道外层的存在，外层依赖内层的接口。这样领域规则（伤害计算、背包容量判定）成为整个项目最稳定、最可测的核心，引擎、UI、网络这些易变的外层不会污染它。
2. **领域层是纯 C# 逻辑，零引擎依赖**：把"一个角色受击后血量如何变化"写成不引用 `UnityEngine`、不引用 `MonoBehaviour` 的纯 POCO/struct。好处是这段逻辑能在脱离 Unity 的单元测试里、在服务端、在权威校验里复用——一套核心规则，客户端和服务端共享同一份计算。
3. **依赖倒置（DIP）是分层的实现手段**：内层定义接口（如 `IInventoryRepository`、`IDamageSource`），外层实现接口（`UnityInventoryRepository`、`NetworkDamageSource`）。内层只依赖抽象，具体实现通过依赖注入在启动时装配。这就是"控制反转"——不是核心调用引擎，而是引擎适配核心。
4. **端口与适配器（Hexagonal）隔离外部世界**：把所有"与外界交互的边界"（存档读写、网络收发、UI 刷新、配置加载）抽象成「端口」（接口）。核心逻辑只对端口说话，具体用 JSON 存档还是数据库、用 HTTP 还是 WebSocket 由「适配器」实现。换引擎、换协议时只改适配器，核心不动。
5. **游戏里别教条式全盘套用**：游戏对性能敏感，渲染、物理这类强引擎耦合的子系统不适合强行分层（会产生无意义的间接调用开销）。正确做法是"分层与扁平并存"——领域逻辑、业务规则做 Clean 分层；表现层（渲染、动画、特效）保持引擎原生的扁平组织，两者在适配器边界对接。

### 📖 深度展开

**Clean Architecture 的层级与依赖规则：**

```
        ┌─────────────────────────────────────────┐
        │  Infrastructure（基础设施：Unity/网络/存档）│  最外层，依赖所有内层
        │  ┌───────────────────────────────────┐  │
        │  │  Adapters（适配器：UI控制器/网络协议） │  │  实现内层接口
        │  │  ┌─────────────────────────────┐  │  │
        │  │  │  Use Cases（用例：开宝箱/结算）  │  │  │  编排领域对象
        │  │  │  ┌───────────────────────┐  │  │  │
        │  │  │  │  Domain（领域核心）       │  │  │  │  最内层，零外部依赖
        │  │  │  │  伤害公式/背包规则/数值   │  │  │  │  ← 可单测、可服务端复用
        │  │  │  └───────────────────────┘  │  │  │
        │  │  └─────────────────────────────┘  │  │
        │  └───────────────────────────────────┘  │
        └─────────────────────────────────────────┘
  依赖方向：箭头永远向内（外→内）。内层 import 外层 = 架构腐烂的开始
```

**用 DIP + 端口适配器隔离伤害计算（核心代码）：**

```csharp
// ✅ Domain 层：纯逻辑，不引用 UnityEngine。可单测、可服务端复用
public static class DamageCalculator {
    // 纯函数：输入全是值类型/接口，输出确定性结果
    public static float Compute(AttackInfo atk, DefenseInfo def, IDamageModifier modifier) {
        float raw = atk.Power * (1f - def.Reduction);
        return Math.Max(1f, modifier.Apply(raw));   // 暴击/减伤由 modifier 注入
    }
}
public interface IDamageModifier { float Apply(float raw); }  // 端口（扩展点）

// ✅ Adapter 层：把领域结果"翻译"成 Unity 表现
public class UnityDamageView : MonoBehaviour {
    public void OnDamageApplied(DamageResult r) {
        ShowFloatingText(r.Amount);   // 飘字
        PlayHitVfx(r.Position);        // 特效
    }
}

// ✅ Infrastructure 层：端口的具体实现，运行时注入
public class CritModifier : IDamageModifier {            // 暴击适配器
    public float Apply(float raw) => _isCrit ? raw * 2f : raw;
}
// 启动时装配：domain 不关心是暴击还是元素反应，只调 modifier.Apply
```

**分层架构 vs 传统"按功能文件夹"组织的对比：**

| 维度 | 传统文件夹组织（Scripts/Player, /Enemy） | Clean Architecture 分层 |
|------|------------------------------------------|--------------------------|
| 组织依据 | 按游戏实体 | 按依赖方向与职责 |
| 引擎耦合 | 散落各处 | 集中在外层适配器 |
| 核心规则可测 | 需 Mock Unity | ✅ 纯逻辑直接测 |
| 客户端/服务端复用 | 难 | ✅ 共享 Domain 层 |
| 学习成本 | 低 | 高（需理解 DIP） |
| 适用规模 | 小型项目 | 中大型/长生命周期项目 |
| 性能开销 | 无 | 有少量接口调用（热路径需注意） |

### ⚡ 实战经验

- **热路径别无脑上接口抽象**：战斗中每帧、每个子弹的伤害计算如果都走虚函数接口（`IDamageModifier.Apply`），IL2CPP 下虚调用 + 装箱的开销不可忽视。性能敏感的核心循环可以用 struct + 泛型约束（`where T : IDamageModifier` 值类型特化，Unity 的 Burst 友好写法）消除虚调用，或把接口边界放在"每场战斗装配一次"的粒度而非"每次伤害一次"。
- **别让 Domain 层"泄漏"Unity 类型**：最常见的腐烂是 Domain 里悄悄出现了 `Vector3`、`GameObject`——一旦引入，单测就得加载 Unity、服务端就不能复用了。边界铁律：Domain 只用纯数值类型（float/struct）和自定义领域类型，需要引擎类型时用端口转换（如传 `float x, y, z` 而非 `Vector3`，或定义领域自己的 `Position` 值类型）。
- **用例层（Use Case）别变成"上帝服务"**：开宝箱、结算战斗、领邮件各写一个独立 UseCase 类，而非一个 `GameService` 包揽所有。每个 UseCase 只编排它负责的领域对象，启动时按需注入。这样修改"开宝箱"逻辑时不可能误伤"领邮件"，也便于针对性单测。
- **分层的收益在中后期才显现，别在原型期过度设计**：游戏Demo/原型阶段强行 Clean 架构会拖慢迭代。合理节奏：原型期扁平快速验证玩法，玩法确定后、团队规模扩大时再渐进重构——先把"核心数值/规则"抽成纯逻辑层（投入产出比最高），表现层和基础设施层按需逐步分层。

### 🔗 相关问题

1. 如何让同一份 Domain 层逻辑在 Unity 客户端、C# 服务端、甚至 Excel 数值校验工具三处复用？跨程序集引用和接口分发有哪些坑？
2. ECS 架构（数据导向）和 Clean Architecture（依赖导向）是否冲突？DOTS 项目里如何调和"System 处理数据"与"领域核心零依赖"？
3. 端口适配器模式下，如何为存档/网络这些"副作用端口"编写可靠的单元测试？测试替身（Fake/Stub/Mock）的粒度如何把控？
