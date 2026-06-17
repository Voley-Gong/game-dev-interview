---
title: "访问者模式在游戏里有什么用？什么是双重分派？"
category: "programming"
level: 3
tags: ["设计模式", "访问者模式", "双重分派", "序列化", "AST", "技能系统"]
related: ["programming/decorator-buff-system", "programming/strategy-pattern-game", "programming/serialization-save-system"]
hint: "不是'遍历集合'——是'对结构稳定但操作多变的数据结构，把操作外置'，靠双重分派在两个类型维度上联合决定执行哪个方法。"
---

## 参考答案

### ✅ 核心要点

1. **访问者模式解决"操作多变、结构稳定"的痛点**：当一类对象（如技能配置树节点）的类型种类固定（新增节点类型很罕见），但要对它们执行的操作经常新增（序列化、校验、导出 Excel、生成描述文本……），把操作写进节点类会导致每个类被频繁修改。访问者把这些操作抽到独立的 Visitor 类里，节点类只需暴露一个 `accept(visitor)` 入口，新增操作 = 新增一个 Visitor，节点类零改动，符合开闭原则。
2. **双重分派（Double Dispatch）是访问者的机制核心**：普通多态是"单分派"——只根据 `this` 的运行时类型选方法。访问者通过两次方法调用（`node.accept(visitor)` → `visitor.visitConcreteNode(this)`）让"节点类型"和"访问者类型"两个维度**联合**决定执行哪个 `visit` 方法，从而在每个具体 Visitor 内部拿到精确的子类型，不用 `instanceof` 判断。
3. **典型游戏场景是 AST / 配置树的多种处理**：技能配置往往是树（`SkillNode` 下有 `DamageNode`、`BuffNode`、`SummonNode`、`ConditionNode`），同一种树要被"序列化存档""校验合法性""翻译成战斗字节码""生成策划可读描述"四种操作处理。把这四种操作各写成一个 Visitor，节点类只保留 `accept`，比在每个节点类里塞四个 `serialize/validate/compile/describe` 方法干净得多。
4. **与迭代器/责任链的本质区别**：迭代器统一"怎么遍历"但不关心"对不同类型做什么"；访问者统一"对不同类型做不同事"，遍历可以由访问者自己驱动或外部迭代器驱动。责任链是"一个请求沿链传递直到某个处理者接管"，关注的是**谁能处理**；访问者关注的是**对每种类型分别执行什么**。
5. **代价是违反依赖倒置、对"新增元素类型"不友好**：访问者要求每个节点类都"认识" Visitor 基类（要写 `accept` 方法），节点依赖了 Visitor 抽象，方向反了。更致命的是——一旦新增一个节点类型（比如 `TeleportNode`），所有现有 Visitor 都得加一个 `visitTeleport` 方法，否则编译失败。所以访问者只适合"节点类型极少变动、操作经常变动"的场景，反过来就该用别的设计。
6. **TypeScript 中用方法重载保证类型安全**：JS 是动态语言单分派，访问者靠手动两次分发模拟双重分派。TypeScript 用 `visit` 方法重载（`visitDamage(n: DamageNode)`、`visitBuff(n: BuffNode)`……）让编译器在 Visitor 内部对每种节点类型精确推断，漏写一个 `visit` 分支会被调用方 `accept` 的类型签名约束报错。

### 📖 深度展开

**1. 双重分派的机制图解**

```
普通单分派（普通多态）：只看 this 的运行时类型
  nodes.forEach(n => n.describe())
       └─ 运行时根据 n 是 DamageNode 还是 BuffNode 调对应 describe
       缺点：describe 的逻辑被钉死在节点类里，新增操作要改所有节点类

访问者双重分派：两次方法调用，两个类型维度联合决定
  ① n.accept(visitor)        —— 第1次分派：看 n 的实际类型
  ② visitor.visitXxx(this)   —— 第2次分派：看 visitor 的实际类型 + 节点具体类型
       ↓
  执行的是 (节点具体类型 × Visitor具体类型) 唯一对应的那个方法

  调用链可视化：
  SerializeVisitor V
        │
  nodes.forEach(n => n.accept(V))
        │
        ├─ DamageNode.accept(V)  ──►  V.visitDamage(this)   // 2次分派命中
        ├─ BuffNode.accept(V)    ──►  V.visitBuff(this)
        └─ SummonNode.accept(V)  ──►  V.visitSummon(this)

  关键：节点类的 accept 写法是固定的"回调 V.visitXxx(this)"，
        真正的逻辑全在 Visitor 里，节点类永远不用改
```

