---
title: "Web Worker 多线程：游戏中哪些计算该搬到子线程？"
category: "programming"
level: 3
tags: ["多线程", "Web Worker", "并行计算", "寻路", "性能优化"]
related: ["programming/async-coroutine-scheduling", "programming/data-structures-game"]
hint: "主线程管渲染和输入，重计算扔到 Worker——但线程间通信的序列化开销可能吃掉你省下的时间。"
---

## 参考答案

### ✅ 核心要点

1. **JS 是单线程的，Web Worker 是唯一的真并行**：主线程跑渲染、输入、游戏循环，Worker 跑计算密集任务。两者真正并行执行，不是协程式的时间片切换。一个页面最多用 `navigator.hardwareConcurrency` 个 Worker（通常 4-8 核）。
2. **通信靠 `postMessage`，默认是结构化克隆**：每次通信要序列化/反序列化数据，传 1MB 的对象可能花 5-15ms——如果计算本身才 3ms，搬线程反而更慢。大数据必须用 `Transferable`（ArrayBuffer）零拷贝转移所有权。
3. **适合搬的任务特征**：计算量大（>5ms）、通信频率低（每帧或几帧一次）、数据可序列化。典型场景：A* 寻路、物理模拟、导航网格生成、JSON/配置解析、大地图地形数据处理。
4. **不适合搬的任务**：需要频繁访问主线程状态（DOM、场景树）、通信频率极高（每帧多次小消息）、计算量小于 1ms 的——序列化开销远超收益。
5. **SharedArrayBuffer + Atomics 实现零拷贝共享**：多线程共享一块内存，配合 `Atomics.wait/notify` 做信号量。但需要 COOP/COEP 安全头，小游戏平台可能不支持，且调试极难（数据竞争不会报错只会出诡异 Bug）。
6. **Worker 不能直接访问游戏引擎 API**：Cocos/Unity 的场景操作、组件、渲染全在主线程，Worker 里只能算纯数据，算完传回主线程再应用到节点上——这就是"数据导向"思维的起点。

### 📖 深度展开

**1. 寻路 Worker：最经典的多线程场景**

```typescript
// === main.ts：主线程，负责发送寻路请求 ===
class PathfindingManager {
  private worker: Worker;
  private pending = new Map<number, (path: Vec2[]) => void>();

  constructor() {
    this.worker = new Worker(new URL('./pathfinding.worker.ts', import.meta.url));
    this.worker.onmessage = (e) => {
      const { id, path, found } = e.data;
      const cb = this.pending.get(id);
      if (cb) { cb(found ? path : []); this.pending.delete(id); }
    };
  }

  private nextId = 0;
  findPath(start: Vec2, end: Vec2, grid: Uint8Array): Promise<Vec2[]> {
    return new Promise(resolve => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      // ⚡ Transferable：grid 的 ArrayBuffer 零拷贝转移，主线程不再持有
      const buf = grid.buffer;
      this.worker.postMessage({ id, start, end, buf }, [buf]);
    });
  }
}

// === pathfinding.worker.ts：子线程，跑 A* 算法 ===
self.onmessage = (e: MessageEvent) => {
  const { id, start, end, buf } = e.data;
  const grid = new Uint8Array(buf);  // 直接使用转移过来的内存
  const path = aStarSearch(grid, start, end);  // 纯计算，不碰 DOM
  // 结果路径很小（几十个坐标），直接 postMessage 即可
  self.postMessage({ id, path, found: path.length > 0 });
};
```

```
主线程                          Worker 线程
  │                                │
  │── postMessage(grid, [buf]) ──► │ (buf 所有权转移，零拷贝)
  │   继续渲染不阻塞                │── A* 计算 (8-20ms)
  │   帧率不受影响                  │   (主线程同时跑 60fps)
  │◄── postMessage(path) ──────────│ (结果仅几百字节)
  │── 应用路径到角色节点             │
```

**2. 通信方式对比：哪种开销最小？**

