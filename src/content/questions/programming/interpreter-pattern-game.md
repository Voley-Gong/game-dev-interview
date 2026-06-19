---
title: "解释器模式（Interpreter）如何支撑游戏的对话/技能公式 DSL？什么时候该上完整脚本系统？"
category: "programming"
level: 3
tags: ["设计模式", "解释器模式", "DSL", "AST", "表达式求值", "游戏脚本"]
related: ["programming/command-pattern-undo-redo", "programming/factory-pattern-game", "programming/event-bus-architecture"]
hint: "策划要写「等级>10 且 持有钥匙 才能开门」这种条件，你给一个 if 还是一套可配置的迷你语言？"
---

## 参考答案

### ✅ 核心要点

1. **解释器模式的本质是「把一种语言的句子表示成 AST 对象树，再递归求值」**：每个语法规则对应一个节点类（如 `AndNode`、`CompareNode`、`NumberNode`），节点持有子节点并实现 `eval(context)`。整棵树递归调用就完成了一次「解释执行」。它把「规则」从硬编码的 `if` 变成了可被策划编辑、可热更的数据。
2. **游戏里它支撑各种「配置驱动的迷你语言（DSL）」**：对话前置条件（`level>10 && hasItem("key")`）、技能伤害公式（`base * (1 + crit) - target.def`）、成就触发器、抽卡概率表达式、装备词条判定。这些规则数量大、改动频繁、需要非程序员编辑——做成 DSL 比每个写一个函数分支更可维护。
3. **流程是「解析（Parse）→ 构建 AST → 求值（Eval）」三段式**：先用词法分析把字符串拆成 token，再用递归下降/Pratt 解析器按优先级组装成 AST，最后对 AST 调 `eval(context)`。热路径的表达式应「编译一次、求值多次」——把 AST 缓存起来，每帧只跑 eval。
4. **它和「内嵌 Lua/JS 脚本」是两条路线的权衡**：DSL（解释器模式）沙箱安全、可静态校验、类型明确、性能可控（无任意循环），适合「规则有限、要防止恶意/错误脚本」的场景；完整脚本系统表达力强（图灵完备），适合「逻辑无界、需要自定义控制流」的复杂玩法（如 mod）。技能/对话条件用 DSL，AI/任务系统用脚本，是常见分工。
5. **性能与安全是落地时的两大坑**：每帧求值成千上万条表达式（每个怪物的伤害公式）会吃 CPU——需做常量折叠（编译期算好 `2*3`→`6`）、AST 缓存、甚至编译成字节码/闭包。安全上要禁止无限循环、禁止文件/网络访问、限制递归深度，否则一个错误的策划配置就能卡死服务端。

### 📖 深度展开

#### 1. AST 节点 + 求值器：对话条件表达式

```typescript
// === 求值上下文：提供游戏运行时数据（玩家属性、背包、任务等） ===
interface EvalContext {
  getVar(name: string): number;          // player.level 等
  hasFlag(flag: string): boolean;        // hasItem("key") 这类布尔查询
}

// === AST 节点基类：每个节点能对上下文求值 ===
abstract class ExprNode { abstract eval(ctx: EvalContext): number; }

class NumberNode extends ExprNode {
  constructor(private value: number) { super(); }
  eval(_ctx: EvalContext): number { return this.value; }
}

class VarNode extends ExprNode {           // 变量引用，如 player.level
  constructor(private name: string) { super(); }
  eval(ctx: EvalContext): number { return ctx.getVar(this.name); }
}

class BinaryOpNode extends ExprNode {      // 通用二元运算：+ - * / > < 等
  constructor(private l: ExprNode, private op: string, private r: ExprNode) { super(); }
  eval(ctx: EvalContext): number {
    const a = this.l.eval(ctx), b = this.r.eval(ctx);
    switch (this.op) {
      case "+": return a + b;  case "-": return a - b;
      case "*": return a * b;  case "/": return b === 0 ? 0 : a / b;
      case ">": return a > b ? 1 : 0;     // 比较返回 1/0，统一数值语义
      case "<": return a < b ? 1 : 0;
    }
    throw new Error(`未知运算符: ${this.op}`);
  }
}

// === 组装一棵 AST：表达式 (player.level > 10) ===
const tree = new BinaryOpNode(new VarNode("player.level"), ">", new NumberNode(10));

// 求值
const ctx: EvalContext = { getVar: n => n === "player.level" ? 42 : 0, hasFlag: () => true };
console.log(tree.eval(ctx));   // → 1（真）
```

