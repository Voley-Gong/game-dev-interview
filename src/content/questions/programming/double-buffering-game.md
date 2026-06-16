---
title: "双缓冲模式是什么？游戏开发中哪些场景必须用它？"
category: "programming"
level: 3
tags: ["设计模式", "双缓冲", "渲染", "物理模拟", "状态管理"]
related: ["programming/dirty-flag-pattern", "programming/game-loop-fixed-timestep", "programming/ecs-architecture"]
hint: "不是缓存——是用两块缓冲区交替读写，让正在修改的数据和正在读取的数据完全隔离，消除撕裂、竞态和半成品状态。"
---

## 参考答案

### ✅ 核心要点

1. **两块缓冲区交替使用，写完再交换**：双缓冲（Double Buffer）维护两份相同的数据结构——「当前缓冲」（current buffer，对外可读）和「下一缓冲」（next buffer，正在写入）。所有修改写到 next buffer，当一帧逻辑全部完成后，执行一次原子性的「交换」（swap），next 变成 current。外部永远只能读到一份完整、一致的数据，不会看到「改了一半」的中间状态。
2. **渲染防撕裂是最经典的应用**：GPU 正在把帧缓冲（Framebuffer）的内容输出到屏幕时，如果 CPU/GPU 同时往同一个缓冲区写入新一帧的像素，屏幕上就会出现「上半帧旧画面 + 下半帧新画面」的撕裂（Tearing）。双缓冲让 GPU 先把整帧画到 Back Buffer，画完后 VSync 信号触发时一次性 Swap 到 Front Buffer 上屏，画面完整无撕裂。
3. **物理模拟中防止自引用状态污染**：物理系统中，物体 A 的运动可能影响物体 B，而 B 的运动又会反过来影响 A——如果在同一帧内用同一个数组更新，先更新的 A 会修改状态，后更新的 B 读到的是「已经被 A 污染」的数据，导致结果取决于更新顺序。双缓冲让所有物体都从「上一帧的快照」读取，写入「本帧的快照」，更新顺序无关紧要。
4. **事件系统避免「迭代中修改集合」崩溃**：事件总线在派发事件时遍历监听器列表，而事件回调中可能注册/移除监听器——在遍历的数组上增删元素会导致索引越界或跳过元素。双缓冲让派发过程读 current buffer，注册/移除操作写 next buffer，帧末交换，彻底杜绝 ConcurrentModification。
5. **交换操作必须原子化**：双缓冲的关键在于 swap 时刻——如果是多线程环境，swap 必须用原子操作或锁保护，否则可能在一个线程还没读完 current 时就被换成 next。单线程游戏中 swap 通常只是交换两个指针引用（O(1)），但在跨线程场景（主线程读 / Worker 写）中必须配合 `Atomics` 或屏障。

### 📖 深度展开

**1. 物理系统的状态双缓冲**

```typescript
/**
 * 物理状态双缓冲：所有物体从 prevBuffer 读、向 currBuffer 写，
 * 帧末 swap，保证更新顺序不影响物理结果。
 */
interface PhysicsBody {
  id: number;
  posX: number; posY: number;
  velX: number; velY: number;
  mass: number;
}

class PhysicsWorld {
  // 两份完全相同的状态缓冲
  private states: [Map<number, PhysicsBody>, Map<number, PhysicsBody>] = [
    new Map(), new Map(),
  ];
  private currIndex = 0; // 当前可读缓冲的索引

  // 对外暴露「上一帧的只读快照」
  get prevState(): Map<number, PhysicsBody> {
    return this.states[1 - this.currIndex];
  }
  // 对外暴露「本帧的写入缓冲」
  get currState(): Map<number, PhysicsBody> {
    return this.states[this.currIndex];
  }

  addBody(body: PhysicsBody): void {
    // 两个缓冲都要加，保持同步
    this.states[0].set(body.id, { ...body });
    this.states[1].set(body.id, { ...body });
  }

  // 核心更新：每个物体从 prevState 读邻居位置，写入 currState
  step(dt: number): void {
    const prev = this.prevState;
    const curr = this.currState;

    for (const [id, body] of prev) {
      let fx = 0, fy = 0;
      // 计算所有其他物体对当前物体的合力（全部从 prev 读）
      for (const [otherId, other] of prev) {
        if (otherId === id) continue;
        const dx = other.posX - body.posX;
        const dy = other.posY - body.posY;
        const distSq = dx * dx + dy * dy + 0.01;
        const force = (body.mass * other.mass) / distSq;
        fx += force * dx / Math.sqrt(distSq);
        fy += force * dy / Math.sqrt(distSq);
      }
      // 写入 curr（不影响其他物体的读取）
      const updated = curr.get(id)!;
      updated.velX += (fx / body.mass) * dt;
      updated.velY += (fy / body.mass) * dt;
      updated.posX += updated.velX * dt;
      updated.posY += updated.velY * dt;
    }

    // 帧末交换：O(1)，只是切换索引
    this.currIndex = 1 - this.currIndex;
  }
}
```

```
双缓冲物理更新流程（N 体引力模拟）：

  ┌─────────────────┐         ┌─────────────────┐
  │   Buffer A      │         │   Buffer B      │
  │  (上一帧状态)    │         │  (本帧写入)      │
  │                 │  读取   │                 │
  │  body[0].pos    │◄────────│                 │
  │  body[1].pos    │  写入   │  body[0].newPos │
  │  body[2].pos    │────────►│  body[1].newPos │
  │                 │         │  body[2].newPos │
  └─────────────────┘         └─────────────────┘
          ↑                           │
          │    帧末 swap (交换索引)     │
          └───────────────────────────┘
  
  关键：无论更新顺序是 0→1→2 还是 2→1→0，结果完全相同
  因为所有物体都从 Buffer A（旧状态）读，写入 Buffer B（新状态）
```

