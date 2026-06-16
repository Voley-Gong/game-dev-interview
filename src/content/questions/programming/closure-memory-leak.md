---
title: "闭包陷阱与内存泄漏排查：为什么我的游戏越玩越卡？"
category: "programming"
level: 2
tags: ["闭包", "内存泄漏", "JavaScript", "性能优化", "垃圾回收"]
related: ["programming/memory-gc-optimization", "programming/event-bus-architecture", "programming/deep-vs-shallow-copy"]
hint: "闭包不只是面试八股——它是游戏项目中 #1 的隐性内存泄漏元凶。"
---

## 参考答案

### ✅ 核心要点

1. **闭包的本质是"函数 + 它捕获的外层作用域变量的引用"**：只要这个函数还活着（被某处引用着），它捕获的变量就无法被 GC 回收。这不是 bug 而是语言特性——但如果你不知道哪个函数持有谁，就会泄漏。
2. **游戏项目中最常见的三大闭包泄漏源**：① 事件监听器 `addEventListener` 注册后未移除；② `setInterval` / `requestAnimationFrame` 回调持有大对象；③ 模块级缓存（Map / 数组）把临时对象引用住，永远不清理。
3. **闭包捕获的是变量引用而非值快照**：`for` 循环中 `setTimeout(() => console.log(i), 0)` 全部打印最终值，因为所有回调共享同一个 `i`。用 `let`（块级作用域）或 `((j) => { ... })(i)` 立即执行函数可修复。
4. **WeakMap / WeakSet 是防泄漏利器**：用 WeakMap 关联"对象 → 额外数据"，当对象本身被回收时，WeakMap 中的条目自动消失，不会阻止 GC。适合做组件元数据缓存。
5. **Chrome DevTools Memory 面板是排查标准工具**：拍 Heap Snapshot → 操作 → 再拍 → 对比（Comparison）模式查看 Delta 列，哪些对象只增不减一目了然。

### 📖 深度展开

**1. 闭包持有链与泄漏机制**

```
正常情况：                          泄漏情况：

  EventManager                       EventManager
    └─ listeners[]                     └─ listeners[]
         └─ handler()                       └─ handler()
              └─ 捕获: enemyObj                  └─ 捕获: enemyObj
                                                （含整个 Entity）
  enemyObj 被其他地方释放 →
  handler 也移除 → 全部可回收       handler 忘记移除 →
                                    enemyObj 永远活着 ❌

  根因：listeners 数组是"GC Root"链上的一环
        只要 handler 还在数组里 → 它捕获的 enemyObj 就无法回收
```

**2. 典型泄漏场景与修复**

```typescript
// ❌ 泄漏场景1：事件监听器未移除
class EnemyAI {
  private entity: Entity;
  constructor(entity: Entity, input: InputManager) {
    this.entity = entity;
    // 闭包捕获了 this（整个 EnemyAI 实例 + entity）
    input.on('attack', (key) => {
      this.entity.attack(key);  // this.entity 被闭包持有
    });
    // EnemyAI 销毁时没有 off → 这个箭头函数永远留在 input 的监听列表里
  }
  destroy() {
    // 忘了移除监听！this.entity 永远无法回收
  }
}

// ✅ 修复：保存引用，销毁时移除
class EnemyAI {
  private handler: (key: string) => void;
  constructor(entity: Entity, input: InputManager) {
    this.entity = entity;
    this.handler = (key) => this.entity.attack(key);
    input.on('attack', this.handler);
  }
  destroy() {
    this.input.off('attack', this.handler); // 显式移除
    this.handler = null;
  }
}
```

```typescript
// ❌ 泄漏场景2：定时器持有大对象
class SkillSystem {
  startCooldown(skill: Skill) {
    // 闭包捕获了 skill（含动画、特效引用，可能数 MB）
    setTimeout(() => {
      skill.ready = true;
    }, 10000);
    // 如果角色在这 10 秒内被销毁，skill 仍被定时器持有
  }
}

// ✅ 修复：销毁时 clear + 用 WeakRef 弱引用（ES2021）
class SkillSystem {
  private timers = new Map<number, WeakRef<Skill>>();
  startCooldown(skill: Skill) {
    const id = setTimeout(() => {
      const s = this.timers.get(id)?.deref();
      if (s) s.ready = true;  // 对象已被回收则跳过
      this.timers.delete(id);
    }, 10000);
    this.timers.set(id, new WeakRef(skill));
  }
}
```

**3. 排查工具与防护策略对比**

| 策略 | 适用场景 | 效果 | 缺陷 |
|------|---------|------|------|
| 手动 off / clear | 事件监听、定时器 | 100% 根除 | 依赖纪律，易遗漏 |
| WeakMap 缓存元数据 | 组件附加数据 | 自动随对象回收 | 不能存原始类型 key |
| WeakRef + FinalizationRegistry | 异步回调持有对象 | 不阻止 GC | 回调时机不确定 |
| 对象池 + 手动 reset | 高频创建的临时对象 | 减少分配 | 需池化管理代码 |
| Heap Snapshot 对比 | 排查已有泄漏 | 精确定位 | 手动操作，非自动化 |

> **DevTools 排查流程**：① Performance → Memory 勾选 → 录制操作 → 看 JS Heap 曲线是否阶梯式上升不回落。② Memory → Heap Snapshot → 操作前后各拍一次 → Comparison 模式 → 按 Delta 排序，找出 `# New` 远大于 `# Deleted` 的类型。

### ⚡ 实战经验

- **角色频繁创建销毁导致内存阶梯式上涨**：一款 ARPG 实测每打一波小怪（约 30 个敌人创建销毁），Chrome 内存涨 8MB 且不回落。排查发现 `EventBus.on('damage', handler)` 中 handler 闭包捕获了整个 Enemy 组件。加 `destroy()` 里统一 `off` 后，内存稳定在 120MB 不再增长。
- **`requestAnimationFrame` 回调泄漏最隐蔽**：一个 UI 动画组件在 `onEnable` 里注册 rAF，`onDisable` 里没有 `cancelAnimationFrame`。组件虽然从场景树移除，但 rAF 回调每帧执行，闭包持有整个组件树。50 个 UI 切换后帧率从 60 掉到 30。修复：所有 rAF 必须配对 cancel。
- **箭头函数赋值给实例属性是安全写法**：`this.handler = () => { ... }` 比 `input.on('attack', () => { this.doSomething() })` 安全得多，因为你有引用可以 off。匿名箭头函数直接传入后无法精确移除（`off` 需要同一个函数引用）。
- **用 WeakMap 做实体元数据缓存**：曾经用 `Map<Entity, Metadata>` 缓存 5000 个实体的渲染信息，实体销毁后 Map 条目仍在，内存泄漏 40MB。改用 `WeakMap<Entity, Metadata>` 后，实体被 GC 时元数据自动回收，内存稳定在 60MB。
- **模块级单例的监听器列表是"隐形 GC Root"**：全局 `EventBus` 的 `_listeners` 数组永远不会被回收，任何注册上去的回调都永久存活。必须在游戏场景切换时调用 `EventBus.clear()` 清空，否则切换 5 次场景后监听器列表膨胀到上千个。

### 🔗 相关问题

1. V8 引擎的标记-清除（Mark-Sweep）GC 算法是如何判断"可达性"的？GC Root 包含哪些？
2. `WeakRef` 和 `FinalizationRegistry` 的回调时机为什么不确定？能用来做资源释放吗？
3. 对象池（Object Pool）和 GC 的关系是什么？什么场景下对象池反而比让 GC 回收更差？
