---
title: "脏标记模式如何避免游戏中的冗余计算？"
category: "programming"
level: 2
tags: ["设计模式", "脏标记", "性能优化", "场景树", "渲染优化"]
related: ["programming/ecs-architecture", "programming/event-bus-architecture", "programming/memory-gc-optimization"]
hint: "不是每次变动都立刻重算——打个标记拖延到下一帧统一处理，用一帧的延迟换掉 90% 的无用计算。"
---

## 参考答案

### ✅ 核心要点

1. **核心思想：标记变更、延迟计算**：脏标记（Dirty Flag）模式在数据被修改时只设一个布尔标记 `isDirty = true`，不立即执行昂贵的重算。等到真正需要结果时（如渲染前、物理步进前）检查标记，只有脏的对象才重新计算。用"一帧的延迟"换来对大量未变对象的计算跳过。
2. **场景树中的世界矩阵重算是经典应用**：3D 引擎中每个节点有 localTransform（局部变换）和 worldTransform（世界变换）。父节点移动时，所有子节点的世界矩阵都失效。如果每次 set position 都递归重算所有子节点，一帧内改 3 次位置就算 3 次；用脏标记则只在渲染前算一次。
3. **脏标记具有传播性**：父节点变脏时，所有子节点也必须标记为脏（因为世界矩阵依赖父级链）。这种"自上而下传播"是场景图脏标记的核心机制——设置 localTransform 时标记自身和全部后代，但世界矩阵的实际重算推迟到读取时。
4. **批量处理是性能关键**：脏标记的真正威力在于"收集-批处理"。一帧内多个系统可能修改同一对象（动画系统改旋转、物理系统改位置、AI 改缩放），脏标记把它们合并为一次最终重算。帧末统一 flush 所有脏标记，计算量从 O(修改次数 × 对象数) 降为 O(脏对象数)。
5. **清除时机决定正确性**：脏标记必须在计算完成后立即清除（`isDirty = false`），否则下一帧会重复计算（浪费性能）；但清除后又必须在任何修改时重新标记，否则用到了过期数据（逻辑错误）。这个"标记-计算-清除"的生命周期管理是脏标记模式最容易出 Bug 的地方。

### 📖 深度展开

**1. 场景树中的脏标记：世界矩阵惰性计算**

```typescript
// 游戏引擎节点：用脏标记延迟计算世界变换矩阵
class SceneNode {
  private _localPos = new Vec3(0, 0, 0);     // 局部位置
  private _localRot = new Quat();             // 局部旋转
  private _localScale = new Vec3(1, 1, 1);    // 局部缩放
  private _worldMatrix: Mat4 = new Mat4();    // 世界矩阵（缓存）
  private _isWorldDirty = true;               // ⭐ 脏标记：初始为脏（首次必须算）
  private _children: SceneNode[] = [];
  parent: SceneNode | null = null;

  // setter：只标记脏，不计算世界矩阵
  set position(pos: Vec3) {
    this._localPos.copy(pos);
    this._markDirty();  // 标记自身+子节点脏，零计算开销
  }
  set rotation(rot: Quat) {
    this._localRot.copy(rot);
    this._markDirty();
  }

  // ⭐ 脏标记传播：父变脏 → 所有子节点也脏
  private _markDirty(): void {
    if (this._isWorldDirty) return;  // 已经是脏的，子节点也已经脏，提前返回
    this._isWorldDirty = true;
    for (const child of this._children) {
      child._markDirty();            // 递归传播给后代
    }
  }

  // getter：惰性计算——只在真正需要时才算
  get worldMatrix(): Mat4 {
    if (this._isWorldDirty) {
      // 本地变换矩阵 = T * R * S
      const local = Mat4.fromTRS(this._localPos, this._localRot, this._localScale);
      if (this.parent) {
        // 世界矩阵 = 父世界矩阵 × 本地矩阵
        Mat4.multiply(this.parent.worldMatrix, local, this._worldMatrix);
      } else {
        this._worldMatrix.copy(local);
      }
      this._isWorldDirty = false;  // 计算完成，清除脏标记
    }
    return this._worldMatrix;
  }
}
```

**2. 脏标记传播流程与帧末 flush**

```
场景树结构：                 帧内多次修改后脏标记状态：

  Root (pos=0,0)              Root ✓ clean    ← 本身没变
    ├── Player (pos=5,0)       Player ✗ DIRTY  ← 动画系统改了 position
    │    ├── Weapon             Weapon ✗ DIRTY ← 父脏→传播
    │    └── Helmet             Helmet ✗ DIRTY ← 父脏→传播
    ├── Enemy1 (pos=10,0)      Enemy1 ✓ clean  ← 没变
    │    └── Sword              Sword  ✓ clean ← 父没变
    └── Enemy2 (pos=20,0)      Enemy2 ✓ clean

帧末 render() 遍历时：
  Root.worldMatrix    → 不脏，直接返回缓存（跳过矩阵乘法）
  Player.worldMatrix  → 脏！重算 = Root.world × Player.local
  Weapon.worldMatrix  → 脏！重算 = Player.world × Weapon.local
  Helmet.worldMatrix  → 脏！重算 = Player.world × Helmet.local
  Enemy1.worldMatrix  → 不脏，跳过
  Enemy2.worldMatrix  → 不脏，跳过

结果：500 个节点的场景，只有 3 个节点重算（而非全量 500 次）
```

