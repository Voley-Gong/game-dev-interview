---
title: "游戏输入系统架构怎么设计？如何做到多平台、可重绑、低延迟？"
category: "architecture"
level: 3
tags: ["输入系统", "Input System", "架构设计", "多平台", "输入映射", "操作缓冲"]
related: ["architecture/multi-platform-adaptation-architecture", "architecture/module-decoupling-bus-signal"]
hint: "输入不是简单的 KeyDown 判断——是「设备抽象 → 动作映射 → 上下文路由 → 消费确认」四层管线。"
---

## 参考答案

### ✅ 核心要点

1. **设备抽象层（Device Abstraction）**：把键盘、手柄、触屏、鼠标的原始事件统一为 `InputDevice` 抽象。上层逻辑不碰物理按键（如 KeyCode.Space），只认逻辑动作（如 `Jump`）。换平台时只需新增 Device Adapter，上层零改动。
2. **动作映射（Action Mapping）**：用配置表把物理输入绑定到逻辑动作（`Space → Jump`、`GamepadA → Jump`），支持运行时重绑定。映射数据序列化为 JSON/ScriptableObject，玩家改键后持久化到本地存档。
3. **输入上下文（Input Context）**：根据当前游戏状态（菜单 / 战斗 / 载具 / 对话 / 过场）激活或屏蔽不同动作集。战斗中 A 键是攻击，菜单中 A 键是确认——靠 Context 切换而非全局 if-else 判断。
4. **输入缓冲（Input Buffer）**：动作 / 格斗游戏中预记录玩家最近 N 毫秒的输入（如起跳前 100ms 按了攻击），在动画进入可中断帧时回放消费。让"按早了"也能触发，大幅提升手感。
5. **事件驱动分发**：通过 `InputAction.OnPerformed` 回调通知订阅者，而非每帧 `GetKey()` 轮询。只有状态变化时才触发回调，减少无效 CPU 开销，也更容易做输入录制和回放。

### 📖 深度展开

**四层输入管线架构：**

```
玩家操作
  ↓
┌─────────────────────────────────┐
│ Layer 1: Device Adapter         │  ← 键盘/手柄/触屏原始事件
│   KeyboardAdapter                │
│   GamepadAdapter (摇杆死区过滤)  │
│   TouchAdapter (多指状态机)     │
└──────────┬──────────────────────┘
           ↓ 统一为 InputEvent {deviceId, controlPath, value, phase}
┌─────────────────────────────────┐
│ Layer 2: Action Mapper          │  ← 配置表驱动，可重绑定
│   Bindings: [{path: "<Keyboard>/space", action: "Jump"}]
│   Bindings: [{path: "<Gamepad>/buttonSouth", action: "Jump"}]
└──────────┬──────────────────────┘
           ↓ 映射为 InputAction {name, value, phase(Started/Performed/Canceled)}
┌─────────────────────────────────┐
│ Layer 3: Context Router         │  ← 按游戏状态过滤
│   BattleContext: [Move, Jump, Attack, Dodge]
│   MenuContext:   [Navigate, Confirm, Cancel]
│   DialogueContext:[Advance, Skip]
└──────────┬──────────────────────┘
           ↓ 仅当前 Context 的动作被分发
┌─────────────────────────────────┐
│ Layer 4: Consumer + Buffer      │  ← 订阅者接收 + 输入缓冲
│   PlayerController.OnJump()     │
│   InputBuffer.Consume("Attack") │
└─────────────────────────────────┘
```

**动作映射与重绑定实现：**

```typescript
// 输入动作定义
interface InputAction {
  name: string;             // "Jump", "Attack", "Move"
  type: 'button' | 'value' | 'vector1' | 'vector2';
  bindings: InputBinding[]; // 一个动作可绑定多个物理输入
  deadZone?: number;        // 摇杆死区，默认 0.125
}

interface InputBinding {
  device: 'keyboard' | 'gamepad' | 'touch';
  controlPath: string;      // "<Keyboard>/space" 或 "<Gamepad>/leftStick"
  // 重绑定时只改这个路径，代码零改动
}

// 上下文管理
class InputContextManager {
  private stack: InputContext[] = [];  // 栈式管理，支持叠加

  push(ctx: InputContext) { this.stack.push(ctx); }
  pop() { return this.stack.pop(); }

  // 只分发当前栈顶 Context 关心的动作
  isActive(action: string): boolean {
    return this.stack[this.stack.length - 1]
      ?.actions.includes(action) ?? false;
  }
}

// 重绑定流程
class RebindSystem {
  startRebind(actionName: string) {
    // 监听任意设备输入，捕获后写入 binding
    this.listening = true;
    this.pendingAction = actionName;
  }
  onAnyInput(e: InputEvent) {
    if (!this.listening) return;
    const binding = { device: e.device, controlPath: e.path };
    this.updateBinding(this.pendingAction, binding); // 持久化到存档
    this.listening = false;
  }
}
```

