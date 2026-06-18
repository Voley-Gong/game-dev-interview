---
title: "游戏中的错误处理：如何用 Result 类型做防御式编程？"
category: "programming"
level: 2
tags: ["错误处理", "防御式编程", "类型系统", "健壮性"]
related: ["programming/typescript-advanced-types-game", "programming/serialization-save-system"]
hint: "try-catch 满天飞、错误被静默吞掉、线上崩溃找不到源头——Result 类型如何让错误成为类型系统的一等公民？"
---

## 参考答案

### ✅ 核心要点

1. **异常的问题**：`throw` 是隐式的控制流，调用方无法从签名看出「这个函数会失败」，错误极易被遗漏或吞掉，形成线上隐患
2. **Result 类型**：用 `{ ok: true, value } | { ok: false, error }` 让「失败」成为返回值的一部分，强制调用方处理错误分支，编译期消灭遗漏
3. **防御式编程原则**：快速失败（Fail Fast）+ 边界校验 + 不信任外部输入（网络包、存档、配置表），在系统边缘拦截非法数据
4. **错误分类分级**：区分「可恢复错误」（资源加载失败→用占位图）与「不可恢复错误」（数据损坏→崩溃上报），用不同策略处理
5. **错误传播链**：底层返回 Result，中层映射/包装错误上下文，顶层决定兜底策略，形成清晰的错误处理管道

### 📖 深度展开

**1. Result 类型：让错误可见、可追踪**

```typescript
// 用可辨识联合（Discriminated Union）定义 Result
type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// 工具函数构造成功/失败
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// 资源加载：返回 Result 而非 throw，调用方编译期必须处理两种情况
async function loadTexture(path: string): Promise<Result<Texture, LoadError>> {
  try {
    const data = await fetch(path);
    if (!data.ok) return err({ kind: 'HttpError', status: data.status, path });
    const tex = await decodeTexture(await data.blob());
    return ok(tex);
  } catch (e) {
    return err({ kind: 'DecodeError', reason: String(e), path });
  }
}
```

**2. 链式处理：map 与 andThen 组合错误流**

```typescript
// 类似 Rust 的 Result 组合子，避免层层 if-else 嵌套
function map<A, B, E>(r: Result<A, E>, fn: (a: A) => B): Result<B, E> {
  return r.ok ? ok(fn(r.value)) : r;
}
function andThen<A, B, E>(r: Result<A, E>, fn: (a: A) => Result<B, E>): Result<B, E> {
  return r.ok ? fn(r.value) : r;  // 失败则短路传播，不执行 fn
}

// 加载角色贴图 → 缩放 → 注册到图集，任一步失败自动短路
const result = andThen(
  await loadTexture('hero.png'),
  (tex) => andThen(scaleTexture(tex, 0.5), (scaled) => map(
    atlas.add(scaled), () => scaled.id
  ))
);
if (!result.ok) {
  // 错误已携带完整上下文，可上报或降级到占位图
  fallbackToPlaceholder(result.error);
}
```

```
错误处理管道（自底向上传播）：

  loadTexture() ──失败─→ { ok:false, error: LoadError }
       │ ok                       ↑ 自动短路，不继续
       ↓                          │
  scaleTexture() ──失败───────────┘
       │ ok
       ↓
  atlas.add() ──成功─→ { ok:true, value: texId }

  每层只关注自己的逻辑，错误像管道中的「短路信号」自动上传
```

**3. 防御式编程：不信任边界输入**

```typescript
// 存档反序列化：玩家存档可能被篡改/损坏/版本不匹配，必须全量校验
function loadSave(raw: unknown): Result<SaveData, SaveError> {
  if (typeof raw !== 'object' || raw === null)
    return err({ kind: 'InvalidFormat' });
  const obj = raw as Record<string, unknown>;
  // 字段存在性 + 类型 + 范围 三重校验
  if (typeof obj.level !== 'number' || obj.level < 1 || obj.level > 999)
    return err({ kind: 'InvalidField', field: 'level' });
  if (typeof obj.gold !== 'number' || obj.gold < 0)
    return err({ kind: 'Tampered', field: 'gold' });  // 金币为负=作弊
  return ok(obj as SaveData);
}
```

**错误处理策略对比：**

| 策略 | 机制 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|----------|
| 异常 throw/catch | 隐式控制流 | 简单直接，原生支持 | 签名不可见，易遗漏 | 不可恢复的致命错误 |
| Result 类型 | 显式返回值 | 编译期强制处理 | 代码稍繁琐 | IO、解析、可恢复错误 |
| 错误码/null | 返回标志 | 零开销 | 语义弱，易忽略 | 性能极致热点 |
| 全局错误边界 | 顶层兜底 | 防止白屏崩溃 | 错误上下文丢失 | 渲染/UI 层最后防线 |

### ⚡ 实战经验

- **线上崩溃 90% 源于未处理的 throw**：把核心资源加载、网络协议解析改成 Result 后，未捕获异常从每周上百条降到个位数。强制处理错误分支的价值远超代码繁琐的代价
- **别用 try-catch 做流程控制**：见过用 `throw` 跳出多层循环的代码，性能比正常 return 慢 100 倍（异常构造栈开销大）。流程跳转用 Result 或标志位
- **错误日志要带上下文**：只记 `LoadError` 无法定位问题，必须带上 path、调用栈、上下文快照。建议封装 `reportError(error, context)` 统一上报
- **不可恢复错误要主动崩溃**：存档数据结构损坏（如数组里混入 null）如果静默继续，会导致后续连锁崩溃更难排查。该 assert 的地方果断 assert，Fail Fast 比带病运行好

### 🔗 相关问题

- TypeScript 的 `unknown` 和 `any` 在防御式编程中有什么区别？为什么推荐用 `unknown`？
- 错误边界（Error Boundary）在游戏 UI 渲染中如何防止整个界面崩溃？
- Rust 的 `?` 操作符相比手动 `andThen` 有什么优势？这种模式能移植到 TS 吗？
