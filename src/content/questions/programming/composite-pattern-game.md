---
title: "游戏场景图与UI树如何用组合模式（Composite）统一管理？"
category: "programming"
level: 2
tags: ["设计模式", "组合模式", "场景图", "结构型模式", "UI"]
related: ["programming/ecs-architecture", "programming/mediator-pattern-game", "programming/dirty-flag-pattern"]
hint: "叶子节点和容器节点实现同一个接口——递归组合出任意层级的树，客户端不区分个体与整体。"
---

## 参考答案

### ✅ 核心要点

1. **统一接口是组合模式的灵魂**：叶子（Leaf，如 Sprite）和组合（Composite，如 Layer）实现同一个 `Component` 接口，客户端无需关心操作的是单个对象还是整棵子树——`render()`、`update()`、`destroy()` 都是一行调用，这是"忽略个体差异"的封装。
2. **树形递归天然匹配游戏世界**：场景图（Scene Graph）、UI 树（Widget Tree）、背包嵌套（背包里套背包）、技能链（技能套 buff）都是树。组合模式让"父变换影响所有子节点"（位置/旋转/缩放矩阵继承）成为内置行为，而非每处手写。
3. **变换继承是性能与正确性的关键**：子节点世界矩阵 = 父世界矩阵 × 子局部矩阵。配合 dirty flag，只有祖先变化时才重算，避免每帧对 10000 个节点做矩阵乘法——这是 Cocos/Unity 场景图的核心优化。
4. **增删子节点要处理父子双向引用**：`addChild` 不仅要 `child.parent = this`，还要从旧父节点移除、触发 enter/exit 事件、更新裁剪索引。漏掉一步就会出现"幽灵节点"或内存泄漏（旧父仍持有引用导致 GC 不掉）。
5. **典型陷阱：透明容器、Z 序、事件冒泡**：透明度 0 的容器仍会渲染子节点（白渲染浪费），事件从子向父冒泡需要 `stopPropagation`，Z 序既要支持同级排序又要支持跨层级。
6. **与 ECS 是互补而非替代**：ECS 把"数据+逻辑"拆开，但场景图的层级关系（变换继承、视锥裁剪、事件冒泡）仍是树。现代引擎（Cocos 3.x、Unity DOTS）用 ECS 存数据，同时保留一棵场景图管理层级——两者各管一摊。

### 📖 深度展开

**1. 组合模式基础结构 + 场景图节点**

```typescript
interface SceneNode {                       // 统一接口：叶子与组合共用
  readonly name: string;
  render(ctx: RenderContext): void;
  update(dt: number): void;
  getWorldMatrix(): Mat4;
}

class Sprite implements SceneNode {         // 叶子：无子节点，真正绘制
  constructor(public name: string, private local: Transform, private tex: Texture) {}
  render(ctx: RenderContext) { ctx.draw(this.tex, this.getWorldMatrix()); }
  update(_: number) {}
  getWorldMatrix() { return this.local.toMatrix(); }
}

class Group implements SceneNode {          // 组合：持有子节点，递归委托
  private children: SceneNode[] = [];
  private worldDirty = true;                // dirty flag：脏时才重算
  private cachedWorld = Mat4.identity();
  constructor(public name: string, private local: Transform, private parent?: Group) {}

  addChild(c: SceneNode & { parent?: Group }) {
    c.parent?.removeChild(c);               // ★ 先从旧父移除，避免双挂
    this.children.push(c); (c as any).parent = this;
    this.markDirty();
  }
  removeChild(c: SceneNode) { /* splice + c.parent = undefined + markDirty */ }
  render(ctx: RenderContext) { for (const c of this.children) c.render(ctx); }
  update(dt: number)         { for (const c of this.children) c.update(dt); }
  getWorldMatrix(): Mat4 {
    if (this.worldDirty) {
      const p = this.parent?.getWorldMatrix() ?? Mat4.identity();
      this.cachedWorld = p.multiply(this.local.toMatrix());
      this.worldDirty = false;
    }
    return this.cachedWorld;
  }
  private markDirty() { this.worldDirty = true; for (const c of this.children)
    if (c instanceof Group) c.markDirty(); }  // 递归脏标记子树
}
```

**2. 场景图遍历与变换继承**

```
场景树                         世界矩阵计算（父 × 局部）
Root (世界原点 I)
 ├─ Camera                     world = I
 ├─ World                      world = I × Local(World)
 │   ├─ Enemy_1                world = World × Local(Enemy_1)
 │   └─ Squad (旋转 30°)       world = World × Rot(30°)
 │       └─ Enemy_2            world = Squad × Local    ← 自动继承 30° 旋转
 └─ UI                         world = I × Local(UI)
     └─ Button                 world = UI × Local

渲染（深度优先递归）：
  visit(node):
    if node is Group:
      pushMatrix(node.local)
      for child in node.children: visit(child)   ← 委托给子节点
      popMatrix()
    else:
      draw(node)                                 ← 叶子才真正提交 DrawCall
```

**3. 组合模式 vs 其他组织方式对比**

| 维度 | 组合模式（场景树） | 扁平数组 + parentId | ECS Parent 组件 |
|------|---------------------|---------------------|------------------|
| 变换继承 | 内置自动 | 手动递归查父链 | 需 ParentComponent + 系统 |
| 增删节点 | O(子节点数) 移除 | O(1) 改 ID | O(1) 改组件 |
| 缓存友好度 | 差（指针跳跃） | 中（数组+查表） | 好（同类型连续） |
| 事件冒泡 | 天然支持 | 需手动实现 | 需事件总线 |
| 视锥裁剪 | 子树整体剔除 | 难 | 需层级裁剪系统 |
| 适用场景 | UI、动画层级、小场景 | 静态大世界 | 海量同类实体 |

### ⚡ 实战经验

- **`parent` 变更没递归清子节点脏标记**：移动父节点后子节点 `cachedWorld` 还是旧值，导致"父动子不动"。我们项目曾出现 boss 移动时小怪贴图留在原地的诡异 bug，根因就是 `parent` setter 没递归 `markDirty()`。修复方式是在 `parent` 变更时内联触发整棵子树 dirty。
- **透明度 0 ≠ 不渲染**：UI 弹窗设 `alpha = 0` 隐藏后仍在跑 `render`，500 节点的弹窗在低端机上吃 3ms/帧。正确做法是 `active = false` 走整子树剪枝，或显式 `visible = false` 让 `visit` 提前 return。
- **`addChild` 没移除旧父节点**：把节点 A 从 Group1 挪到 Group2，只调 `Group2.addChild(A)` 没触发 `Group1.removeChild(A)`，结果 A 被渲染两次、update 跑两次、事件触发两遍。务必在 `addChild` 内部先 `oldParent?.removeChild(this)`。
- **事件冒泡忘记 stopPropagation**：背包格子点击事件冒泡到 ScrollView，点击同时触发滚动。规则：业务回调显式 `e.stopPropagation()`，框架默认冒泡但提供拦截点。
- **大场景深度遍历爆栈**：程序化生成 1000+ 层嵌套的链表式场景，递归 `render` 直接 stack overflow。改成显式栈迭代 + 帧预算切片（每帧最多遍历 N 个节点）后才稳定。

### 🔗 相关问题

1. 场景图的 dirty flag 怎么实现？父节点变化时如何只更新受影响子树，而非全树重算？
2. 组合模式 vs ECS 的 Parent 组件：现代引擎为什么还保留场景图？两者如何协作？
3. UI 树的事件冒泡和 DOM 一样吗？`capture`/`bubble` 两阶段在游戏 UI 里怎么用？
