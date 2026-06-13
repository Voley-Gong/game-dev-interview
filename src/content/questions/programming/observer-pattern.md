---
title: "观察者模式和事件系统在游戏中的应用？"
category: "programming"
level: 1
tags: ["设计模式", "事件系统"]
related: ["architecture/ui-framework"]
hint: "游戏中的模块解耦，事件系统是最常用的设计模式之一。"
---

## 参考答案

### ✅ 核心要点

1. **观察者模式**：定义一对多的依赖关系，状态变化自动通知
2. **解耦**：发送方不关心接收方是谁，降低模块间耦合
3. **事件总线**：全局事件中心，统一管理事件注册和派发

### 📖 深度展开

**基础实现：**

```typescript
// TypeScript 实现（Cocos）
class EventBus {
  private static _instance: EventBus;
  private handlers: Map<string, Function[]> = new Map();

  static get instance() { return this._instance ||= new EventBus(); }

  on(event: string, handler: Function, target?: any) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler.bind(target));
  }

  off(event: string, handler: Function) {
    const list = this.handlers.get(event);
    if (list) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  emit(event: string, ...args: any[]) {
    const list = this.handlers.get(event);
    if (list) list.forEach(h => h(...args));
  }
}

// 使用
EventBus.instance.on('player-die', (playerId: number) => {
  // UI 更新
}, this);
EventBus.instance.emit('player-die', 1001);
```

**游戏中的典型应用场景：**

| 场景 | 事件 | 发布者 | 订阅者 |
|------|------|--------|--------|
| 成就系统 | `enemy-killed` | 战斗系统 | 成就管理器 |
| UI 更新 | `hp-changed` | 角色属性 | 血条 UI |
| 音效播放 | `skill-cast` | 技能系统 | 音频管理器 |
| 任务追踪 | `item-collected` | 背包系统 | 任务系统 |

### ⚡ 实战经验

- **必须有 off**：只注册不注销是内存泄漏的头号原因
- **事件命名规范**：`模块-动作` 格式（如 `battle-combo-hit`）
- **避免事件链过长**：A→B→C→D 的事件链难以调试
- **带类型的事件系统**：TypeScript 中用泛型约束事件参数类型
- **性能考量**：高频事件（如每帧的位置更新）不适合用事件总线
