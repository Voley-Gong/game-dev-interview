---
title: "值类型 vs 引用类型：游戏开发中有哪些陷阱？"
category: "programming"
level: 1
tags: ["值类型", "引用类型", "内存模型", "TypeScript"]
related: ["programming/deep-vs-shallow-copy"]
hint: "不是背概念——是弄清每次赋值到底复制了什么，不然 Bug 会藏在最普通的代码里。"
---

## 参考答案

### ✅ 核心要点

1. **基本类型是值类型**：`number / string / boolean / undefined / null / symbol / bigint`，赋值时复制值本身
2. **对象、数组、函数是引用类型**：变量存的是堆内存地址，赋值只是复制指针
3. **函数参数**：JS/TS 永远是"按值传递"——引用类型传的是地址的副本，函数内改属性会影响外部
4. **比较运算符**：基本类型比值，引用类型比地址，`{} === {}` 结果是 `false`
5. **GC 关注引用**：引用类型的生命周期由可达性决定，忘记置空 = 内存泄漏

### 📖 深度展开

**1. 赋值时的内存差异**

```
值类型：let a = 10; let b = a; b = 20;
  栈内存:  a = 10   b = 20   ← 两个独立副本，互不影响

引用类型：let p = {x:1}; let q = p; q.x = 99;
  栈内存:  p → 堆0x1A   q → 堆0x1A   ← 指向同一个对象
  堆内存:  0x1A = {x:99}  ← 通过 q 改了，p 也变了
```

**2. 函数参数的典型陷阱**

```typescript
interface Player { hp: number; buffs: string[]; }

// ❌ 陷阱：以为修改的是副本，实际改的是原对象
function heal(player: Player) {
  player.hp += 100;        // 外部 player 也被改了！
  player.buffs.push('regen');
}

// ❌ 陷阱：重新赋值不影响外部
function resetHp(player: Player) {
  player = { hp: 100, buffs: [] };  // 只改了局部指针，外部不变
}

// ✅ 正确：要"不可变"风格，返回新对象
function withHeal(player: Player): Player {
  return { ...player, hp: player.hp + 100 };
}

const p: Player = { hp: 50, buffs: [] };
const healed = withHeal(p);   // p 保持不变，healed 是新对象
```

**3. 游戏中的高频踩坑场景**

| 场景 | 陷阱表现 | 正确做法 |
|------|----------|----------|
| 配置表读取 | 多个敌人共享同一份 `config`，一个改全变 | 读表时深拷贝，或用 `Object.freeze` |
| 默认参数 | `function f(list: number[] = shared)` 被意外 mutate | 每次调用内部 `list = [...defaultList]` |
| 背包/装备 | `equippedItem = inventory[i]`，强化后两边同步升级 | 装备实例要独立，引用主数据 ID 而非对象 |
| 数组排序 | `const sorted = list.sort()` 原数组也被改了 | `list.toSorted()` 或先 `[...list]` |

**4. 判等与拷贝的对照**

```typescript
const a = { id: 1 };
const b = { id: 1 };

a === b;          // false（比地址）
a === a;          // true（同一引用）
a.id === b.id;    // true（比值）

// 判断"同一个游戏对象"用引用相等
// 判断"逻辑相等"（如两个相同道具）用值比较
const isSameInstance = (x: Item, y: Item) => x === y;
const isSameItemId   = (x: Item, y: Item) => x.id === y.id;
```

**5. 用结构体思维减少意外共享**

```typescript
// 纯数据 + 不可变更新，避免引用陷阱
type Vec3 = { readonly x: number; readonly y: number; readonly z: number };
const move = (v: Vec3, dx: number): Vec3 => ({ ...v, x: v.x + dx });

// 而不是
class Vec3Mut { x = 0; y = 0; z = 0; }  // 引用类型，处处可被改
```

### ⚡ 实战经验

- **配置数据只读化**：从 JSON/Excel 读出的配置用 `Object.freeze` 冻结，运行时谁改谁报错，彻底杜绝共享污染
- **存档要警惕引用**：序列化存档时，循环引用（角色 ↔ 队伍）会让 `JSON.stringify` 直接抛错，存档前要拍快照并断开引用
- **事件回调里别持有对象**：监听器长期持有大对象引用是内存泄漏重灾区，组件销毁时务必 `off`
- **Unity/C# 的 struct 是真值类型**：但 TS/JS 没有真正的值类型对象，想模拟要靠"不可变 + 返回新对象"的纪律

### 🔗 相关问题

1. 深拷贝和浅拷贝在存档/网络同步中怎么选？性能差异有多大？
2. `Object.freeze` 只冻结一层，多层嵌套怎么彻底冻结？
3. JS 里怎么实现一个"值类型"语义的 Vector/Color，避免到处意外共享？
