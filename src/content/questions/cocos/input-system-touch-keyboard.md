---
title: "Cocos Creator 3.x 输入系统：触屏、键盘、鼠标与多点触控如何处理？"
category: "cocos"
level: 2
tags: ["输入系统", "事件处理", "触屏", "多平台"]
related: ["cocos/event-system", "cocos/node-component-system"]
hint: "游戏需要在手机触屏和 PC 键鼠上同时运行，输入系统怎么统一处理？"
---

## 参考答案

### ✅ 核心要点

1. **EventTarget 架构** → Cocos 3.x 通过 `input` 全局对象和节点 `TOUCH`/`MOUSE`/`KEYBOARD` 事件统一处理输入
2. **触屏事件 (TOUCH)** → `Node.EventType.TOUCH_START/MOVE/END/CANCEL`，自动适配各平台
3. **键盘事件 (KEYBOARD)** → `systemEvent` / `input.on(KeyEvent.DOWN/UP)` 监听按键
4. **多点触控** → 通过 `EventTouch` 的 `getID()` 区分不同触摸点
5. **输入与游戏逻辑解耦** → 推荐使用 Input Manager 封装，再分发到各模块

### 📖 深度展开

#### 输入系统架构总览

```
硬件层（触摸屏 / 键盘 / 鼠标 / 手柄）
  ↓ 平台适配层
Cocos 引擎 input 系统
  ├── input.on(Input.EventType.TOUCH_*)     → 触屏事件
  ├── input.on(Input.EventType.MOUSE_*)      → 鼠标事件
  ├── input.on(Input.EventType.KEY_DOWN/UP)  → 键盘事件
  └── input.on(Input.EventType.DEVICEMOTION) → 重力感应
  ↓
节点事件冒泡（UI 触屏命中测试）
  ↓
游戏逻辑层（InputManager）
```

#### 1. 触屏事件处理

**全局触屏监听：**

```typescript
import { input, Input, EventTouch, Vec2 } from 'cc';

// 全局触摸开始
input.on(Input.EventType.TOUCH_START, (event: EventTouch) => {
    const touches = event.getUILocation();  // UI 坐标
    const worldPos = event.getLocation();   // 世界坐标
    console.log(`Touch at: ${worldPos.x}, ${worldPos.y}`);
    console.log(`Touch ID: ${event.getID()}`); // 触摸点 ID（多点触控用）
});

input.on(Input.EventType.TOUCH_MOVE, (event: EventTouch) => {
    const delta = event.getDelta(); // 相对上一帧的位移
    console.log(`Move delta: ${delta.x}, ${delta.y}`);
});

input.on(Input.EventType.TOUCH_END, (event: EventTouch) => {
    console.log('Touch ended');
});
```

**节点级触屏监听（UI 组件常用）：**

```typescript
import { Node, UITransform } from 'cc';

const buttonNode = new Node('MyButton');
buttonNode.addComponent(UITransform);

// 节点上监听触摸事件（会进行命中测试）
buttonNode.on(Node.EventType.TOUCH_START, (event) => {
    console.log('Button touched!');
    // 命中测试后，事件会冒泡到父节点
}, this);
```

#### 2. 多点触控处理

```typescript
input.on(Input.EventType.TOUCH_START, (event: EventTouch) => {
    const touchId = event.getID();
    const location = event.getLocation();

    // 记录每个触摸点
    this.activeTouches.set(touchId, {
        startPos: new Vec2(location.x, location.y),
        currentPos: new Vec2(location.x, location.y),
    });
});

// 双指缩放检测
input.on(Input.EventType.TOUCH_MOVE, (event: EventTouch) => {
    if (this.activeTouches.size === 2) {
        const touches = Array.from(this.activeTouches.values());
        const dist = Vec2.distance(touches[0].currentPos, touches[1].currentPos);
        const prevDist = Vec2.distance(touches[0].startPos, touches[1].startPos);

        const scale = dist / prevDist;
        this.onPinch?.(scale);
    }
});
```

#### 3. 键盘事件

```typescript
import { input, Input, EventKeyboard, KeyCode } from 'cc';

input.on(Input.EventType.KEY_DOWN, (event: EventKeyboard) => {
    switch (event.keyCode) {
        case KeyCode.KEY_W:
        case KeyCode.ARROW_UP:
            this.moveUp = true;
            break;
        case KeyCode.KEY_A:
        case KeyCode.ARROW_LEFT:
            this.moveLeft = true;
            break;
        case KeyCode.SPACE:
            this.jump();
            break;
    }
});

input.on(Input.EventType.KEY_UP, (event: EventKeyboard) => {
    if (event.keyCode === KeyCode.KEY_W || event.keyCode === KeyCode.ARROW_UP) {
        this.moveUp = false;
    }
});
```

#### 4. 鼠标事件（PC 平台）

```typescript
input.on(Input.EventType.MOUSE_DOWN, (event: EventMouse) => {
    console.log(`Mouse button: ${event.getButton()}`); // 0=左键, 1=中键, 2=右键
    console.log(`Position: ${event.getLocation()}`);
});

input.on(Input.EventType.MOUSE_WHEEL, (event: EventMouse) => {
    const scroll = event.getScrollY(); // 滚轮值
    this.cameraDistance -= scroll * 0.1;
});

input.on(Input.EventType.MOUSE_MOVE, (event: EventMouse) => {
    // 悬停检测
    const button = event.getButton();
    if (button === 0) {
        // 左键按下拖拽
        const delta = event.getDelta();
        this.rotateCamera(delta.x, delta.y);
    }
});
```

#### 事件流对比表

| 事件类型 | 监听方式 | 命中测试 | 冒泡 | 多平台支持 |
|----------|----------|----------|------|------------|
| TOUCH_* | `input.on` / `node.on` | ✅（节点级） | ✅ | 全平台 |
| MOUSE_* | `input.on` | ❌（全局） | ❌ | PC 为主 |
| KEY_DOWN/UP | `input.on` | — | — | 全平台 |
| DEVICEMOTION | `input.on` | — | — | 移动端 |

### ⚡ 实战经验

1. **触屏 vs 鼠标统一** — Cocos 在移动端会自动将触摸映射为 TOUCH 事件，PC 上鼠标点击同时触发 MOUSE 和 TOUCH 事件。为避免重复响应，移动端只监听 TOUCH，PC 端只监听 MOUSE，或统一只用 TOUCH
2. **事件吞没问题** — UI 层（如摇杆、按钮）的 TOUCH 事件会冒泡到游戏层。用 `event.propagationStopped = true` 可以阻止冒泡，防止 UI 点击穿透到 3D 场景
3. **输入延迟与帧同步** — 输入事件在每帧更新前处理，如果帧率过低会出现输入丢失。将关键输入（如跳跃）缓存到队列中，在 `update` 中消费
4. **虚拟摇杆实现** — 不要在 TOUCH_MOVE 中直接移动角色，应该计算方向向量后传递给移动组件，保持输入与逻辑解耦

### 🔗 相关问题

- Cocos Creator 3.x 事件系统与事件分发机制是怎样的？
- 如何实现虚拟摇杆和多指手势识别？
- Cocos Creator 的节点命中测试（HitTest）是如何工作的？
