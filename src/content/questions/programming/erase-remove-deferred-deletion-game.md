---
title: "游戏中如何高效删除大量实体？为什么 for 循环里 splice 会漏删元素？"
category: "programming"
level: 2
tags: ["数组删除", "性能优化", "ECS", "迭代安全", "对象池"]
related: ["programming/object-pool-game", "programming/ecs-architecture-game", "programming/data-oriented-design-soa"]
hint: "不是 splice 慢——是 splice 在遍历中删除会漏元素，且 O(n) 移位累积成 O(n²)。真正答案是 swap-pop + 延迟删除（mark-and-sweep）。"
---

## 参考答案

### ✅ 核心要点

1. **splice/erase 在正向遍历中删除会漏元素**：经典 bug —— 正向遍历 `[A,B,C,D]`，i=1 时删除 B，数组变成 `[A,C,D]`，C 移到 index 1 但 i 已自增到 2，C 被跳过。根因是删除后后续元素前移一位、循环索引同时前进，导致"跳格"。这在 buff 过期清理、子弹生命周期管理中是最常见的隐性 bug，玩家表现为偶发"永久 buff"或"幽灵子弹"。

2. **splice 单次 O(n) 移位，批量删除累积 O(n²)**：每次 splice 删一个元素，后面所有元素都要前移一位，1000 发子弹删 500 个过期就是 50 万次移动，实测帧时间从 0.3ms 飙到 8ms。这是"看似 O(n) 实则 O(n²)"的经典陷阱，在弹幕游戏、大规模粒子系统中尤为致命。

3. **swap-and-pop 是无序 O(1) 删除**：把数组最后一个元素交换到要删的位置，然后 `pop()`，不保序但单次删除 O(1)、无移位开销。适合子弹、粒子、伤害飘字等不关心元素顺序的场景，是热路径删除的首选。

4. **延迟删除（mark-and-sweep）是 ECS/复杂系统的标准方案**：遍历中只标记 `dead=true`，帧末统一遍历一次移除所有 dead 实体，避免遍历-删除竞态，支持跨 System 安全标记，且批量删除 cache 友好。Unity DOTS、entt 都采用这个模式，是大型游戏架构的工业标准。

5. **嵌套删除（parent 死了 children 怎么办）需要递归标记**：立即递归删 children 会修改正在遍历的树结构导致 crash。正确做法是标记 parent dead → sweep 阶段检测到 dead parent 时递归标记其 children → 统一移除。场景树、UI 层级、装备-宝石嵌套都适用此模式。

6. **删除时机影响 ID 引用安全**：用 ID 引用实体时，立即删除后 ID 对应的槽位可能被新实体复用，导致"指向 A 的引用突然指向 B"。Slot Map 的代际索引（generation counter）能解决此问题，而延迟删除则保证一帧内 ID 始终有效，二者常配合使用。

### 📖 深度展开

#### 1. 四种删除方式的 TypeScript 实现与复杂度对比

```typescript
interface Entity { id: number; hp: number; dead: boolean; }

// ❌ 正向遍历 + splice：经典 BUG，会漏删相邻元素
function naiveSpliceRemove(arr: Entity[]): Entity[] {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].dead) { arr.splice(i, 1); i--; } // 必须 i-- 补救，否则跳格
  }
  return arr;
}

// ✅ swap-and-pop：无序 O(1) 删除，热路径首选
function swapAndPop<T extends Entity>(arr: T[], index: number): void {
  const last = arr.length - 1;
  arr[index] = arr[last]; // 尾元素覆盖到删除位
  arr.pop();
}

// ✅ filter 返回新数组：不可变，函数式风格，O(n) 额外空间
function filterNew(arr: Entity[]): Entity[] {
  return arr.filter(e => !e.dead); // GC 压力大，慎用于热路径
}

// ✅ mark-and-sweep：两阶段，ECS 标准
function markAndSweep(arr: Entity[], pool: Entity[]): Entity[] {
  // Phase 1: mark（在 System 遍历阶段完成）
  // Phase 2: compact（帧末统一回收）
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].dead) {
      pool.push(arr[i]); resetEntity(arr[i]); // 回池复用
      arr[i] = arr[arr.length - 1]; arr.pop(); // swap-pop 原地压缩
    }
  }
  return arr;
}

function resetEntity(e: Entity): void { e.hp = 100; e.dead = false; }
```