**2. 技能配置 AST 的 Visitor 实现**

```typescript
// ── 节点基类与具体节点（结构稳定，很少新增） ──
interface SkillNode {
  children: SkillNode[];
  // 双重分派入口：每个具体节点 accept 时回调 visitor 的对应 visit 方法
  accept<V extends SkillVisitor>(visitor: V): void;
}
class DamageNode implements SkillNode {
  constructor(public amount: number, public element: string, public children: SkillNode[] = []) {}
  accept<V extends SkillVisitor>(v: V): void { v.visitDamage(this); }   // 回调精确类型
}
class BuffNode implements SkillNode {
  constructor(public buffId: string, public duration: number, public children: SkillNode[] = []) {}
  accept<V extends SkillVisitor>(v: V): void { v.visitBuff(this); }
}
class SummonNode implements SkillNode {
  constructor(public monsterId: number, public count: number, public children: SkillNode[] = []) {}
  accept<V extends SkillVisitor>(v: V): void { v.visitSummon(this); }
}

// ── Visitor 接口：每种节点一个 visit 重载（新增操作只需新增 Visitor 实例） ──
interface SkillVisitor {
  visitDamage(n: DamageNode): void;
  visitBuff(n: BuffNode): void;
  visitSummon(n: SummonNode): void;
}

// 操作①：序列化成存档 JSON —— 一个独立的 Visitor
class SerializeVisitor implements SkillVisitor {
  readonly out: unknown[] = [];
  private stack: unknown[] = [this.out];
  visitDamage(n: DamageNode) {
    const obj = { type: 'damage', amount: n.amount, element: n.element, children: [] };
    (this.stack[this.stack.length - 1] as unknown[]).push(obj);
    this.stack.push(obj.children);
    n.children.forEach(c => c.accept(this));  // 递归遍历子节点
    this.stack.pop();
  }
  visitBuff(n: BuffNode) {
    const obj = { type: 'buff', id: n.buffId, duration: n.duration, children: [] };
    (this.stack[this.stack.length - 1] as unknown[]).push(obj);
    this.stack.push(obj.children);
    n.children.forEach(c => c.accept(this));
    this.stack.pop();
  }
  visitSummon(n: SummonNode) {
    (this.stack[this.stack.length - 1] as unknown[]).push({ type: 'summon', id: n.monsterId, count: n.count });
  }
}

// 操作②：校验配置合法性 —— 另一个 Visitor，节点类零改动
class ValidationVisitor implements SkillVisitor {
  errors: string[] = [];
  visitDamage(n: DamageNode) {
    if (n.amount < 0) this.errors.push(`伤害值不能为负: ${n.amount}`);
    if (!['fire', 'ice', 'thunder'].includes(n.element)) this.errors.push(`未知元素: ${n.element}`);
  }
  visitBuff(n: BuffNode) {
    if (n.duration > 3600) this.errors.push(`Buff 时长超限: ${n.buffId}=${n.duration}s`);
  }
  visitSummon(n: SummonNode) {
    if (n.count > 10) this.errors.push(`召唤数量异常: ${n.count}`);
  }
}
// 使用：同一棵树，换 Visitor 就换操作，节点类完全不感知
const tree: SkillNode = buildSkillTree();
const ser = new SerializeVisitor(); tree.accept(ser);  // 得到存档 JSON
const val = new ValidationVisitor(); tree.accept(val);  // 得到错误列表
```

**3. 访问者 vs 责任链 vs 策略 vs instanceof 链 对比**