```
表达式 "player.level > 10" 的 AST 结构：

        BinaryOpNode (">")
        /            \
   VarNode          NumberNode
 "player.level"        10

求值时自底向上：
  VarNode.eval → ctx.getVar → 42
  NumberNode.eval → 10
  BinaryOp.eval → 42 > 10 → 1（真）
```

#### 2. Pratt 解析器：按优先级把字符串建成 AST

```typescript
// 简化版 Pratt 解析：处理 二元运算 + 数字 + 变量，按优先级递归
const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, ">": 0, "<": 0 };

function parseExpr(tokens: string[], pos: { i: number }, minPrec: number): ExprNode {
  let left = parsePrimary(tokens, pos);            // 先解析左侧（数字/变量/括号）
  while (pos.i < tokens.length) {
    const op = tokens[pos.i];
    const p = PREC[op];
    if (p === undefined || p < minPrec) break;     // 优先级不够，交给上层
    pos.i++;
    const right = parseExpr(tokens, pos, p + 1);   // 右侧用更高优先级递归（左结合）
    left = new BinaryOpNode(left, op, right);
  }
  return left;
}

function parsePrimary(t: string[], pos: { i: number }): ExprNode {
  const tok = t[pos.i++];
  if (/^\d+$/.test(tok)) return new NumberNode(parseInt(tok));
  return new VarNode(tok);                          // 其余视为变量
}

// "player.level > 10 * 2"  →  正确按优先级建树（* 先算，再 >）
const ast = parseExpr("player . level > 10 * 2".split(" "), { i: 0 }, 0);
```

#### 3. DSL 解释器 vs 内嵌脚本 vs 数据表 vs 表达式字符串

| 方案 | 表达力 | 安全性 | 性能 | 可编辑性 | 游戏适用 |
|------|--------|--------|------|---------|---------|
| **AST 解释器（DSL）** | 规则有限、无循环 | ✅ 沙箱、可静态校验 | 中（缓存 AST） | ✅ 策划友好 | 对话条件/技能公式 |
| 内嵌 Lua/JS | 图灵完备 | ❌ 需沙箱隔离 | 高（JIT） | 需会编程 | AI/任务/mod |
| 纯数据表（CSV/JSON） | 仅固定字段 | ✅ 最安全 | 高 | ✅ 最简单 | 固定参数、查表 |
| 裸表达式字符串 + eval | 任意 | ❌❌ 注入风险 | 低（每次解析） | 一般 | 不推荐 |
| 编译成字节码/闭包 | 同 DSL | ✅ | 高（预编译） | 同 DSL | 高频热路径 |

```
选型决策树：
  规则是固定几个字段比较？          → 数据表（最省事、最安全）
  规则有逻辑组合(与/或/比较/算术)？ → AST 解释器（DSL）
  规则需要自定义函数/循环/状态？    → 内嵌 Lua/JS 脚本（沙箱化）
  表达式每帧求值上万次？            → DSL + 常量折叠 + 字节码/闭包预编译
```

### ⚡ 实战经验

- **每帧重新 parse 字符串把服务端打爆**：技能伤害公式存成字符串，每帧 `parse + eval`，一场团战上千次技能同时 `parse`，CPU 飙满。改成「加载时 parse 一次、缓存 AST、运行时只 eval」后开销降 95%。规则：字符串永远只在加载时解析一次。
- **常量折叠省掉大量重复计算**：公式 `2 * 3 + base` 里的 `2*3` 每次都重算。在编译 AST 时对「全常量子树」预先求值折叠成 `6 + base`，技能公式里的固定系数全部折叠，热路径求值节点数减少 40%。
- **没限制递归深度导致 DoS**：玩家在聊天里输入超深层嵌套的恶意表达式（mod 反馈系统允许玩家写条件），AST 递归求值时栈溢出崩溃。加上「AST 深度上限（如 50）」和「求值步数预算」后，畸形表达式安全返回错误而非崩溃。
- **DSL 想偷懒上 eval(string) 被注入**：早期对话系统直接把条件字符串 `new Function(...)` 执行，恶意存档里塞入 `while(true){}` 卡死客户端。改用受控 AST 解释器（只支持白名单运算符和变量访问）后杜绝代码注入。

### 🔗 相关问题

1. 如何把 DSL 的 AST 进一步「编译」成 JavaScript 闭包（`new Function` 受控生成）来加速热路径求值？这样做还安全吗？
2. 解释器模式和访问者模式（Visitor）经常配合——用 Visitor 给 AST 做「类型检查/静态校验/格式化」有什么好处？
3. 当策划需要写「带副作用」的脚本（如触发剧情、给物品）而不只是求值条件时，DSL 应该扩展成什么样的「命令式」语法？
