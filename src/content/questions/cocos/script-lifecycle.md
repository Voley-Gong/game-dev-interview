---
title: "Cocos Creator 脚本生命周期与事件系统详解"
category: "cocos"
level: 1
tags: ["生命周期", "事件系统", "Component", "引擎原理"]
related: ["cocos/node-component-system", "cocos/animation-system"]
hint: "onLoad 和 start 的区别？update 之前发生了什么？事件系统的冒泡机制是怎样的？"
---

## 参考答案

### ✅ 核心要点

1. **生命周期顺序**：`onLoad` → `onEnable` → `start` → `update`（每帧）→ `lateUpdate`（每帧）→ `onDisable` → `onDestroy`
2. **onLoad vs start**：`onLoad` 在节点首次激活时调用一次（可做初始化），`start` 在第一次 `update` 之前调用（可安全访问其他组件）
3. **事件系统三层**：节点事件（EventTarget）、系统事件（Input）、自定义全局事件（director.emit/on）
4. **事件冒泡**：触摸/鼠标事件从目标节点向父节点冒泡，可通过 `event.propagationStopped = true` 阻止
5. **Schedule 调度器**：`this.schedule()` 提供基于组件生命周期的定时器，组件销毁时自动清理

### 📖 深度展开

#### 完整生命周期时序图

```
节点创建 (instantiate / addChild)
    │
    ▼
┌─ onLoad() ────────────────────────────┐
│  节点和组件已创建，可获取引用          │
│  ⚠️ 子节点的 onLoad 先于父节点执行      │
│  ⚠️ 此时兄弟节点可能尚未 onLoad         │
└───────────────────────────────────────┘
    │
    ▼ (节点 active = true)
┌─ onEnable() ──────────────────────────┐
│  组件启用时调用，可被多次触发          │
│  对应 this.enabled = true             │
└───────────────────────────────────────┘
    │
    ▼
┌─ start() ─────────────────────────────┐
│  第一次 update 之前调用，仅一次        │
│  ✅ 此时所有组件已完成 onLoad          │
│  ✅ 适合做跨组件的初始化逻辑           │
└───────────────────────────────────────┘
    │
    ▼ (每帧循环)
┌─ update(dt) ──────────────────────────┐
│  每帧调用，dt 为帧间隔时间（秒）       │
│  处理游戏逻辑、状态更新                │
└───────────────────────────────────────┘
    │
    ▼
┌─ lateUpdate(dt) ──────────────────────┐
│  所有 update 执行完后调用              │
│  适合做跟随逻辑（相机追踪）            │
└───────────────────────────────────────┘
    │
    ▼ (节点 active = false 或 enabled = false)
┌─ onDisable() ─────────────────────────┐
│  组件禁用时调用，可被多次触发          │
└───────────────────────────────────────┘
    │
    ▼ (节点销毁 destroy())
┌─ onDestroy() ─────────────────────────┐
│  节点销毁时调用，仅一次               │
│  ✅ 清理资源引用、定时器、事件监听     │
└───────────────────────────────────────┘
```

#### 各阶段使用场景对比

| 生命周期 | 调用次数 | 推荐用途 | 注意事项 |
|---------|---------|---------|---------|
| `onLoad` | 1次 | 获取组件引用、初始化数据 | 不要访问兄弟节点（可能未初始化） |
| `onEnable` | 多次 | 注册事件监听、开启定时器 | 每次启用都会调用，注意重复注册 |
| `start` | 1次 | 跨组件初始化、初始动画 | 所有 onLoad 已完成，安全访问 |
| `update` | 每帧 | 游戏逻辑、状态机更新 | 避免重逻辑，控制执行频率 |
| `lateUpdate` | 每帧 | 相机跟随、后处理逻辑 | 在所有 update 之后执行 |
| `onDisable` | 多次 | 取消事件监听、停止定时器 | 与 onEnable 配对 |
| `onDestroy` | 1次 | 释放资源、清理引用 | 最后的清理机会 |

#### 事件系统详解

