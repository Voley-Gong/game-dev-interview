---
title: "如何设计一个可扩展的任务与成就系统？"
category: "architecture"
level: 3
tags: ["任务系统", "成就系统", "架构设计", "事件驱动", "数据驱动"]
related: ["architecture/event-driven-vs-data-driven", "architecture/save-system-architecture", "architecture/data-oriented-design"]
hint: "任务系统本质是「监听游戏事件 → 推进进度 → 达成结算」的事件状态机，难点在解耦监听与触发、支持策划配置。"
---

## 参考答案

### ✅ 核心要点

1. **事件驱动监听**：任务不主动查询进度，而是订阅游戏事件（击杀、拾取、移动），解耦业务代码
2. **任务 = 目标（Objective）的组合**：每个目标独立判定，组合成"击杀10只怪 + 到达指定地点"
3. **数据驱动配置**：任务目标、前置条件、奖励全部配置化，程序只写目标类型，新增玩法不用改逻辑
4. **成就 = 聚合统计 + 触发器**：成就监听统计型数据（累计击杀1000），达标自动解锁
5. **状态三层持久化**：进行中进度 / 已完成 ID / 已领奖 ID 分开存储，避免重复领取和进度丢失

### 📖 深度展开

**任务系统分层架构：**

```
┌────────────────────────────────────────┐
│ 任务管理器 (QuestManager)              │
│   接受/放弃/完成、任务列表、存档读写    │
├────────────────────────────────────────┤
│ 目标系统 (Objective)                   │
│   KillObjective / CollectObjective /   │
│   ReachObjective / TalkObjective       │
├────────────────────────────────────────┤
│ 事件总线 (EventBus)                    │
│   游戏内所有行为派发事件，目标订阅      │
├────────────────────────────────────────┤
│ 条件系统 (Condition)                   │
│   接任务前提：等级≥10、完成前置任务     │
├────────────────────────────────────────┤
│ 奖励系统 (Reward)                      │
│   经验/物品/货币，领取即发放            │
└────────────────────────────────────────┘
```

**任务配置（数据驱动，策划可配）：**

```json
{
  "id": "q_001",
  "title": "清剿野猪林",
  "prerequisites": [
    { "type": "level", "value": 5 },
    { "type": "questCompleted", "questId": "q_000" }
  ],
  "objectives": [
    { "type": "kill", "target": "boar", "count": 10 },
    { "type": "reach", "location": "boar_forest_exit" }
  ],
  "rewards": [
    { "type": "exp", "value": 500 },
    { "type": "item", "itemId": "sword_002", "count": 1 }
  ]
}
```

**目标系统的多态设计（开闭原则）：**

```csharp
// 抽象目标基类
public abstract class QuestObjective {
    public bool IsCompleted;
    public abstract void OnEvent(GameEvent e);  // 订阅事件
    public abstract float Progress { get; }     // 0~1，供 UI 显示
}

// 击杀目标 —— 订阅 EnemyKilledEvent
public class KillObjective : QuestObjective {
    public string EnemyId;
    public int Required, Current;

    public override void OnEvent(GameEvent e) {
        if (e is EnemyKilledEvent k && k.EnemyId == EnemyId) {
            Current = Math.Min(Current + 1, Required);
            if (Current >= Required) IsCompleted = true;
        }
    }
    public override float Progress => (float)Current / Required;
}

// 目标工厂 —— 注册新类型只需注册一个 creator，不改业务代码
QuestObjectiveFactory.Register("kill",    data => new KillObjective(data));
QuestObjectiveFactory.Register("collect", data => new CollectObjective(data));
QuestObjectiveFactory.Register("reach",   data => new ReachObjective(data));
```

**任务状态机：**

```
未接受(Inactive) →[接受]→ 进行中(Active) →[目标全完成]→ 可完成(Completable)
                                                        →[领奖]→ 已完成(Done)
进行中 →[放弃]→ 未接受
```

**任务系统 vs 成就系统的差异：**

| 维度 | 任务系统 | 成就系统 |
|------|----------|----------|
| 触发方式 | 玩家主动接受 | 满足条件自动解锁 |
| 统计粒度 | 单次任务内（杀10只） | 全局累计（杀1000只） |
| 监听时机 | 仅"进行中"任务监听 | 全程常驻监听 |
| 数据来源 | 事件驱动 | 聚合统计 + 事件 |
| 持久化 | 单条任务进度 | 全局统计计数器 |

**成就系统的统计器模式（避免每帧扫描上千条成就）：**

```csharp
// 全局统计器，常驻，所有成就共享
public class StatsTracker {
    private Dictionary<string, long> _stats = new();

    public StatsTracker() {
        EventBus.On<EnemyKilledEvent>(e => Increment($"kill.{e.EnemyId}"));
        EventBus.On<ItemCollectedEvent>(e => Increment($"collect.{e.ItemId}"));
    }

    public long Get(string key) => _stats.GetValueOrDefault(key, 0);
    private void Increment(string key) {
        _stats[key]++;
        AchievementManager.CheckAchievements(this);  // 仅检查相关阈值
    }
}

// 成就配置 —— 绑定统计 key 和阈值
{ "id": "slayer", "stat": "kill.boar", "threshold": 1000, "reward": {...} }
```

### ⚡ 实战经验

- **成就监听必须常驻且低开销**：用统计计数器增量更新，而非每次全量扫描——上千条成就每帧遍历会直接拖垮性能
- **任务进度必须三层存储**：进行中进度 / 已完成 ID 列表 / 已领奖 ID 列表 分开存，防止"完成后未领奖"状态丢失，或断线重连后重复领奖
- **事件解耦是命门**：任务系统绝不能 `if (游戏状态 == XX)` 主动轮询，必须订阅事件——否则每加一种目标类型就要改一堆业务代码，违反开闭原则
- **支持动态注册/取消监听**：任务激活时才订阅事件，完成或放弃时立即取消订阅，避免"已完成任务还在每帧检查"浪费性能

### 🔗 相关问题

- 事件驱动架构如何避免事件爆炸和回调地狱？
- 如何设计一个支持多线任务、分支剧情的叙事任务系统？
- 成就系统的统计计数器如何保证跨存档的累计正确性？