**输入缓冲时序（动作游戏手感核心）：**

```
时间轴（帧）:  F1    F2    F3    F4    F5    F6    F7
玩家输入:     按A    放A                     按B
角色动画:     [攻击动画 Phase 1（不可中断）]→[Phase 2（可中断）]

无缓冲：       F1按A→触发攻击  F6按B→? 此时还在攻击动画中，B被丢弃 → 手感差
有缓冲(100ms): F1按A→触发攻击  F6按B→写入Buffer
                                → F7动画进入可中断帧→消费Buffer中的B→衔接下一招
                                → 手感流畅："按早了也能连上"
```

```csharp
// 输入缓冲实现（C# 伪代码）
public class InputBuffer {
    private struct BufferedInput {
        public string action;
        public float timestamp;
    }
    private readonly List<BufferedInput> buffer = new();
    private float bufferWindow = 0.1f; // 100ms 窗口

    public void Push(string action) {
        buffer.Add(new BufferedInput { action = action, timestamp = Time.time });
    }

    // 动画可中断帧调用
    public bool TryConsume(string action) {
        buffer.RemoveAll(b => Time.time - b.timestamp > bufferWindow); // 清过期
        var hit = buffer.Find(b => b.action == action);
        if (hit.action != null) { buffer.Remove(hit); return true; }
        return false;
    }
}
```

**三种输入分发方式对比：**

| 维度 | 轮询 GetKey() | 事件回调 OnPerformed | 输入缓冲 Buffer |
|------|--------------|---------------------|-----------------|
| 实现复杂度 | 最低 | 中等 | 最高 |
| 性能开销 | 每帧查询（高） | 仅状态变化触发（低） | 额外 List 维护（低） |
| 手感 | 差（按早了丢输入） | 中（不丢但不预读） | ✅ 最好（预读+延迟消费） |
| 可录制回放 | 难（需每帧采样） | ✅ 事件序列化即可 | ✅ 可连同时间戳录制 |
| 适合场景 | 简单 UI / 移动 | 大多数游戏 | 动作 / 格斗 / 连招 |

### ⚡ 实战经验

- **手柄摇杆死区别设成 0**：摇杆物理特性导致静止时也有 ~0.05 的漂移，死区设 0.1~0.15 才能消除"角色自己走"。实测某项目死区 0.0 时角色有 30% 概率原地微移，改为 0.125 后消失。
- **输入延迟要量化**：从玩家按下到画面响应超过 **3 帧（50ms@60fps）** 就有明显延迟感。用高速摄像机对比：PC 键盘约 1 帧、蓝牙手柄约 2-3 帧、云游戏可达 6-10 帧。手柄蓝牙比有线多约 **16ms**。
- **重绑定时禁止冲突但允许修饰键**：两个动作绑同一按键要弹冲突提示，但 `Ctrl+A` 和 `A` 可以共存。做过一个项目没做冲突检测，玩家把"闪避"绑到了"移动"上，角色边走边滚。
- **触屏多指状态机是坑**：移动端 Touch 帧可能丢失（系统吞掉事件），不能简单用 `Input.touchCount` 判断。要用 `TouchPhase.Began/Moved/Ended/Canceled` 建状态机，Canceled（系统打断）必须清状态，否则虚拟摇杆"卡住"。

### 🔗 相关问题

1. Unity 新版 Input System 和旧版 Input Manager 的核心架构差异是什么？为什么推荐迁移？
2. 帧同步游戏中，输入系统如何保证确定性采样？（提示：固定帧率采样 + 本地预测 + 服务端校验）
3. 如何实现一个支持录像回放的输入录制系统？（提示：按帧序列化 InputAction 事件流）