| 方式 | 时间复杂度 | 保序 | 空间 | 遍历中安全 | 适用场景 |
|------|-----------|------|------|-----------|---------|
| 正向 splice | O(n²) | ✅ | O(1) | ❌ 易漏删 | 不推荐 |
| swap-and-pop | O(1)/次 | ❌ | O(1) | ✅ 反向遍历时 | 子弹/粒子 |
| filter 新数组 | O(n) | ✅ | O(n) | ✅ | 配置/UI 等冷路径 |
| mark-and-sweep | O(n) 批量 | 可控 | O(1) | ✅ 跨 System | ECS/大型架构 |

#### 2. 延迟删除在 ECS 中的工程实现

```
一帧时间线：
  System 更新阶段                    帧末 Sweep 阶段
  ┌──────────────────────────┐    ┌──────────────────┐
  │ MovementSystem:            │    │  CompactPass:      │
  │   for entity in alive:     │    │    筛选 alive 实体  │
  │     update position        │ →  │    dead 的回池/释放 │
  │     if hp<=0: mark dead    │    │    递归处理 children │
  │ CollisionSystem:           │    │    代际索引++       │
  │   (dead 实体本帧仍参与碰撞) │    │                    │
  └──────────────────────────┘    └──────────────────┘
  ★ 关键：dead 标记后，本帧其他 System 仍可安全访问该实体
    （可选择跳过 dead 逻辑），避免空引用 crash
```

```typescript
interface EcsEntity { id: number; hp: number; parentId: number; }
interface EcsRecord { entity: EcsEntity; dead: boolean; generation: number; }

class EntityWorld {
  private records: EcsRecord[] = [];
  private pool: EcsEntity[] = [];

  spawn(e: EcsEntity): void { this.records.push({ entity: e, dead: false, generation: 0 }); }

  markDead(id: number): void {
    const r = this.records.find(r => r.entity.id === id);
    if (r) r.dead = true; // 仅标记，不立即移除
  }

  // 帧末统一执行：swap-pop 压缩 + 递归处理 children + 代际自增
  sweep(hasChild: (id: number) => number[]): void {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (!this.records[i].dead) continue;
      this.propagateDead(this.records[i].entity.id, hasChild); // 级联标记 children
      this.records[i].generation++;        // 代际 +1，使旧 ID 引用失效
      this.resetAndReturn(this.records[i].entity); // 回池前强制 reset
      this.records[i] = this.records[this.records.length - 1];
      this.records.pop();
    }
  }

  private propagateDead(id: number, hasChild: (id: number) => number[]): void {
    for (const cid of hasChild(id)) this.markDead(cid); // 递归标记
  }

  private resetAndReturn(e: EcsEntity): void { e.hp = 100; this.pool.push(e); }
}
```

#### 3. 遍历中删除的四种正确写法

```
正向遍历删除 [A, B, C, D] 中所有偶数位的 bug 演示：
  i=0: A (保留)     [A, B, C, D]
  i=1: B (删除)     [A, C, D]     ← C 从 index2 移到 index1
  i=2: D (检查)     ← 跳过了 C！C 现在在 index1 但 i 已经是 2

正确写法① 反向遍历：     正确写法② swap-pop 反向：
  for i = n-1 → 0:         for i = n-1 → 0:
    if dead[i]: splice       if dead[i]: arr[i] = arr[--len]
  ✓ 不跳元素               ✓ O(1) 删除，但不保序
```

```typescript
// 写法① 反向遍历 splice：保序，O(n²)，但不会漏删
function reverseSplice<T>(arr: T[], isDead: (t: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) if (isDead(arr[i])) arr.splice(i, 1);
}

// 写法② swap-pop 反向：O(n)，不保序，热路径推荐
function reverseSwapPop<T>(arr: T[], isDead: (t: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (isDead(arr[i])) { arr[i] = arr[arr.length - 1]; arr.pop(); }
  }
}

// 写法③ 双指针原地压缩：保序 + O(n)，适合需要稳定顺序的列表
function twoPointerCompact<T>(arr: T[], isAlive: (t: T) => boolean): T[] {
  let write = 0;
  for (let read = 0; read < arr.length; read++) {
    if (isAlive(arr[read])) arr[write++] = arr[read];
  }
  arr.length = write; return arr; // 原 end() 之后的元素已被逻辑丢弃
}
```