```typescript
// 1️⃣ 节点事件系统（NodeEventTarget）
// 监听和触发自定义事件
node.on('custom-event', (data: any) => {
    console.log('收到事件:', data);
}, this);  // 第三个参数绑定 this 指向

// 触发事件
node.emit('custom-event', { value: 42 });

// 取消监听
node.off('custom-event', callback, this);

// 2️⃣ 输入事件系统（Input）
input.on(Input.EventType.TOUCH_START, (event: EventTouch) => {
    const location = event.getUILocation();
    console.log(`触摸位置: ${location.x}, ${location.y}`);
}, this);

input.on(Input.EventType.KEY_DOWN, (event: EventKeyboard) => {
    switch (event.keyCode) {
        case KeyCode.KEY_A:
            console.log('按下 A 键');
            break;
    }
}, this);

// 3️⃣ 触摸事件冒泡机制
// 父节点可以接收到子节点冒泡上来的触摸事件
parentNode.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
    console.log('父节点收到触摸（冒泡）');
    // 阻止继续冒泡
    event.propagationStopped = true;
}, this);

// 4️⃣ 全局事件总线（使用 director 或自定义 EventTarget）
// 适合跨场景/跨模块通信
const globalEvents = new EventTarget();
globalEvents.on('player:levelup', (level: number) => {
    console.log(`玩家升级到 ${level}`);
});

// 在其他组件/场景中触发
globalEvents.emit('player:levelup', 10);
```

#### Schedule 调度器

```typescript
// 定时器（绑定在组件上，组件销毁时自动清理）
export class EnemySpawner extends Component {
    start() {
        // 每 2 秒生成一个敌人
        this.schedule(this.spawnEnemy, 2.0);

        // 延迟 3 秒后执行一次
        this.scheduleOnce(this.firstWave, 3.0);

        // 每 1 秒执行，重复 5 次，延迟 2 秒开始
        this.schedule(this.updateScore, 1.0, 5, 2.0);
    }

    private spawnEnemy() { /* ... */ }
    private firstWave() { /* ... */ }
    private updateScore() { /* ... */ }

    onDestroy() {
        // 不需要手动 unschedule，组件销毁时自动清理
        // 但如果需要提前停止：
        this.unschedule(this.spawnEnemy);
    }
}
```

#### 常见生命周期陷阱

```typescript
// ❌ 陷阱1：在 onLoad 中访问兄弟节点
@ccclass('BadExample')
class BadExample extends Component {
    onLoad() {
        // 兄弟节点可能还没执行 onLoad！
        const sibling = this.node.parent?.getChildByName('Sibling');
        sibling?.getComponent(SiblingComp)?.init();  // 可能失败
    }

    // ✅ 正确做法：放到 start 中
    start() {
        const sibling = this.node.parent?.getChildByName('Sibling');
        sibling?.getComponent(SiblingComp)?.init();  // 安全
    }
}

// ❌ 陷阱2：onEnable 中注册事件但 onDisable 忘记取消
@ccclass('EventListener')
class EventListener extends Component {
    onEnable() {
        input.on(Input.EventType.TOUCH_START, this.onTouch, this);
    }
    // 忘记写 onDisable 取消监听 → 事件会持续触发！

    onDisable() {
        // ✅ 必须与 onEnable 配对
        input.off(Input.EventType.TOUCH_START, this.onTouch, this);
    }

    private onTouch(event: EventTouch) { /* ... */ }
}

// ❌ 陷阱3：组件销毁后定时器仍在运行
// 如果使用 setTimeout/setInterval 而非 schedule
@ccclass('TimerLeak')
class TimerLeak extends Component {
    start() {
        // ⚠️ setTimeout 不会被组件销毁自动清理！
        this.timerId = setInterval(() => {
            // 组件已销毁后仍会执行
            this.getComponent(Label)!.string = 'tick';  // 报错！
        }, 1000);
    }

    onDestroy() {
        // ✅ 必须手动清理
        clearInterval(this.timerId);
    }
}
```

### ⚡ 实战经验

1. **初始化分层设计**：将初始化分为三个阶段——数据初始化放 `onLoad`，跨组件初始化放 `start`，依赖外部系统（如服务器数据）的初始化放 `start` 后通过事件驱动。避免在 `onLoad` 中做复杂的跨组件通信
2. **事件清理规范**：建立 `onEnable/onDisable` 配对的纪律。对于全局事件（`input.on`、`director.on`），必须在 `onDisable` 中 `off`。推荐使用一个事件管理器统一注册和注销，避免散落各处
3. **性能敏感场景避开 update**：对于不需要每帧执行的逻辑，用 `schedule` 替代 `update`，降低帧开销。例如 AI 决策可以 0.1 秒执行一次而非每帧执行

### 🔗 相关问题

- 组件的 `enabled` 属性和节点的 `active` 属性有什么区别？
- 多个组件挂载在同一节点上时，执行顺序如何保证？
- 如何实现一个安全的事件总线系统？
