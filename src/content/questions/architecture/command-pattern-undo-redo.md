---
title: "命令模式怎么用？如何在游戏中实现撤销/重做系统？"
category: "architecture"
level: 3
tags: ["命令模式", "设计模式", "撤销重做", "架构设计"]
related: ["architecture/solid-principles-game", "architecture/module-decoupling-bus-signal"]
hint: "把每个操作封装成对象（Command），用两个栈（Undo / Redo）管理操作历史。"
---

## 参考答案

### ✅ 核心要点

1. **命令模式本质**：将"请求"封装成对象，解耦发起者（Invoker）和执行者（Receiver）
2. **撤销/重做核心**：每个 Command 同时实现 `Execute()` 和 `Undo()`，用两个栈管理历史
3. **可组合性**：宏命令（Macro Command）将多个原子命令组合成一个可整体撤销的复合操作
4. **序列化能力**：Command 对象天然可序列化，支持录制回放、网络同步、自动化测试
5. **典型应用**：关卡编辑器、建造系统、棋类游戏、回合制战斗、UI 操作历史

### 📖 深度展开

**命令模式基础结构：**

```typescript
// 命令接口：执行 + 撤销
interface ICommand {
  execute(): void;
  undo(): void;
  readonly description: string;
}

// 具体命令：放置方块
class PlaceBlockCommand implements ICommand {
  description: string;
  private prevBlock: BlockType | null;

  constructor(
    private world: GameWorld,
    private pos: Vec3,
    private blockType: BlockType
  ) {
    this.description = `放置 ${blockType} @ ${pos}`;
  }

  execute(): void {
    this.prevBlock = this.world.getBlock(this.pos); // 记录前态
    this.world.setBlock(this.pos, this.blockType);
  }

  undo(): void {
    this.world.setBlock(this.pos, this.prevBlock);  // 恢复前态
  }
}
```

**撤销/重做系统实现：**

```typescript
class UndoRedoManager {
  private undoStack: ICommand[] = [];
  private redoStack: ICommand[] = [];
  private maxHistory = 100;

  // 执行一个新命令
  execute(cmd: ICommand): void {
    cmd.execute();
    this.undoStack.push(cmd);
    this.redoStack = []; // 新操作后清空 Redo 栈
    this.trimHistory();
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

  private trimHistory(): void {
    while (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift(); // 丢弃最旧命令
    }
  }

  // 批量操作 → 合并为一个宏命令
  beginMacro(desc: string): void {
    this._macro = new MacroCommand(desc);
  }
  endMacro(): void {
    if (this._macro) { this.execute(this._macro); this._macro = null; }
  }
}

// 宏命令：整体执行、整体撤销
class MacroCommand implements ICommand {
  private cmds: ICommand[] = [];
  constructor(public description: string) {}

  add(cmd: ICommand) { this.cmds.push(cmd); }

  execute(): void { this.cmds.forEach(c => c.execute()); }
  undo(): void { [...this.cmds].reverse().forEach(c => c.undo()); }
}
```

**操作流转示意：**

```
用户操作序列：放置A → 放置B → 放置C

执行后：
  UndoStack: [PlaceA, PlaceB, PlaceC]
  RedoStack: []

撤销一次（Undo）：
  UndoStack: [PlaceA, PlaceB]
  RedoStack: [PlaceC]       ← C 被撤销，放入 Redo

此时执行新操作「放置D」：
  UndoStack: [PlaceA, PlaceB, PlaceD]
  RedoStack: []             ← C 的 Redo 机会被丢弃

宏命令场景：拖拽放置 10 个方块
  beginMacro("批量放置")
    → 10 次 PlaceBlock 各自 execute()
  endMacro()
  UndoStack: [..., MacroCommand(10个方块)]
  → 一次 Undo 即可全部撤销
```

**命令模式在各场景中的应用：**

| 场景 | 命令封装内容 | 撤销意义 |
|------|-------------|---------|
| 关卡编辑器 | 放置/删除/移动物体 | 误操作回退 |
| 建造系统（模拟经营） | 建造/拆除/升级建筑 | 玩家后悔操作 |
| 回合制战斗 | 移动/攻击/使用道具 | 悔棋（PVE） |
| UI 编辑器 | 拖拽/改属性/删组件 | 工具操作历史 |
| 录制宏（Macro Recording） | 记录命令序列 → 自动化重放 | 批量自动化 |

**与传统事件系统的区别：**

```
事件系统（Event / 信号）：
  发出事件 → 多个监听者各自处理 → 无法撤销
  适合：通知、广播、解耦通信

命令模式：
  创建命令 → 入栈执行 → 可撤销/重做/序列化
  适合：需要操作历史、可逆操作、可记录重放的场景
```

### ⚡ 实战经验

- **Undo 必须保存"前态快照"而非"逆操作"**：如"放置方块"的撤销应该是"恢复之前的方块"，而不是"删除当前方块"——因为撤销前位置可能已有其他方块。保存前态比计算逆操作更可靠
- **宏命令是批量操作的救命稻草**：玩家拖拽一次放下 100 个方块，如果没有宏命令，Undo 100 次才能全部撤销。用 `beginMacro / endMacro` 将批量操作折叠为一条历史
- **内存敏感场景需要瘦身**：Undo 栈保存大量前态快照会吃内存。策略：(1) 限制最大历史条数（如 50~100）；(2) 对大对象存差异而非全量；(3) 提供"提交/清空历史"操作释放内存
- **网络多人场景慎用全局 Undo**：多人游戏中 Undo 一个操作可能影响其他玩家的状态。通常只对单人操作（编辑器、PVE 悔棋）启用，或在服务端验证 Undo 合法性

### 🔗 相关问题

- 如何将命令模式与 ECS 架构结合？
- 命令序列如何序列化用于网络同步或回放系统？
- 在实时战斗游戏中，撤销/重做还有意义吗？哪些场景适用？