| 写法 | 复杂度 | 保序 | 是否原地 | 代码简洁度 | 推荐场景 |
|------|--------|------|---------|-----------|---------|
| 反向 splice | O(n²) | ✅ | ✅ | 高 | 元素少、需保序 |
| swap-pop 反向 | O(n) | ❌ | ✅ | 高 | 子弹/粒子热路径 |
| 双指针压缩 | O(n) | ✅ | ✅ | 中 | 排行榜/背包保序 |
| filter 新数组 | O(n) | ✅ | ❌ | 极高 | 冷路径/工具脚本 |

### ⚡ 实战经验

1. **弹幕清理 O(n²) 瓶颈**：某弹幕游戏 2000 发子弹每帧检测过期，用 splice 逐个删除，实测帧时间 8.2ms（16ms 预算吃掉一半）。profiler 显示 7.8ms 花在 `Array.splice` 的元素移位上。改用 swap-and-pop 后降到 0.3ms，约 26 倍提升，同屏子弹上限直接翻倍。

2. **正向遍历删 buff 导致"永久 buff"**：buff 系统每帧正向 for + splice 检查过期，偶发玩家报告"减速 buff 永远不消失"。根因是连续两个 buff 同帧过期时，删第一个后第二个被跳过。改为反向遍历后修复，线上影响约 0.3% 对局，属于典型的低概率隐性 bug。

3. **ECS 延迟删除竞态 crash**：MovementSystem 标记实体 dead 后，同帧 CollisionSystem 在遍历中遇到该 dead 实体并访问已置空的组件指针，导致 null dereference crash。解法：dead 实体在 sweep 前保留完整数据，System 内部用 `if (entity.dead) continue` 跳过逻辑而非立即清理。崩溃率从 0.1% 降到 0。

4. **场景树嵌套删除 crash**：销毁父节点时立即递归 delete children，但 children 数组正在外层 foreach 遍历中，数组被修改导致迭代器失效 crash。改用"标记 dead → 帧末递归 sweep"后稳定。影响关卡切换时偶发闪退，P99 场景为 20+ 层嵌套 UI 面板同时销毁。

5. **对象池 + 延迟删除的 reset 遗漏**：dead 实体回池前没调用 `reset()`，下次 spawn 复用时残留上一轮的 hp/position/buff 状态，表现为"新怪物出场自带 30% 血"。在 sweep 阶段强制调用 `reset(entity)` 后消失——这是对象池配合延迟删除时最易踩的坑。

### 🔗 相关问题

1. **C++ 标准库的 erase-remove idiom 为什么设计成两步？** `v.erase(std::remove(...), v.end())` 为何不直接做一个 `remove_all`？`std::remove` 的"伪删除"（只是把保留元素前移、返回新 end 迭代器，不真正改变 size）和游戏中的 mark-and-sweep 有什么异曲同工之处？面试官想考察的是你对"标记阶段与回收阶段分离"这一通用模式的理解，以及 C++ 为何把删除语义拆给容器（erase 只容器懂 size）而把搬移交给算法。

2. **GC 的 mark-and-sweep 与游戏中手动延迟删除的本质区别？** 为什么游戏不直接依赖语言 GC 而要手动管理删除时机？提示方向：GC 的停顿不可控（帧尖刺）、GC 不懂"实体死亡"的业务语义（hp 归零≠对象不可达）、GC 触发时机无法对齐帧边界，且游戏对象常持有 native 资源（纹理、mesh）需要确定性释放。延伸：Rust 的 Drop、C++ RAII 与游戏对象生命周期的关系。

3. **不可变数据（`.filter()` 返回新数组）的性能代价？** 函数式风格天然避免遍历-删除 bug，但在每帧处理上万实体的热路径上，"每次创建新数组"有什么代价？提示：GC 分配压力、cache miss（新数组冷数据）、引用重定向导致 SoA 布局失效。延伸讨论：Struct of Arrays 下"逻辑删除 + 批量 compact"为何比每次 filter 更 cache 友好，以及 Rust iterator 的 `retain()` 如何在安全性与零分配之间取得平衡。
