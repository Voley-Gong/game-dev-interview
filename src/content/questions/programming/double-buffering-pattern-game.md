---
title: "双缓冲（Double Buffer）模式在游戏里怎么用？程序化生成、渲染和网络同步各有什么场景？"
category: "programming"
level: 2
tags: ["设计模式", "双缓冲", "并发", "渲染", "程序化生成", "网络同步"]
related: ["programming/game-loop-fixed-timestep", "programming/network-sync-game", "programming/ring-buffer-game"]
hint: "读一套数据的同时写另一套——细胞自动机洞穴生成、后处理乒乓缓冲、网络插值，本质都是\"边读边写不打架\"。"
---

## 参考答案

### ✅ 核心要点

1. **核心思想：维护两份缓冲，读写分离**：同一时刻一份缓冲用于「读」（消费方），另一份用于「写」（生产方），完成后交换（swap）。这样读写互不干扰，避免了"边遍历边修改导致的状态不一致"和"读到写了一半的脏数据"两大经典问题。
2. **程序化生成的标配**：元胞自动机（如 Cave Generation 洞穴生成）、康威生命游戏、流体模拟，每个格子的新状态依赖"当前所有邻居"的旧状态。必须用双缓冲——从缓冲A读邻居、把新状态写入缓冲B，整帧算完再交换，否则"先算的格子会影响后算的格子"产生方向性偏差。
3. **渲染的 Ping-Pong 缓冲**：后处理链（模糊→泛光→色调映射）每一步都要读上一步的纹理、写新纹理，用两张 RenderTexture 来回 ping-pong 复用，既保证读写分离又省显存（不用每个 pass 都新建纹理）。WebGL 中 FBO（帧缓冲对象）的双缓冲交换是基础操作。
4. **网络同步的状态平滑**：服务端每 100ms 发一次快照，客户端不能直接跳变（会瞬移）。做法是缓冲最近两个快照 `state[n]` 和 `state[n+1]`，在两者之间用插值/外推渲染，实现"延迟渲染过去的状态"消除抖动。这就是 100ms 延迟缓冲的原理。
5. **关键陷阱：交换是引用交换而非拷贝**：双缓冲的性能优势在于 swap 时只交换两个数组的引用（O(1)），不是把整个缓冲内容复制一遍（O(n)）。新手常写成 `bufferA = bufferB.slice()` 导致每个 cell 的拷贝开销吃掉性能。

### 📖 深度展开

**1. 经典场景：元胞自动机洞穴生成（读旧缓冲、写新缓冲、整帧交换）**

```typescript
// 双缓冲：current 供读取，next 供写入，算完一轮整体交换
class DoubleBufferedGrid {
  private current: Uint8Array;  // 0=墙, 1=空地
  private next: Uint8Array;
  constructor(private width: number, private height: number) {
    this.current = new Uint8Array(width * height);
    this.next    = new Uint8Array(width * height);
  }
  // 用定型数组：零GC、缓存友好、8万格子也才80KB
  private idx(x: number, y: number) { return y * this.width + x; }

  simulate(): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        // ✅ 读 current（旧状态），统计 8 邻居墙数
        const wallNeighbors = this.countWallNeighbors(x, y, this.current);
        // ✅ 写 next（新状态），不影响本轮其他格子的读取
        const alive = this.current[this.idx(x, y)] === 1;
        this.next[this.idx(x, y)] = this.applyRule(alive, wallNeighbors);
      }
    }
    this.swap();  // 整帧算完才交换，保证一致性
  }

  // 关键：O(1) 引用交换，不是逐元素拷贝
  private swap(): void {
    const tmp = this.current;
    this.current = this.next;
    this.next = tmp;
    this.next.fill(0);  // 清空下一轮的写缓冲
  }

  private applyRule(alive: boolean, wallNeighbors: number): number {
    // 元胞自动机洞穴规则：墙多则变墙，孤立的墙变空地
    if (alive && wallNeighbors >= 4) return 1;
    if (!alive && wallNeighbors >= 5) return 1;
    return 0;
  }
}
```

```
单缓冲的灾难（边读边写产生方向性偏差）：
  按行扫描计算，(2,2) 的新状态已写入 → 影响 (3,2) 的邻居统计
  结果：洞穴形状永远向右下方"流动"，不是真正的随机生长 ❌

双缓冲（读写分离）：
  整帧从 current 读 → 整帧写入 next → swap
  所有格子基于"同一时刻的旧状态"计算，无方向偏差 ✅
```

**2. 渲染后处理的 Ping-Pong 双缓冲**

```typescript
// 两张 RenderTexture 交替读写，避免每 pass 新建纹理
class PostProcessChain {
  private rtA: RenderTexture;
  private rtB: RenderTexture;
  constructor(width: number, height: number) {
    this.rtA = new RenderTexture(width, height);
    this.rtB = new RenderTexture(width, height);
  }

  apply(sceneColor: RenderTexture): RenderTexture {
    let read = sceneColor;
    let write = this.rtA;

    for (const effect of this.effects) {
      effect.render(read, write);  // 读 read 纹理 → 写 write 纹理
      [read, write] = [write, write === this.rtA ? this.rtB : this.rtA]; // 乒乓交换
    }
    return read;  // 最终结果
  }
}
// 效果链：模糊(read→A) → 泛光(A→B) → 色调(B→A) → 输出
// 全程只复用 2 张纹理，零分配
```

