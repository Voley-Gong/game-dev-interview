---
title: "游戏中如何实现命令模式与撤销/重做系统？"
category: "programming"
level: 2
tags: ["设计模式", "命令模式", "撤销重做", "架构设计"]
related: ["programming/design-patterns-game", "programming/observer-pattern"]
hint: "想想编辑器里 Ctrl+Z 是怎么做到逐步撤销的，以及技能系统如何可逆地执行。"
---

## 参考答案

### ✅ 核心要点

1. **命令模式本质**：将"请求"封装成独立对象，携带执行所需的全部参数（目标对象、操作类型、参数值），从而实现调用的参数化、排队、日志和可撤销
2. **Command 接口约定**：每个命令实现 `execute()` 和 `undo()` 两个核心方法，`undo` 必须**精确逆转** `execute` 造成的所有状态变更，包括副作用
3. **双栈架构**：用 Undo 栈和 Redo 栈管理历史，执行命令压入 Undo 栈，撤销时弹出并执行逆操作后压入 Redo 栈，新命令清空 Redo 栈
4. **快照 vs 差异**：轻量命令存差异（delta），重量级操作存快照（snapshot），需要根据数据量权衡内存与恢复速度
5. **游戏场景应用**：关卡编辑器（移动/删除实体）、回合制游戏（棋子移动可悔棋）、技能系统（debug 回放）、策划配置工具

### 📖 深度展开

**1. 命令模式基础实现**

```typescript
// 命令接口：所有可撤销操作的契约
interface ICommand {
  execute(): void;
  undo(): void;
  describe(): string; // 用于 UI 显示操作历史
}

// 具体命令：移动游戏实体
class MoveEntityCommand implements ICommand {
  constructor(
    private entity: Entity,
    private newPos: Vec3,
    private oldPos: Vec3
  ) {}

  execute(): void {
    this.entity.position = this.newPos;
  }

  undo(): void {
    this.entity.position = this.oldPos;
  }

  describe(): string {
    return `移动 ${this.entity.name} 到 ${this.newPos.toString()}`;
  }
}

// 宏命令：组合多个原子命令作为一个操作
class MacroCommand implements ICommand {
  private commands: ICommand[] = [];

  add(cmd: ICommand): void { this.commands.push(cmd); }

  execute(): void {
    this.commands.forEach(c => c.execute());
  }

  undo(): void {
    // 撤销顺序必须与执行相反！
    [...this.commands].reverse().forEach(c => c.undo());
  }

  describe(): string {
    return `批量操作 (${this.commands.length} 步)`;
  }
}
```

**2. 撤销/重做管理器（双栈架构）**

```
用户操作流程：

  执行命令 EXECUTE
       │
       ▼
  ┌─────────┐         ┌─────────┐
  │ Undo    │ ← 压入   │ Redo    │ ← (撤销时压入)
  │ Stack   │         │ Stack   │
  │ ┌─────┐ │         │         │
  │ │ C3  │ │ (栈顶)  │         │
  │ ├─────┤ │         │         │
  │ │ C2  │ │         │         │
  │ ├─────┤ │         │         │
  │ │ C1  │ │ (栈底)  │         │
  │ └─────┘ │         │         │
  └─────────┘         └─────────┘

  UNDO: C3 弹出 → 执行 C3.undo() → 压入 Redo 栈
  REDO: 弹出 Redo 栈顶 → 执行 execute() → 压回 Undo 栈
  新命令: 清空 Redo 栈（分支被废弃）
```

```typescript
class UndoRedoManager {
  private undoStack: ICommand[] = [];
  private redoStack: ICommand[] = [];
  private maxHistory = 100; // 防止内存无限增长

  execute(cmd: ICommand): void {
    cmd.execute();
    this.undoStack.push(cmd);
    // 新命令执行后，Redo 分支失效
    this.redoStack = [];
    // 超出上限时丢弃最旧的历史
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.execute();
    this.undoStack.push(cmd);
    return true;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
}
```

**3. 差异存储 vs 快照存储对比**

| 维度 | 差异（Delta）存储 | 快照（Snapshot/Memento）存储 |
|------|------------------|---------------------------|
| 内存占用 | 极低（只存变化部分） | 高（存完整状态副本） |
| 实现复杂度 | 高（每个命令手写逆操作） | 低（通用序列化/深拷贝） |
| 撤销速度 | 快（直接赋值旧值） | 中（反序列化恢复） |
| 适用场景 | 频繁的小改动（移动、属性变更） | 大范围改动（整体场景重置） |
| 典型游戏场景 | 关卡编辑器中拖拽实体 | "回到 N 回合前"的时光倒流 |
| 组合命令支持 | 天然支持（MacroCommand） | 需额外标记快照边界 |

### ⚡ 实战经验

- **撤销顺序至关重要**：宏命令的 `undo` 必须逆序执行，否则会引发中间状态错误。曾有项目把批量移动 50 个单位的 undo 写成正序，导致实体间碰撞穿透
- **引用陷阱**：命令对象必须存储**值的快照**（如 `{x, y, z}` 的副本），而非引用同一 Vec3 对象。否则后续修改会污染历史记录，撤销失效
- **内存上限要设**：不限上限的 Undo 栈在长时间编辑后可吃掉数百 MB，线上项目设 `maxHistory = 50~100` 较为合理
- **序列化持久化**：如果编辑器需要保存操作历史供下次打开恢复，命令对象必须支持序列化/反序列化，注意函数引用和闭包无法直接 JSON 化
- **合并连续操作**：拖拽实体时每帧产生一个 MoveCommand 会导致撤销粒度太细，应该在鼠标抬起时合并为一个命令

### 🔗 相关问题

- 如何实现多人协作编辑时的冲突合并（OT 算法 / CRDT）？
- 命令模式与事件溯源（Event Sourcing）有什么关系？
- 回合制游戏的"悔棋"功能与编辑器撤销有什么设计差异？
