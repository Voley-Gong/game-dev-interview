---
title: "游戏中的定时器和调度系统怎么设计？如何高效管理百万级定时任务？"
category: "architecture"
level: 3
tags: ["定时器", "时间轮", "调度系统", "游戏循环", "架构设计"]
related: ["architecture/game-loop-subsystem", "architecture/event-driven-vs-data-driven", "architecture/object-pool"]
hint: "定时器本质是'延迟回调管理'。朴素实现（排序链表/最小堆）在万级以上定时器时性能崩塌，时间轮（Timing Wheel）能做到 O(1) 插入和到期检测。"
---

## 参考答案

### ✅ 核心要点

1. **定时器 = 延迟回调队列**：本质是管理"在 T 时刻执行回调 F"的集合，核心操作只有两个——添加（O(1) 最好）和到期检测（每帧扫描）
2. **时间轮（Timing Wheel）是标准答案**：把时间按 tick 分桶，定时器按到期 tick 放入对应槽位，每帧只检查当前槽 → O(1) 插入、O(1) 到期检测
3. **层级时间轮处理超长定时器**：小时轮 → 分钟轮 → 秒轮，到期时从高层降级到低层，兼顾短时精度和长时跨度
4. **区分游戏时间与真实时间**：游戏暂停时逻辑定时器要冻结、慢动作时要缩放、倍速时要加速——不能直接用 `Time.realtimeSinceStartup`
5. **定时器必须可取消且可绑定生命周期**：绑定 GameObject/场景，对象销毁时自动清理定时器，否则回调操作已销毁对象导致空引用

### 📖 深度展开

**朴素方案的问题（为什么不能直接用排序链表/最小堆）：**

```
方案 A：List<Timer> 每帧排序 → 插入 O(n)、到期 O(1)、万级定时器每帧排序爆炸
方案 B：最小堆（PriorityQueue）→ 插入 O(log n)、到期 O(1)、好很多但仍有开销
方案 C：时间轮 → 插入 O(1)、到期 O(1)、万级百万级都轻松 ← 工业标准
```

**单层时间轮原理：**

```
tick = 100ms，轮盘大小 = 10 格（1 秒一圈）

槽位:  [0]  [1]  [2]  [3]  [4]  [5]  [6]  [7]  [8]  [9]
       ↓    ↓                        ↓
      T_A  T_B                      T_C
      (到期  (300ms                   (到期
       即执行 后执行)                  700ms)

当前指针 currentTick = 2
  → 检查 [2] 槽：执行 T_A
  → 指针前进到 [3]

添加一个 400ms 后执行的定时器：
  expireTick = currentTick + (400 / 100) = 2 + 4 = 6
  → 放入 [6] 槽  → O(1)！
```

**单层时间轮代码实现：**

```csharp
public class TimerWheel {
    private readonly List<Action>[] _slots;  // 每个槽位一个回调链表
    private readonly int _tickMs;            // 每个 tick 的毫秒数
    private readonly int _slotCount;         // 槽位总数（轮盘大小）
    private int _currentSlot = 0;
    private float _accumulator = 0;

    public TimerWheel(int tickMs = 100, int slotCount = 3600) {
        _tickMs = tickMs;
        _slotCount = slotCount;
        _slots = new List<Action>[slotCount];
        for (int i = 0; i < slotCount; i++) _slots[i] = new();
    }

    // O(1) 添加定时器
    public void AddTimer(int delayMs, Action callback) {
        int ticks = delayMs / _tickMs;
        int slot = (_currentSlot + ticks) % _slotCount;
        _slots[slot].Add(callback);
    }

    // 每帧调用，驱动时间轮前进
    public void Update(float deltaTimeMs) {
        _accumulator += deltaTimeMs;
        while (_accumulator >= _tickMs) {
            _accumulator -= _tickMs;
            _currentSlot = (_currentSlot + 1) % _slotCount;
            // 执行当前槽位所有到期回调
            var callbacks = _slots[_currentSlot];
            foreach (var cb in callbacks) cb();
            callbacks.Clear();
        }
    }
}
```