| 方式 | 数据传递 | 开销 | 适用场景 | 限制 |
|------|----------|------|----------|------|
| `postMessage`（默认） | 结构化克隆 | 高（深拷贝） | 小对象、低频通信 | 大数据慢（1MB ≈ 10ms） |
| `postMessage` + Transferable | ArrayBuffer 所有权转移 | 极低（零拷贝） | 大数组、网格数据、图像 | 转移后原线程不能再用 |
| `SharedArrayBuffer` | 共享内存地址 | 零（直接读写） | 高频读写、物理模拟 | 需 COOP/COEP 头；需 Atomics 同步 |
| `BroadcastChannel` | 广播给所有 Worker | 中（克隆） | 多 Worker 间状态同步 | 兼容性需确认 |

```typescript
// SharedArrayBuffer 示例：物理模拟共享数据
// 主线程和 Worker 共享一块 Float32Array，Worker 写入物理结果，主线程读取
const shared = new SharedArrayBuffer(4 * 10000); // 1万个 float
const positions = new Float32Array(shared);

// Worker 通过 Atomics 通知主线程"第 N 帧算完了"
Atomics.store(states, FRAME_INDEX, frame);
Atomics.notify(states, FRAME_INDEX); // 唤醒等待的主线程
```

**3. Worker 池：管理多个子线程的任务调度**

```typescript
// 游戏中可能有多个并行的重计算任务，用 Worker 池管理
class WorkerPool {
  private workers: Worker[] = [];
  private queue: { task: () => void; resolve: Function }[] = [];

  constructor(size: number, workerUrl: URL) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl);
      w.busy = false;
      this.workers.push(w);
    }
  }

  submit(data: unknown, transfer?: Transferable[]): Promise<unknown> {
    return new Promise(resolve => {
      const idle = this.workers.find(w => !w.busy);
      if (idle) {
        idle.busy = true;
        idle.onmessage = (e) => { idle.busy = false; resolve(e.data); this.drain(); };
        idle.postMessage(data, transfer || []);
      } else {
        this.queue.push({ task: () => this.submit(data, transfer), resolve });
      }
    });
  }

  private drain() {
    if (this.queue.length === 0) return;
    const idle = this.workers.find(w => !w.busy);
    if (idle) { const next = this.queue.shift()!; next.task().then(next.resolve); }
  }
}
// 50 个小兵同时寻路 → 分配到 4 个 Worker 并行，总耗时降为 1/4
```

### ⚡ 实战经验

- **序列化吃掉多线程收益**：把 256×256 地形高度图用 `postMessage` 传给 Worker，序列化花了 12ms，而高度计算只花 4ms——还不如在主线程算。改用 `Transferable` 转移 `Float32Array.buffer` 后通信降到 0.1ms，整体快了 3 倍。
- **Worker 冷启动有 50-200ms 延迟**：首次 `new Worker()` 要加载和解析脚本，在场景切换时突然创建 4 个 Worker 会导致帧卡顿。应在 Loading 界面预创建 Worker 池，而非战斗中按需创建。
- **SharedArrayBuffer 数据竞争极难排查**：物理 Worker 和主线程同时读写同一块 `Float32Array`，偶发角色"瞬移"。加了 `Atomics.compareExchange` 做帧锁后才稳定，排查花了 3 天——能不用 SAB 就不用，Transferable 够用的场景别上 SAB。
- **iOS Safari Worker 数量限制**：同时跑超过 6 个 Worker 时，低端 iPhone 上 Safari 直接杀进程。Worker 池大小别超过 `navigator.hardwareConcurrency - 1`（留一个核给主线程），移动端保守用 2-3 个。
- **Worker 里不能 `console.log` 看场景对象**：Worker 无法访问主线程的对象引用，调试时打印的全是序列化后的纯数据。务必在 Worker 里构建独立的日志系统，通过 `postMessage` 把调试信息发回主线程统一输出。

### 🔗 相关问题

1. A* 寻路在 Worker 里算完后，如何做路径平滑和动态避障？结果回传后主线程还需要做什么后处理？
2. Cocos Creator / Unity 的 Web 导出版如何使用 Web Worker？引擎的物理引擎本身是否已经内部多线程？
3. 如果小游戏平台（微信/抖音）不支持 Web Worker，如何用帧分片（时间切片）模拟"伪多线程"效果？
