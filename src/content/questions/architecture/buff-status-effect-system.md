---
title: "如何设计一个可扩展的 Buff/状态效果系统？"
category: "architecture"
level: 3
tags: ["Buff系统", "状态效果", "游戏系统设计", "Modifier", "架构设计"]
related: ["architecture/skill-system", "architecture/fsm-behavior-tree", "architecture/combat-system-architecture"]
hint: "Buff 不只是加减数值——叠加规则、优先级、互斥/覆盖、周期触发、事件钩子，一个健壮的 Buff 系统是 RPG 战斗的脊梁。"
---

## 参考答案

### ✅ 核心要点

1. **Buff 数据与逻辑分离**：BuffDefinition（配置/静态数据）+ BuffInstance（运行时实例/剩余时间/层数）
2. **Modifier 修饰器模型**：所有数值变更抽象为 Modifier（加法/乘法/百分比/最终覆盖），按优先级有序应用
3. **叠加规则引擎**：同 ID 的 Buff 再次施加时，按策略处理（刷新时间/叠加层数/取最高/互斥替换）
4. **事件驱动的生命周期**：OnApply → OnTick → OnRemove，配合事件钩子实现触发型效果
5. **Buff 容器统一管理**：角色身上的 BuffContainer 负责增删、遍历更新、过期清理

### 📖 深度展开

**Buff 系统整体架构：**

```
BuffConfig（配置表/ScriptableObject）
  ↓ 实例化
BuffInstance（运行时实例）
  ├── remainingTime（剩余时间）
  ├── stackCount（当前层数）
  └── modifiers[]（修饰器列表）
  ↓ 挂载到
BuffContainer（角色身上的 Buff 容器）
  ├── AddBuff()     ← 施加
  ├── RemoveBuff()  ← 移除
  ├── Update(dt)    ← 每帧 Tick / 过期清理
  └── 事件回调：OnApply / OnTick / OnRemove / OnStack
  ↓ 作用于
AttributeSystem（属性系统：攻击/防御/速度...）
```

**核心代码实现（C#）：**

```csharp
// —— Modifier：数值修饰的最小单元 ——
public enum ModifierType { Add, Mul, FinalOverride }

public struct Modifier {
    public string Attribute;   // 目标属性 "Attack"/"Speed"
    public ModifierType Type;
    public float Value;
    public int Priority;       // 同属性多修饰器的执行顺序
}

// —— Buff 配置（静态数据，从配置表加载）——
public class BuffConfig {
    public int Id;
    public string Name;
    public float Duration;         // -1 = 永久
    public int MaxStack;           // 最大叠加层数
    public StackPolicy StackPolicy; // Refresh / Stack / HigherOverwrites
    public Modifier[] Modifiers;
    public float TickInterval;     // 周期触发间隔（毒/回血）
}

// —— Buff 运行时实例 ——
public class BuffInstance {
    public BuffConfig Config;
    public float RemainingTime;
    public int Stack;
    public float TickTimer;
    public GameObject Source;     // 施加者（用于仇恨/击杀归属）
}

// —— Buff 容器（挂在角色身上）——
public class BuffContainer {
    private readonly List<BuffInstance> buffs = new();
    private AttributeSystem attributes;

    public void AddBuff(BuffConfig config, GameObject source) {
        var existing = buffs.Find(b => b.Config.Id == config.Id);
        if (existing != null) {
            ApplyStackPolicy(existing, config);  // 叠加/刷新/替换
        } else {
            var inst = new BuffInstance {
                Config = config, RemainingTime = config.Duration,
                Stack = 1, Source = source
            };
            buffs.Add(inst);
            ApplyModifiers(inst, add: true);      // 立即生效
            EventBus.Emit(new BuffAppliedEvent(inst));
        }
    }

    public void Update(float dt) {
        for (int i = buffs.Count - 1; i >= 0; i--) {
            var b = buffs[i];
            // 周期触发（如每秒掉血）
            if (b.Config.TickInterval > 0) {
                b.TickTimer -= dt;
                if (b.TickTimer <= 0) {
                    b.TickTimer = b.Config.TickInterval;
                    EventBus.Emit(new BuffTickEvent(b));
                }
            }
            // 倒计时 & 过期移除
            if (b.Config.Duration > 0) {
                b.RemainingTime -= dt;
                if (b.RemainingTime <= 0) RemoveBuffAt(i);
            }
        }
    }

    private void ApplyStackPolicy(BuffInstance existing, BuffConfig cfg) {
        switch (cfg.StackPolicy) {
            case StackPolicy.Refresh:
                existing.RemainingTime = cfg.Duration; break;
            case StackPolicy.Stack:
                if (existing.Stack < cfg.MaxStack) existing.Stack++;
                existing.RemainingTime = cfg.Duration; break;
            case StackPolicy.HigherOverwrites:
                /* 比较强度，更强则替换 */ break;
        }
    }
}
```

**Modifier 计算顺序（关键陷阱）：**

```
基础值 Base = 100

依次应用（按 Priority 排序）：
  1. Add（加法优先）：  +20  →  120
  2. Add：             +10  →  130
  3. Mul（乘法其次）：  ×1.5 →  195
  4. Mul：             ×0.8 →  156
  5. FinalOverride（最终覆盖，最高优先）：= 200

最终值 = 200（而非随意顺序算出的乱七八糟的数）
```

> **规则：加法 → 乘法 → 最终覆盖**，同类内按 Priority 排序。乱序会导致同样的 Buff 组合产生不同结果。

**叠加策略对比：**

| 策略 | 行为 | 典型场景 |
|------|------|----------|
| Refresh | 刷新持续时间，不叠层 | 燃烧 Debuff 持续续杯 |
| Stack | 叠加层数，叠满封顶 | 毒药叠 5 层 |
| HigherOverwrites | 新的更强则替换 | 等级高的增益覆盖低的 |
| MutualExclusive | 互斥，只能存在一个 | 火盾/冰盾不能共存 |

### ⚡ 实战经验

- **Modifier 计算顺序必须严格定义**：加法、乘法、最终覆盖的顺序不固定是数值 Bug 的头号来源——写死顺序并文档化
- **层数和强度分开配置**：`MaxStack=5` 不代表效果自动 ×5，每层的 Modifier 由配置决定（可能第 3 层就封顶效果），别偷懒让层数直接乘数值
- **Buff 移除时务必反向还原**：施加时加的属性，移除时要精确减回去；用「重新计算全部属性」的方式比「增量还原」更安全，不会累积浮点误差
- **免疫/驱散要设计优先级**：Boss 狂暴时免疫控制、净化只能驱散低优先级 Debuff——给 Buff 加 `Dispellable` 和 `Priority` 字段，别在逻辑里 hardcode

### 🔗 相关问题

- 如何设计 Buff 与技能系统的联动（技能施加 Buff / Buff 触发技能）？
- 大量 Buff 同时生效时，属性重算的性能如何优化？
- 如何实现「Buff 触发其他 Buff」的链式效果而不陷入无限循环？