**层级时间轮——处理跨小时的长定时器：**

```
秒轮（1s/tick, 60格）    分钟轮（60s/tick, 60格）    小时轮（3600s/tick, 24格）
[0][1]...[59]           [0][1]...[59]               [0][1]...[23]

添加 2 小时后执行的定时器：
  → 2h = 7200s，超出秒轮（60s）和分钟轮（3600s）范围
  → 放入小时轮 [2] 槽

时间流逝，小时轮指针转到 [2]：
  → 该定时器到期，降级到分钟轮对应槽（重新计算剩余时间）
  → 分钟轮到期，再降级到秒轮
  → 秒轮到期，执行回调

层级结构让任意时长的定时器都是 O(1)：
  插入：直接算出该放哪一层哪个槽
  到期：高层到期 → 降级到低层 → 最终执行
```

**游戏时间缩放——让定时器跟随游戏速度：**

```csharp
public class GameTimerManager {
    private readonly TimerWheel _logicWheel;   // 受游戏速度影响
    private readonly TimerWheel _realWheel;    // 不受影响（UI、网络超时）

    public float TimeScale = 1f;  // 0=暂停, 0.5=慢动作, 2=倍速

    public void Update(float realDeltaTimeMs) {
        // 真实时间轮：UI 动画、网络心跳，始终按真实时间走
        _realWheel.Update(realDeltaTimeMs);
        // 逻辑时间轮：技能 CD、Buff 倒计时，随 TimeScale 缩放
        _logicWheel.Update(realDeltaTimeMs * TimeScale);
    }

    // 技能冷却用逻辑时间（暂停时不走）
    public void AddSkillCooldown(float seconds, Action onReady) =>
        _logicWheel.AddTimer((int)(seconds * 1000), onReady);

    // 网络超时用真实时间（暂停也要检测断线）
    public void AddNetworkTimeout(float seconds, Action onTimeout) =>
        _realWheel.AddTimer((int)(seconds * 1000), onTimeout);
}
```

**三种定时器方案对比：**

| 维度 | 排序链表 | 最小堆 (PriorityQueue) | 时间轮 (Timing Wheel) |
|------|----------|----------------------|----------------------|
| 插入复杂度 | O(n) | O(log n) | **O(1)** |
| 到期检测 | O(1) | O(1) | **O(1)** |
| 百万级定时器 | 崩溃 | 可用但开销大 | **轻松** |
| 实现复杂度 | 最简 | 中等 | 中等（层级稍复杂） |
| 取消操作 | O(n) 查找 | O(n) 查找 | 标记删除 O(1) |
| 适用规模 | < 100 | < 1 万 | 百万级 |

### ⚡ 实战经验

- **定时器回调里销毁对象是经典崩溃源**：定时器到期时绑定的 GameObject 可能已被销毁——回调里先判空（`if (go == null) return;`），或绑定生命周期自动取消
- **场景切换必须清理定时器**：进入新场景前把旧场景的定时器全部取消，否则它们会在新场景里操作已不存在的对象。最佳实践：定时器绑定"场景 Token"，场景卸载时 Token 失效，关联定时器自动失效
- **别把所有定时器都丢给真实时间**：暂停游戏时技能 CD 还在走、Buff 不停倒计时，玩家体验极差——逻辑相关的一律走受 TimeScale 控制的逻辑时间轮
- **百万级定时器不是噱头**：弹幕游戏每颗子弹都有生命周期定时器、SLG 全地图建筑都有产出倒计时、MMO 全服 Buff/Dot——没有时间轮，这些场景的主线程会被定时器扫描吃满

### 🔗 相关问题

1. 游戏的固定逻辑帧（Fixed Tick）和渲染帧（Variable Update）怎么配合？定时器应该挂在哪个上面？
2. 如果定时器回调内部又添加了新定时器，会导致迭代器失效吗？如何安全处理？
3. 帧同步架构下，定时器如何保证确定性？能不能用时间轮？
