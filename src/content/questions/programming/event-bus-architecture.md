---
title: "如何设计一个类型安全的游戏事件总线？"
category: "programming"
level: 2
tags: ["事件系统", "事件总线", "类型安全", "架构设计", "TypeScript"]
related: ["programming/observer-pattern", "programming/design-patterns-game"]
hint: "面试官想看的不只是 EventEmitter，而是如何让事件名和参数类型一一对应，编译期就能发现错误。"
---

## 参考答案

### ✅ 核心要点

1. **事件总线（Event Bus）是观察者模式的升级版**：解耦了事件的发布者和订阅者，双方只与总线交互而非直接引用对方，适合游戏中大量模块间的松耦合通信（如 UI、音频、战斗系统的联动）。
2. **类型安全是生产级事件总线的核心要求**：用 TypeScript 的映射类型（Mapped Types）让每个事件名绑定到具体的参数类型，调用 `emit("PlayerDied", { hp: 100 })` 时编译器能检查参数是否匹配，而非等到运行时崩溃。
3. **内存泄漏是最大陷阱**：订阅者如果忘记取消订阅（`off`），事件总线会持有其引用导致 GC 无法回收，在频繁创建/销毁场景（如弹窗、战斗回合）中会造成严重的内存泄漏。
4. **事件执行顺序不可依赖**：多个订阅者监听同一事件时，调用顺序取决于注册顺序，但不应该在订阅者之间建立隐式的执行依赖，否则会产生难以追踪的 bug。
5. **高频事件需要节流/防抖**：`onMove`、`onFrameUpdate` 这类每帧触发的事件如果直接广播，一个事件可能触发上百个回调，造成性能热点，需要批量处理或限频。

### 📖 深度展开

#### 1. 类型安全事件总线的完整实现

利用 TypeScript 的 `keyof` 和条件类型，让事件名与载荷类型一一映射：

```typescript
// 第一步：定义全局事件映射表（事件名 → 载荷类型）
interface GameEventMap {
  PlayerDied: { playerId: number; killerId: number };
  LevelUp: { playerId: number; newLevel: number; oldLevel: number };
  ItemPicked: { itemId: number; count: number };
  ScoreChanged: { score: number; delta: number };
  EnemySpawned: { enemyId: number; position: { x: number; y: number } };
}

// 第二步：事件总线核心——泛型约束保证类型安全
type EventHandler<T> = (payload: T) => void;

class TypedEventBus<TEventMap extends Record<string, any>> {
  // 每个事件名对应一组处理器
  private handlers: {
    [K in keyof TEventMap]?: Set<EventHandler<TEventMap[K]>>;
  } = {};

  // 订阅：K 自动推断，handler 参数类型与 TEventMap[K] 一致
  on<K extends keyof TEventMap>(
    event: K,
    handler: EventHandler<TEventMap[K]>
  ): () => void {
    if (!this.handlers[event]) {
      this.handlers[event] = new Set();
    }
    this.handlers[event]!.add(handler);

    // 返回取消订阅函数，防止忘记 off
    return () => this.off(event, handler);
  }

  // 只监听一次
  once<K extends keyof TEventMap>(
    event: K,
    handler: EventHandler<TEventMap[K]>
  ): () => void {
    const wrapper: EventHandler<TEventMap[K]> = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    return this.on(event, wrapper);
  }

  // 发布：payload 类型与事件名严格匹配
  emit<K extends keyof TEventMap>(event: K, payload: TEventMap[K]): void {
    const set = this.handlers[event];
    if (!set) return;
    // 复制一份再遍历，防止回调中修改 Set 导致迭代异常
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[EventBus] Handler error for "${String(event)}":`, e);
        // 一个处理器崩溃不应影响其他订阅者
      }
    }
  }

  off<K extends keyof TEventMap>(
    event: K,
    handler: EventHandler<TEventMap[K]>
  ): void {
    this.handlers[event]?.delete(handler);
  }

  clear(): void {
    this.handlers = {};
  }
}

// 使用示例——编译期就能发现类型错误
const bus = new TypedEventBus<GameEventMap>();

// ✅ 正确：类型完全匹配
bus.on("PlayerDied", (e) => {
  console.log(`Player ${e.playerId} killed by ${e.killerId}`);
});