**3. 网络同步的 100ms 状态缓冲（延迟渲染消除抖动）**

```
服务端每 100ms 发快照，客户端始终比服务端"慢"一个周期渲染：

时间轴：  T+0    T+100   T+200   T+300
服务端快照:  S1              S2              S3
客户端渲染:        在 S1~S2 之间插值   在 S2~S3 之间插值
                  ↑ 始终渲染"100ms前的状态"，用插值平滑过渡

为什么不能直接用最新快照？
  → 快照间隔 100ms，直接用会导致角色每 100ms 瞬移一次（卡顿感）
  → 缓冲两个快照 + 插值 = 始终平滑运动，代价是固定 100ms 延迟
```

```typescript
// 网络插值：缓冲最近两个快照，在两者间 lerp
class NetworkInterpolator {
  private prevSnapshot: Snapshot | null = null;
  private nextSnapshot: Snapshot | null = null;
  private renderTime = 0;  // 渲染时钟（比真实时间慢一个周期）

  onSnapshot(snap: Snapshot): void {
    this.prevSnapshot = this.nextSnapshot;  // 旧的 next 变 prev
    this.nextSnapshot = snap;
  }

  // 渲染时在 prev 和 next 之间插值，保证平滑
  getRenderState(now: number): Vec3 | null {
    if (!this.prevSnapshot || !this.nextSnapshot) return null;
    const t = (this.renderTime - this.prevSnapshot.time)
            / (this.nextSnapshot.time - this.prevSnapshot.time);
    return Vec3.lerp(this.prevSnapshot.pos, this.nextSnapshot.pos, clamp(t, 0, 1));
  }
}
```

| 应用场景 | 缓冲对象 | 读方 | 写方 | 交换时机 | 关键收益 |
|---------|---------|------|------|---------|---------|
| 元胞自动机/洞穴生成 | 网格 Uint8Array | 模拟算法 | 模拟算法 | 整帧算完 | 消除方向性偏差 |
| 后处理链 | RenderTexture×2 | 当前 effect | 当前 effect | 每个 pass 后 | 零分配、省显存 |
| 网络状态插值 | 快照×2 | 渲染（插值） | 网络包接收 | 新快照到达 | 消除瞬移抖动 |
| 粒子系统更新 | 粒子数组×2 | 物理更新 | 物理更新 | 物理步进后 | 边遍历边增删安全 |
| 双缓冲队列（任务） | 队列×2 | 主线程消费 | 生产者填充 | 帧末整体交换 | 无锁、无竞争 |

### ⚡ 实战经验

- **误把 swap 写成逐元素拷贝，性能暴跌 50 倍**：早期做 8 万格子的洞穴生成，新手写 `for(i) current[i] = next[i]`，每帧拷贝 80KB 看着不多，但每秒模拟 30 次 + 垃圾回收压力，帧时间从 1ms 飙到 50ms。改成引用交换 `let tmp=a;a=b;b=tmp;` 后回到 1ms。记住：双缓冲的核心红利就是 O(1) 引用交换。
- **双缓冲队列解决\"生产消费竞争\"比加锁更优**：日志系统/事件系统里，逻辑线程高频 push、主线程每帧消费，用一把互斥锁会导致竞争和卡顿。改用双缓冲队列——生产者写 queueA、消费者读 queueB，帧末整体交换（swap 指针），实现无锁高频写入。某项目的事件系统从 `mutex + queue` 改双缓冲后，每帧锁等待从 0.8ms 降到几乎为零。
- **网络插值的缓冲深度要可调**：固定缓冲 100ms 在网络稳定时完美，但遇到抖动（丢包、延迟突增）会"穿帮"——prev 和 next 之间出现空档，角色卡住或瞬移。生产实践是做自适应缓冲深度：监测抖动（jitter），抖动大时动态加深缓冲到 150-200ms，网络恢复后再收紧，用延迟换平滑。
- **Typed Array 是双缓冲的最佳载体**：用 `Float32Array` / `Uint8Array` 做双缓冲，数据连续存储、零 GC、CPU 缓存命中高。用普通对象数组 `{x,y,z}[]` 虽然也能双缓冲，但对象散落在堆上、缓存不友好，海量数据（粒子、格子）场景下性能差 3-5 倍。凡是能上 Typed Array 的双缓冲都别用对象数组。
- **后处理 Ping-Pong 要注意纹理格式匹配**：HDR 泛光需要浮点纹理（R16F），但有些移动端不支持，被迫降级到 RGBA8 会导致高光区域截断（泛光范围变窄）。双缓冲的两张纹理格式必须一致，且要预先查询设备能力做降级，否则某个 pass 读写格式不匹配直接黑屏，且只在特定机型复现，排查极痛苦。

### 🔗 相关问题

1. 三缓冲（Triple Buffer）相比双缓冲有什么优势？为什么高刷显示和降低输入延迟时会用三缓冲？它和双缓冲的显存/延迟取舍是什么？
2. 元胞自动机除了做洞穴生成，还能怎么用在程序化内容里？沃罗诺伊图、柏林噪声、波函数坍缩（WFC）和元胞自动机各适合什么生成需求？
3. 无锁队列（如 Disruptor 模式）和双缓冲队列有什么区别？什么场景下无锁队列比双缓冲队列更合适？
