---
title: "Cocos Creator 3.x 事件系统与事件分发机制是怎样的？"
category: "cocos"
level: 2
tags: ["事件系统", "引擎原理", "架构设计"]
related: ["cocos/node-component-system", "cocos/script-lifecycle"]
hint: "从 EventTarget 到节点事件冒泡，Cocos 的事件机制有哪些层次？"
---

## 参考答案

### ✅ 核心要点

1. **EventTarget 是基础** → 所有事件对象的基类，提供 on/off/once/emit API
2. **节点事件系统** → Node 继承 EventTarget，支持触摸、鼠标、键盘等输入事件
3. **事件冒泡机制** → UI 事件从子节点向父节点逐层传递，可 stopPropagation 拦截
4. **全局事件系统** → 通过 `director.getScene()` 或自定义 EventBus 实现跨节点通信
5. **3.x 变化** → 3.x 移除了 2.x 的 `cc.systemEvent`，键盘/鼠标事件直接在 Node 上监听

### 📖 深度展开

#### 事件类型分层架构

```
┌──────────────────────────────────────┐
│           自定义 EventBus             │  ← 业务层（手动实现）
├──────────────────────────────────────┤
│        Node 输入事件系统               │  ← 触摸/鼠标/键盘
├──────────────────────────────────────┤
│        EventTarget (基础类)            │  ← 引擎层
├──────────────────────────────────────┤
│        底层引擎事件派发                 │  ← 引擎内部
└──────────────────────────────────────┘
```

#### EventTarget 核心用法

```typescript
import { EventTarget } from 'cc';

// 创建独立的事件目标
const eventTarget = new EventTarget();

// 注册事件
eventTarget.on('player-die', (data: { score: number }) => {
    console.log(`Player died, score: ${data.score}`);
});

// 一次性注册
eventTarget.once('level-complete', () => {
    console.log('This only fires once');
});

// 派发事件
eventTarget.emit('player-die', { score: 9999 });

// 注销事件（重要！避免内存泄漏）
eventTarget.off('player-die');
```

#### 节点触摸事件与冒泡

```typescript
import { Node, UITransform } from 'cc';

// 在节点上监听触摸事件
node.on(Node.EventType.TOUCH_START, (event) => {
    console.log('触摸开始', event.getUILocation());
    
    // 阻止事件继续冒泡
    // event.propagationStopped = true;
}, this);

// 触摸事件冒泡流程：
// 子节点 → 父节点 → ... → 根节点
// 只有命中区域（UITransform 包围盒）的节点才会收到事件
```

#### 3.x 键盘/鼠标事件变化

```typescript
import { input, Input, KeyboardEvent, EventKeyboard, KeyCode } from 'cc';

// 3.x 推荐方式：使用全局 input 对象
input.on(Input.EventType.KEY_DOWN, (event: EventKeyboard) => {
    if (event.keyCode === KeyCode.SPACE) {
        console.log('空格键按下');
    }
});

input.on(Input.EventType.KEY_UP, (event: EventKeyboard) => {
    console.log(`按键释放: ${event.keyCode}`);
});

// 鼠标事件
input.on(Input.EventType.MOUSE_DOWN, (event) => {
    console.log('鼠标按下', event.getButton());
});
```

#### 2.x vs 3.x 事件系统对比

| 维度 | Cocos 2.x | Cocos 3.x |
|------|-----------|-----------|
| 全局事件 | `cc.systemEvent` | `input` 全局对象 |
| 事件基类 | `cc.EventTarget` | `EventTarget`（从 cc 导入） |
| 触摸事件 | `TOUCH_START` 常量 | `Node.EventType.TOUCH_START` |
| 节点事件注册 | `node.on(type, cb, target)` | 同左，但 API 更严格 |
| 生命周期绑定 | 需手动 off | 推荐 `once()` 或组件 `onDestroy` 中 off |

### ⚡ 实战经验

1. **内存泄漏头号杀手**：`on()` 注册的事件如果不 `off()`，组件销毁后回调仍然持有引用，导致整个组件无法被 GC。养成 `onEnable` 注册、`onDisable` 注销的习惯，或在 `onDestroy` 中统一清理
2. **EventBus 模式实战**：大型项目中，用一个全局 EventTarget 做跨模块通信总线比节点间互相引用优雅得多。但注意 EventBus 的事件名要用常量管理，避免拼写错误
3. **事件冒泡踩坑**：UI 弹窗的关闭按钮事件冒泡到背景面板，导致点关闭同时触发了背景点击。解决方案：在弹窗根节点 `event.propagationStopped = true`
4. **3.x 迁移注意**：2.x 项目升级到 3.x 时，所有 `systemEvent` 调用都要改为 `input`，批量替换容易遗漏，建议用 TypeScript 编译器辅助排查

### 🔗 相关问题

- Cocos Creator 3.x 的组件生命周期中，事件注册和注销的最佳时机是什么？
- 如何设计一个类型安全的事件系统（TypeScript 泛型 EventTarget）？
- 多人在线游戏中，事件系统和网络消息系统如何协同工作？