// ❌ 编译错误：缺少 killerId
// bus.emit("PlayerDied", { playerId: 1 });
// ❌ 编译错误：score 应该是 number 而非 string
// bus.emit("ScoreChanged", { score: "high", delta: 10 });
```

#### 2. 自动清理：生命周期绑定的订阅管理

游戏中最常见的泄漏场景是「组件销毁了但事件还在总线上」。解决方案是用装饰器或包装器自动管理生命周期：

```typescript
// 自动清理管理器：绑定到场景/面板的生命周期
class EventSubscriptionTracker {
  private unsubs: Array<() => void> = [];

  // 包装 on 调用，自动收集取消函数
  bind<K extends keyof GameEventMap>(
    bus: TypedEventBus<GameEventMap>,
    event: K,
    handler: EventHandler<GameEventMap[K]>
  ): void {
    const unsub = bus.on(event, handler);
    this.unsubs.push(unsub);
  }

  // 组件销毁时统一清理所有订阅
  dispose(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
  }
}

// 使用：在 UI 面板基类中自动管理
abstract class GamePanel {
  protected events = new EventSubscriptionTracker();

  onDestroy(): void {
    this.events.dispose(); // 自动取消所有订阅，杜绝泄漏
  }
}

class HUDPanel extends GamePanel {
  onEnable(): void {
    // 订阅自动被 tracker 管理，面板销毁时自动清理
    this.events.bind(eventBus, "PlayerDied", (e) => {
      this.showDeathNotice(e.playerId);
    });
    this.events.bind(eventBus, "ScoreChanged", (e) => {
      this.updateScoreLabel(e.score);
    });
  }
}
```

#### 3. 同步 vs 异步事件总线对比

| 维度 | 同步事件总线 | 异步事件总线（队列） |
|------|------------|-------------------|
| 执行时机 | `emit` 时立即调用所有回调 | 放入队列，下一帧统一处理 |
| 调用栈可读性 | 好（栈追踪直接到源头） | 差（回调与 emit 脱节） |
| 重入安全 | 危险（回调中再 emit 可能死循环） | 安全（天然串行化） |
| 性能 | 高（无队列开销） | 中（有入队/出队成本） |
| 适用场景 | UI 交互、即时反馈 | 战斗逻辑、帧同步、批量处理 |
| 调试难度 | 低 | 中高（事件堆积、顺序不确定） |

```
同步总线执行模型：
  emit(A) → handler1() → handler2() → handler3() → return
  特点：一条调用栈走到底，中间任何回调崩溃会影响后续

异步总线执行模型：
  emit(A) → push to queue → return（立即返回）
  ──── 下一帧 ----→ drain queue → handler1() → handler2() → handler3()
  特点：解耦了发送与执行时机，但调试时难以追踪事件来源
```

### ⚡ 实战经验

- **内存泄漏是最常见的线上事故**：某 SLG 游戏战斗面板每场战斗注册 15 个事件但未清理，连续战斗 50 场后内存增长 200MB。必须用 `SubscriptionTracker` 或弱引用方案，不要依赖开发者自觉 `off`。
- **事件风暴导致掉帧**：`onEntityMoved` 事件在 200 个 NPC 场景中每帧触发 200 次，每个事件又有 5 个订阅者，相当于每帧 1000 次回调。解决方案是改用脏标记——实体移动时只设 `dirty = true`，每帧只广播一次批量事件。
- **同步总线的重入问题**：`emit("PlayerDied")` 的回调中又调用了 `emit("Respawn")`，而 `Respawn` 的回调又触发了 `PlayerDied`，形成无限递归栈溢出。必须加防重入标志或改用异步队列。
- **不要用事件总线传大数据**：曾见有人用事件总线传递整个战斗录像（2MB JSON），导致 GC 压力飙升。事件载荷应只传引用或 ID，大数据走专门的通道。
- **事件命名规范至关重要**：项目初期事件名混乱（`onDie`、`player_dead`、`KILL_EVENT` 混用），后期重构成本极高。建议统一用 `PascalCase` + 动词过去式（`PlayerDied`、`ItemUsed`），并在 CI 中用脚本检查未注册的事件名。

### 🔗 相关问题

- 事件总线和消息队列（如 RabbitMQ 的概念）有什么异同？
- 如何实现跨线程的事件总线？（如 Web Worker 与主线程通信）
- 事件驱动架构（EDA）在大型游戏项目中有哪些优势和劣势？
