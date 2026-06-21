---
title: "如何设计一个可扩展的战斗系统架构？"
category: "architecture"
level: 4
tags: ["战斗系统", "架构设计", "伤害结算", "Buff系统", "数据驱动"]
related: ["architecture/skill-system", "architecture/fsm-behavior-tree", "architecture/event-driven-vs-data-driven"]
hint: "战斗系统的核心不是伤害公式，而是伤害结算管线（Damage Pipeline）与效果编排如何解耦、如何保证确定性、如何让策划配置。"
---

## 参考答案

### ✅ 核心要点

1. **伤害结算管线（Damage Pipeline）**：伤害经过层层修饰（增伤/减伤/暴击/护盾），每层是独立的中介节点
2. **Buff 系统是灵魂**：Buff/修饰器用数据描述，通过事件钩子介入伤害流程，而非直接改血量
3. **效果（Effect）优先于直接修改**：所有数值变动走 Effect，留下日志和事件，方便回溯、复盘、网络同步
4. **确定性执行**：伤害结算按固定优先级排序，避免帧间抖动和多人不同步
5. **战斗实体是纯数据容器**：属性、状态、Buff 列表分离，逻辑由 System 驱动，便于序列化和校验

### 📖 深度展开

**战斗系统的分层架构：**

```
┌─────────────────────────────────────────┐
│  战斗流程层 (Battle Flow)               │
│  回合/即时编排、胜负判定、战斗初始化     │
├─────────────────────────────────────────┤
│  技能/动作层 (Skill / Action)           │
│  前摇→施放→后摇、目标选择、CD/消耗      │
├─────────────────────────────────────────┤
│  伤害结算层 (Damage Pipeline)           │
│  原始伤害 → 修饰链 → 最终伤害 → 结算    │
├─────────────────────────────────────────┤
│  Buff/修饰器层 (Modifier)               │
│  增益/减益/护盾/免伤，监听事件并介入     │
├─────────────────────────────────────────┤
│  属性/数据层 (Stats / Component)        │
│  基础属性、成长、装备加成、状态标记      │
└─────────────────────────────────────────┘
```

**伤害结算管线（关键，责任链模式）：**

```csharp
// 一次伤害请求（包含上下文，方便 Buff 读取/修改）
public struct DamageContext {
    public Entity Source;
    public Entity Target;
    public float BaseDamage;
    public DamageType Type;        // 物理/魔法/真实
    public bool IsCritical;
    public List<DamageModifier> Modifiers;  // 结算中间产物
}

// 结算管线 —— 节点顺序很重要：先算加成，再算减免，最后护盾
public class DamagePipeline {
    private readonly List<IDamageProcessor> _processors;

    public DamagePipeline() {
        _processors = new() {
            new CritProcessor(),        // 暴击：BaseDamage *= critMultiplier
            new AttackBuffProcessor(),  // 增伤：读 Source 身上的进攻 Buff
            new DefenseProcessor(),     // 减伤：读 Target 的护甲/魔抗
            new ShieldProcessor(),      // 护盾：优先扣护盾值
            new ImmunityProcessor(),    // 免疫：直接归零
        };
    }

    public DamageResult Process(DamageContext ctx) {
        foreach (var p in _processors) {
            if (ctx.BaseDamage <= 0) break;   // 已被免疫，短路
            p.Apply(ref ctx);
        }
        ctx.Target.Health -= ctx.BaseDamage;        // 实际扣血
        EventBus.Emit(new DamageDealtEvent(ctx));   // 派发事件供 UI/日志订阅
        return new DamageResult(ctx);
    }
}
```

**Buff 系统（数据驱动 + 事件钩子，解耦的关键）：**

```json
// Buff 配置 —— 策划可配，无需改代码
{
  "id": "rage",
  "duration": 5,
  "tags": ["buff", "attack_up", "dispellable"],
  "modifiers": [
    {
      "event": "OnDamageCalc",
      "op": "multiply",
      "target": "Source.attack",
      "value": 1.5
    }
  ],
  "onApply":  { "effect": "play_vfx", "vfx": "rage_aura" },
  "onExpire": { "effect": "remove_vfx" }
}
```

Buff 通过订阅战斗事件（`OnDamageCalc` / `OnHit` / `OnTurnEnd`）介入流程，**不直接调用伤害代码**——这就是解耦的核心：新增一种 Buff 不需要改管线，只要订阅对应事件。

**回合制 vs 即时战斗的架构差异：**

| 维度 | 回合制/卡牌 | 即时制（ARPG/MOBA） |
|------|-------------|---------------------|
| 时间驱动 | 回合事件触发 | 每帧 tick 驱动 |
| 伤害时序 | 严格串行，天然确定性 | 需时间轴 + 帧同步 |
| Buff 更新 | 回合开始/结束统一结算 | 每帧推进 duration |
| 并发量 | 几乎无 | 大量技能/Buff 同帧结算 |
| 确定性 | 天然确定 | 需严格排序 + 定点数 |

**属性系统（Stats）的三段式分层：**

```
最终攻击力 = 基础(Base) + 成长(Growth) + 装备(Gear) + 临时(Buff)
            ↑ 永久            ↑ 永久       ↑ 半永久    ↑ 短暂
```

将属性来源分层，**Buff 只修改"临时层"**，过期自动回退，避免属性污染（经典 bug：Buff 过期后攻击力没还原，角色越来越强）。

### ⚡ 实战经验

- **永远不要在 Buff 里直接改 Health**：所有数值变动必须走伤害管线/效果系统，否则护盾、免伤、伤害反弹、吸血全部失效
- **伤害结算必须有序且确定**：多人游戏里 A 打 B 和 B 打 A 同帧结算，顺序不同会导致两端结果不一致——用全局 ActionID 排序，保证所有端按相同顺序回放
- **Buff 用 Tag 而非 ID 判断类型**：`hasTag("stun")` 比 `hasBuff("具体眩晕技能名")` 灵活得多，方便做群体驱散、状态免疫、效果互斥
- **战斗日志是最强调试工具**：把每次伤害的来源、每层修饰过程、最终值结构化记录，出 bug 时一查就知道是哪层算错，而不是靠猜

### 🔗 相关问题

- 如何设计一个数据驱动的通用技能系统？
- 战斗系统中如何实现伤害反弹、吸血、连锁闪电这类复合效果？
- 回合制游戏的战斗如何保证服务端校验的确定性？
