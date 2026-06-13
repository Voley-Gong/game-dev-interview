---
title: "游戏中的设计模式：单例、工厂、命令模式怎么用？"
category: "programming"
level: 1
tags: ["设计模式", "游戏架构"]
hint: "设计模式不是教科书概念，而是解决游戏开发中实际问题的工具。"
---

## 参考答案

### ✅ 核心要点

| 模式 | 游戏应用 | 解决什么问题 |
|------|----------|-------------|
| **单例** | GameManager, AudioManager | 全局唯一访问点 |
| **工厂** | 敌人生成、技能创建 | 解耦创建和使用 |
| **命令** | 输入处理、技能队列、撤销/重做 | 操作封装和排队 |
| **状态** | 角色状态机 | 状态转换管理 |
| **策略** | AI 行为切换 | 算法可替换 |

### 📖 深度展开

**1. 单例模式（谨慎使用）**

```typescript
// 泛型单例基类（Cocos / TypeScript）
export class Singleton<T> {
  private static _instances: Map<Function, any> = new Map();
  
  static getInstance<U extends Singleton<U>>(this: new () => U): U {
    if (!Singleton._instances.has(this)) {
      Singleton._instances.set(this, new this());
    }
    return Singleton._instances.get(this);
  }
}

// 使用
class GameManager extends Singleton<GameManager> {
  private _score: number = 0;
  get score() { return this._score; }
  addScore(n: number) { this._score += n; }
}

// 调用
GameManager.getInstance().addScore(10);
```

**注意**：单例是全局状态，滥用导致难以测试和维护。

**2. 工厂模式**

```typescript
// 技能工厂
interface ISkill {
  activate(caster: Character): void;
}

class SkillFactory {
  private creators: Map<string, () => ISkill> = new Map();
  
  register(type: string, creator: () => ISkill) {
    this.creators.set(type, creator);
  }
  
  create(type: string): ISkill {
    const creator = this.creators.get(type);
    if (!creator) throw new Error(`Unknown skill: ${type}`);
    return creator();
  }
}

// 注册
factory.register('fireball', () => new FireballSkill());
factory.register('heal', () => new HealSkill());

// 使用 — 创建和使用解耦
const skill = factory.create(skillType);
skill.activate(player);
```

**3. 命令模式（游戏最实用的模式之一）**

```typescript
// 输入 → 命令对象 → 执行
interface ICommand {
  execute(): void;
  undo(): void;  // 支持撤销
}

class MoveCommand implements ICommand {
  constructor(private unit: Unit, private dx: number, private dy: number) {}
  
  execute() { this.unit.move(this.dx, this.dy); }
  undo() { this.unit.move(-this.dx, -this.dy); }
}

// 回放系统 = 重新执行所有记录的命令
// 撤销系统 = 反向执行命令栈
```

### ⚡ 实战经验

- **单例能少用就少用**：依赖注入是更好的替代方案
- **命令模式 + 回合制**：回合制游戏的技能队列天然适合命令模式
- **对象池 + 工厂**：工厂创建的对象走对象池复用
- **不要过度设计**：3 个类能解决的问题别用 7 个设计模式