**2. 事件系统的监听器双缓冲**

```typescript
class EventBus {
  private buffers: [Set<EventListener>, Set<EventListener>] = [
    new Set(), new Set(),
  ];
  private readIndex = 0;
  private pendingSwap = false;

  // 注册监听器：写入「另一个」缓冲，不影响当前派发
  on(event: string, listener: EventListener): void {
    const writeBuf = this.buffers[1 - this.readIndex];
    writeBuf.add(listener);
    // 如果当前不在派发中，立即同步到读缓冲
    if (!this.dispatching) this.readIndex = 1 - this.readIndex;
    this.pendingSwap = true;
  }

  off(event: string, listener: EventListener): void {
    // 两个缓冲都删（因为监听器可能在任一缓冲中）
    this.buffers[0].delete(listener);
    this.buffers[1].delete(listener);
  }

  private dispatching = false;

  emit(event: string, data: unknown): void {
    this.dispatching = true;
    const listeners = this.buffers[this.readIndex];
    // 安全遍历：即使回调中 on/off，也不会影响当前遍历的集合
    for (const listener of listeners) {
      listener(data);
    }
    this.dispatching = false;
    // 派发结束后执行延迟的 swap
    if (this.pendingSwap) {
      this.readIndex = 1 - this.readIndex;
      this.pendingSwap = false;
    }
  }
}
```

**3. 单缓冲 vs 双缓冲 vs 三缓冲对比**

| 维度 | 单缓冲 | 双缓冲 | 三缓冲 |
|------|--------|--------|--------|
| **缓冲区数量** | 1 | 2 | 3 |
| **撕裂问题** | ❌ 有 | ✅ 无 | ✅ 无 |
| **半成品状态** | ❌ 有 | ✅ 无 | ✅ 无 |
| **内存占用** | 1x | 2x | 3x |
| **渲染延迟** | 0 帧 | 1 帧 (16ms) | 2 帧 (32ms) |
| **CPU-GPU 并行** | ❌ 互相等待 | ✅ 基本并行 | ✅ 完全并行 |
| **帧率稳定性** | 差 | 好 | 最好 |
| **游戏场景** | 不推荐 | 标准选择 | 高帧率电竞 |
| **适用场景** | 极低端设备 | 大多数游戏 | VR / 120fps |

```
三缓冲渲染时序（CPU 和 GPU 完全解耦）：

  帧0:  CPU写Buffer0 ──► GPU读Buffer0 ──► 屏幕
  帧1:  CPU写Buffer1 ──► GPU读Buffer1 ──► 屏幕
  帧2:  CPU写Buffer2 ──► GPU读Buffer2 ──► 屏幕
  帧3:  CPU写Buffer0 ──► GPU读Buffer0 ──► 屏幕  (复用最早完成的缓冲)

  CPU 永远有缓冲可写，GPU 永远有缓冲可读
  代价：画面延迟 2 帧（输入到画面反馈有 ~32ms 滞后）
```

### ⚡ 实战经验

- **物理系统不加双缓冲导致「更新顺序 Bug」**：弹球游戏中多个球同时碰撞，先更新的球 A 位置已变，后更新的球 B 用 A 的新位置算碰撞——结果每次帧间波动都会导致碰撞结果不同（不确定性）。加入双缓冲后所有球从上一帧快照读取，碰撞结果确定可复现，帧同步调试也变简单了。这是帧同步游戏必须注意的。
- **事件总线迭代中删除监听器崩溃**：UI 系统在 `onClose` 回调中调用 `eventBus.off('close', selfListener)`，正好在 emit 遍历同一个 Set 时执行 `delete`，Node.js 的 Set 在迭代中删除当前元素行为尚可，但删除后续元素会跳过。换成双缓冲后回调中的增删操作延迟到 emit 结束后执行，彻底消除此类 Bug，项目减少了 12 个相关崩溃报告。
- **双缓冲 swap 忘了同步两个缓冲的状态**：初始实现中 `addBody` 只往 `currState` 加了数据，`prevState` 没同步——第一帧物理更新时 `prevState` 为空，所有物体合力为零不动。正确做法是任何「结构性修改」（增删物体）必须同时操作两个缓冲，只有「数值更新」（位置/速度）才走双缓冲读写分离逻辑。
- **VR 游戏延迟太高要降缓冲层级**：VR 设备要求 motion-to-photon 延迟低于 20ms 否则眩晕。双缓冲在 90fps 下延迟约 11ms 可以接受，但如果渲染管线加了后处理导致一帧超时，双缓冲会丢帧（下一帧 GPU 空闲等待），改用三缓冲后丢帧率从 5% 降到 0.3%，但延迟增加 11ms——VR 场景必须权衡延迟与流畅度。
- **共享内存双缓冲需要 Atomics 保护 swap**：主线程和 Web Worker 共享一个 `SharedArrayBuffer` 做物理模拟（Worker 计算，主线程读取），swap 操作只交换一个 `Uint8Array[0]` 的索引值。早期没用 `Atomics.store` / `Atomics.load`，V8 在优化时重排了指令顺序，主线程偶尔读到 Worker 还没写完的缓冲。加 `Atomics.store(buf, 0, newIndex)` 后屏障保证写入可见性，问题消失。

### 🔗 相关问题

1. 双缓冲和脏标记（Dirty Flag）模式有什么区别？什么场景下应该组合使用？
2. 在 ECS 架构中，Component 数据的双缓冲如何实现？System 之间如何保证读到一致的 Component 快照？
3. 帧同步（Lockstep）游戏中，物理系统的双缓冲为何是实现确定性模拟的必要条件？
