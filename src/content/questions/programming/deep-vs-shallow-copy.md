---
title: "深拷贝 vs 浅拷贝：存档、网络同步怎么选？性能差多少？"
category: "programming"
level: 2
tags: ["深拷贝", "浅拷贝", "序列化", "性能"]
related: ["programming/value-vs-reference-types"]
hint: "不是背 API——是知道每种方案的代价，别在每帧循环里调用 JSON.parse。"
---

## 参考答案

### ✅ 核心要点

1. **浅拷贝**：只复制第一层，嵌套对象仍是共享引用——`{...obj}` / `Object.assign` / `Array.from`
2. **深拷贝**：递归复制所有层级，完全独立——`structuredClone` / 手写递归 / `JSON` 方案
3. **`JSON.parse(JSON.stringify(x))` 的坑**：丢失 `undefined / 函数 / Symbol / Date / Map / 循环引用`
4. **`structuredClone` 是现代首选**：支持循环引用、Date、Map/Set、TypedArray，但无法克隆函数和 DOM 节点
5. **性能量级**：深拷贝比浅拷贝慢 10～100 倍，热路径（每帧、战斗循环）必须避免

### 📖 深度展开

**1. 浅拷贝的边界：只安全一层**

```typescript
const player = { name: 'A', stats: { hp: 100, atk: 20 } };

const shallow = { ...player };          // 浅拷贝
shallow.name = 'B';                     // ✅ 不影响原对象
shallow.stats.hp = 0;                   // ❌ 原对象的 hp 也变 0！

// player.stats === shallow.stats → true（同一引用）
```

**2. 四种方案横向对比**

| 方案 | 深度 | 循环引用 | 性能 | 适用场景 |
|------|------|----------|------|----------|
| `Object.assign({}, x)` | 浅 | — | ★★★★★ | 简单扁平对象、不可变更新 |
| `{ ...x }` 展开语法 | 浅 | — | ★★★★★ | React/Cocos 状态更新 |
| `JSON.parse(JSON.stringify(x))` | 深 | ❌ 抛错 | ★★★ | 纯数据存档、网络包（无函数/Date） |
| `structuredClone(x)` | 深 | ✅ | ★★★ | 现代浏览器/Node 17+，通用首选 |
| 手写递归 clone | 深 | 可控 | ★★ | 需要自定义逻辑（保留类实例、缓存） |

**3. 存档场景：JSON 方案够用但要拍快照**

```typescript
interface SaveData {
  player: Player;
  inventory: Item[];
  timestamp: number;
}

// ✅ 存档：序列化前数据必须是"纯 JSON 结构"
function saveGame(data: SaveData): string {
  return JSON.stringify(data);   // Date/Map/类实例会丢失类型
}

// ⚠️ 读档：必须重建类实例
function loadGame(raw: string): SaveData {
  const plain = JSON.parse(raw) as SaveData;
  return {
    ...plain,
    player: Object.assign(new Player(), plain.player),  // 恢复原型链
  };
}
```

**4. 网络同步：深拷贝是性能杀手**

```typescript
// ❌ 反面教材：每帧深拷贝整个状态
function syncFrame(state: GameState) {
  const snapshot = JSON.parse(JSON.stringify(state));  // 16ms 帧预算被吃掉
  network.send(snapshot);
}

// ✅ 正确：用增量 + 结构化差异，只传输变化部分
function syncDelta(prev: GameState, curr: GameState) {
  const delta = diff(prev, curr);   // 只收集变化的字段
  network.send(delta);              // 体积小，避免全量序列化
}

// ✅ 或用对象池 + 脏标记，序列化时只拍一次快照
```

**5. 带类实例的安全深拷贝**

```typescript
// 手写：保留原型链，处理循环引用
function deepClone<T>(obj: T, seen = new WeakMap()): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return seen.get(obj);          // 断开循环引用

  if (obj instanceof Date)   return new Date(obj) as any;
  if (obj instanceof RegExp) return new RegExp(obj) as any;
  if (obj instanceof Map) {
    const m = new Map();
    seen.set(obj, m);
    obj.forEach((v, k) => m.set(deepClone(k, seen), deepClone(v, seen)));
    return m as any;
  }

  const clone = Object.create(Object.getPrototypeOf(obj));  // 保留类
  seen.set(obj, clone);
  for (const key of Reflect.ownKeys(obj as object)) {
    (clone as any)[key] = deepClone((obj as any)[key], seen);
  }
  return clone;
}
```

### ⚡ 实战经验

- **能用浅拷贝就别深拷贝**：90% 的场景用 `{ ...state, hp: 100 }` 不可变更新就够，性能好且意图清晰
- **`structuredClone` 有环境门槛**：老版本小游戏运行时（如部分 Cocos 微信小游戏）可能不支持，发布前务必验证
- **战斗系统禁用深拷贝**：高频战斗逻辑每帧执行，深拷贝会导致明显卡顿，改用对象池 + 脏标记
- **存档要做版本号**：深拷贝/反序列化后字段可能缺失，用 `version` 字段配合迁移函数，避免读档崩

### 🔗 相关问题

1. `structuredClone` 为什么不能克隆函数和类的方法？怎么在深拷贝时保留行为？
2. 实现一个高性能的"脏标记 + 增量序列化"网络同步方案？
3. 循环引用是怎么导致 `JSON.stringify` 崩溃的？`WeakMap` 如何解决递归爆栈？