| 维度 | 访问者模式 | 责任链模式 | 策略模式 | `instanceof` 链 |
|------|-----------|-----------|---------|----------------|
| **核心意图** | 对异构集合按类型分发操作 | 请求沿链传递直到被处理 | 可互换的算法族 | 暴力类型判断分支 |
| **分派维度** | 双重分派（类型×操作） | 不分派（逐个尝试） | 单分派（选哪个算法） | 手动判断 |
| **新增操作** | ✅ 加 Visitor，零改节点 | ⚠️ 加处理者 | ✅ 加策略 | ❌ 改所有 switch |
| **新增元素类型** | ❌ 改所有 Visitor + 接口 | ✅ 加节点 | ⚠️ 看策略粒度 | ✅ 加 case |
| **类型安全** | ✅ 编译期精确（TS 重载） | ❌ 运行时 | ✅ 接口约束 | ❌ 易漏分支 |
| **游戏典型场景** | 技能 AST 序列化/校验、UI 树渲染 | 伤害计算链、事件冒泡 | 伤害算法、AI 行为 | 简单一次性处理 |
| **适用判据** | 类型稳定、操作多变 | 多个潜在处理者 | 算法平级可换 | 节点少、操作少 |

```
何时该用访问者 —— 决策树：

  对一批异构对象要执行多种操作？
     ├─ 否 → 别用访问者
     └─ 是 → 对象类型种类会频繁新增吗？
              ├─ 是 → ❌ 别用访问者（每次加类型要改所有 Visitor）
              │       考虑：把操作做成节点方法（OOP 多态）或策略模式
              └─ 否 → ✅ 用访问者（操作可无限新增，类型稳定）
                       典型：AST、配置树、编译器 IR、固定组件类型集合
```

### ⚡ 实战经验

- **配置树序列化用 Visitor 替代 instanceof 链**：早期技能存档写成 `if (n instanceof DamageNode) {...} else if (n instanceof BuffNode) {...}`，9 种节点 × 3 种操作（存档/校验/描述）= 27 个分支散落，新增一种操作要改 9 处还容易漏。改成 Visitor 后每种操作一个类，新增操作只加一个 Visitor 类文件，5 万行技能模块的"序列化相关" bug 从每月 3~4 个降到接近零。
- **新增节点类型是访问者的阿喀琉斯之踵**：上线半年后策划要做"传送技能"，新增 `TeleportNode`，结果 `SerializeVisitor`、`ValidationVisitor`、`DescribeVisitor`、`CompileVisitor` 四个 Visitor 全部漏了 `visitTeleport`，TypeScript 重载约束在编译期一次性全报错——这恰恰是访问者"用类型安全换扩展性"的价值。如果是 JS（无编译期检查）这个漏配会到运行时才炸，所以访问者在 TS 项目里收益最大。
- **TypeScript 方法重载是访问者类型安全的关键**：把 `visit` 写成单一方法 `visit(n: SkillNode)` 会丢失具体类型，Visitor 内部又得 `instanceof`，退化成没意义。必须用重载 `visitDamage(n: DamageNode)` / `visitBuff(n: BuffNode)` 让 `accept` 回调时编译器知道 `this` 是精确子类型，漏写分支编译期就拦住。这一步把"运行时漏配"变成"编译期报错"，是访问者在 TS 里值得用的核心理由。
- **访问者别用在"节点类型会膨胀"的场景**：曾尝试用访问者处理"所有 UI 组件类型"，结果 UI 组件从 12 种涨到 47 种（按钮/图片/列表/滚动/富文本…），每加一种组件要改十几个 Visitor，维护噩梦。正确判断是：UI 组件类型**频繁新增**，应该用组件自带的 `render`/`serialize` 方法（OOP 多态）。访问者只适合类型封闭的 AST/IR/配置树。
- **访问者 + 生成器模式组合做配置导出**：策划要导出技能树到 Excel，用 `ExcelExportVisitor` 遍历树生成行，配合 Builder 模式按层级组装单元格样式（标题行/数据行/汇总行），比在节点类里写 `toExcelRow` 灵活得多——后来策划要求加一列"技能标签"，只改了 ExportVisitor 一个类，节点定义零改动。

### 🔗 相关问题

1. 为什么很多函数式语言（Scala/Haskell/Rust）几乎不需要访问者模式？模式匹配（pattern matching / match）是如何在语言层面替代访问者的？各自的扩展代价是什么？
2. 访问者模式和编译器的 AST 遍历是什么关系？LLVM/TypeScript 编译器内部的 Visitor 是怎么用的？"外部访问者"和"内部 visitor 模式回调"（如 tsc 的 `visitEachChild`）有何区别？
3. 在 ECS 架构里，组件类型理论上可以无限新增，访问者模式还有用武之地吗？什么情况下 ECS 反而不该用访问者？
