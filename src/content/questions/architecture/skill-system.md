---
title: "如何设计一个通用的技能系统？"
category: "architecture"
level: 3
tags: ["技能系统", "架构设计", "战斗系统"]
hint: "技能不是一个个硬编码的 if-else，而是数据驱动的可配置系统。"
---

## 参考答案

### ✅ 核心要点

1. **数据驱动**：技能效果通过配置表/JSON 描述，而非代码
2. **效果系统（Effect）**：每个效果是独立的原子操作
3. **条件系统（Condition）**：触发条件、目标筛选
4. **修饰器（Modifier）**：增益/减益效果
5. **时序控制**：前摇、施放、后摇的分帧执行

### 📖 深度展开

**架构设计：**

```
SkillData (配置)
  ├── id: "fireball"
  ├── castTime: 0.5s
  ├── cooldown: 3s
  ├── cost: { mp: 50 }
  ├── effects: [
  │     { type: "damage", value: 100, range: 3, shape: "circle" },
  │     { type: "buff", buffId: "burn", duration: 5 }
  │   ]
  ├── conditions: [
  │     { type: "hasResource", resource: "mp", amount: 50 }
  │   ]
  └── projectile: { prefab: "fireball", speed: 15 }
```

**核心类设计：**

```typescript
// 技能效果 — 原子操作
interface ISkillEffect {
  type: string;
  apply(caster: Entity, targets: Entity[]): void;
}

// 效果工厂 — 注册和创建效果
class EffectFactory {
  private creators = new Map<string, (data: any) => ISkillEffect>();
  
  register(type: string, creator: (data: any) => ISkillEffect) {
    this.creators.set(type, creator);
  }
  
  create(data: { type: string; [key: string]: any }): ISkillEffect {
    return this.creators.get(data.type)!(data);
  }
}

// 注册具体效果
factory.register('damage', (data) => ({
  type: 'damage',
  apply(caster, targets) {
    targets.forEach(t => t.takeDamage(data.value * caster.stats.atk));
  }
}));

factory.register('heal', (data) => ({
  type: 'heal',
  apply(caster, targets) {
    targets.forEach(t => t.heal(data.value));
  }
}));

// 技能执行器
class SkillExecutor {
  execute(caster: Entity, skill: SkillData, targets: Entity[]) {
    // 1. 消耗资源
    // 2. 进入 CD
    // 3. 播放前摇动画
    // 4. 应用效果
    skill.effects.forEach(e => {
      const effect = effectFactory.create(e);
      effect.apply(caster, targets);
    });
    // 5. 播放后摇
  }
}
```

**目标选择策略：**

| 策略 | 描述 | 用例 |
|------|------|------|
| Self | 自身 | 增益技能 |
| Nearest | 最近 N 个 | 普攻 |
| AOE Circle | 圆形范围 | 火球术 |
| AOE Rect | 矩形范围 | 冲刺斩 |
| All Enemies | 全部敌人 | 全屏大招 |

### ⚡ 实战经验

- **策划配置优先**：技能效果应该策划能配出来，而不是找程序加代码
- **数值平衡工具**：做一套可视化技能编辑器，策划自己调参数
- **战斗日志**：所有技能效果记录日志，方便复盘和调试
- **网络同步**：多人游戏中技能效果需要确定性执行
- **热加载**：运行时修改技能配置即时生效，加速调试迭代

### 🔗 相关问题

- 帧同步和状态同步怎么选？
- UI 框架如何设计？