```typescript
// 帧末统一 flush：收集所有脏节点，批量处理（UI 重建/物理更新/碰撞体重算）
class DirtyFlagSystem<T> {
  private dirtySet = new Set<T>();  // 用 Set 自动去重

  markDirty(obj: T): void {
    this.dirtySet.add(obj);  // 一帧内标记多次只存一个引用
  }

  // 帧末调用：只处理脏对象，处理后清空
  flush(processor: (obj: T) => void): void {
    const dirtyCount = this.dirtySet.size;
    for (const obj of this.dirtySet) {
      processor(obj);         // 执行重算（UI 重建、碰撞体更新等）
    }
    this.dirtySet.clear();    // 清空，下一帧重新收集
    if (dirtyCount > 0) {
      // 性能监控：脏对象占比是优化效果的关键指标
      console.debug(`[DirtyFlag] 处理 ${dirtyCount} 个脏对象`);
    }
  }
}
```

**3. 脏标记 vs 事件驱动 vs 每帧轮询对比**

| 模式 | 变更时开销 | 无变更时开销 | 延迟 | 适用场景 |
|------|-----------|-------------|------|----------|
| **每帧全量重算** | 零（不处理变更） | 极高（N 个对象全算） | 零 | 对象少、变化频繁 |
| **事件驱动**（观察者） | 中（通知所有监听者） | 零 | 零（实时） | 变更需要立即响应 |
| **脏标记 + 延迟** | 极低（只设 bool） | 极低（只检查 bool） | 一帧 | **大多数游戏对象**（推荐） |

```typescript
// 对比三种方案在"1000 个 UI 元素，每帧只有 5 个变化"场景下的性能

// ❌ 方案A：每帧全量重建（最简单但最浪费）
function rebuildUIAll(elements: UIElement[]): void {
  for (const el of elements) el.rebuildLayout();  // 1000 次重算，990 次是浪费
}

// ❌ 方案B：事件驱动（每次 set 都立刻重算）
class UILabel {
  set text(t: string) {
    this._text = t;
    this.rebuildLayout();          // 一帧内 set 3 次就算 3 次
    this.parent?.onChildChanged(); // 还可能触发父级级联重算
  }
}

// ✅ 方案C：脏标记（一帧内多次修改只重算一次）
class UILabel {
  private _text = '';
  private dirty = true;
  set text(t: string) {
    if (this._text === t) return;  // 值没变不标记（避免无效脏）
    this._text = t;
    this.dirty = true;             // 只打标记，零计算
  }
  // 帧末由布局系统统一 flush
  flushIfDirty(): void {
    if (this.dirty) { this.rebuildLayout(); this.dirty = false; }
  }
}
```

### ⚡ 实战经验

- **过度标记比不标记更常见**：一个 UI 列表 200 项，每帧刷新数据时给所有项都打了 dirty，结果等于没优化——全量重算 200 次。正确的做法是对比新旧数据，只有真正变化的项才标记脏。我们的背包系统加了 diff 检查后，从每帧 200 次布局重算降到平均 3-5 次，帧耗时从 2.1ms 降到 0.1ms。
- **脏标记传播中断导致子物体"残留旧位置"**：修改了 `_markDirty` 忘记递归子节点（或提前 return 了已脏的父节点但子节点其实没被标记），表现为"父物体移动了但子物体留在原地"的视觉撕裂。加单元测试验证"父节点变脏时所有后代 isDirty 必须为 true"后这类 Bug 归零。
- **渲染管线中的 Uniform 批量更新**：Shader 的 MVP 矩阵 Uniform 每帧上传 GPU，但如果物体没动也上传是浪费带宽。加脏标记后，500 个静态物体从每帧 500 次 `gl.uniformMatrix4fv` 降到 0 次，DrawCall 准备时间从 1.8ms 降到 0.2ms——GPU 带宽在移动端尤其宝贵。
- **帧一致性优化：连续两帧同一对象脏时合并**：动画播放时物体每帧都在动，脏标记每帧都触发重算——这看起来没省到。但如果结合"帧间插值"（用上一帧和当前帧的世界矩阵做 lerp），可以每 2 帧才真正重算一次脏标记，中间帧用插值近似，视觉无差异但计算量减半。
- **脏标记清除后忘了在构造时初始化为脏**：新建节点的 `_isWorldDirty` 默认 `false`，导致第一次渲染返回的是单位矩阵（全零世界坐标），物体出现在原点闪一下才跳到正确位置。规则：**新建对象必须默认脏**，因为缓存还没被计算过。用 `private _isWorldDirty = true` 初始化即可避免。

### 🔗 相关问题

1. ECS 架构中，组件数据的脏标记如何与 System 的更新循环配合？Archetype 变化时脏标记如何处理？
2. 脏标记延迟一帧的特性在"需要即时反馈"的场景（如碰撞响应、输入处理）中会带来什么问题？如何平衡延迟与性能？
3. 当脏对象数量很大（如全场景角色同时受AOE影响变脏）时，脏标记模式反而退化为全量重算，此时该如何优化（分帧处理、LOD 剔除）？
