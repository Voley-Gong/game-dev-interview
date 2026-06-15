---
title: "Cocos Creator 3.x 如何利用多线程与 Web Worker 提升性能？"
category: "cocos"
level: 3
tags: ["多线程", "Web Worker", "性能优化", "架构设计"]
related: ["cocos/profiler-and-performance", "cocos/memory-management"]
hint: "主线程被计算密集型任务卡住时，Cocos 有哪些异步/多线程方案？"
---

## 参考答案

### ✅ 核心要点

1. **Web 平台**：使用 Web Worker 将计算密集型任务移至后台线程
2. **原生平台**：通过 JSB 接口调用 C++ 层的多线程能力（如 `Task` API）
3. **资源加载**：`assetManager` 内部已使用 Worker 做资源解压缩和解析
4. **SharedArrayBuffer**：在支持的平台上实现主线程与 Worker 的零拷贝数据共享
5. **消息通信**：主线程 ↔ Worker 通过 `postMessage` 异步通信，支持 Transferable Objects

### 📖 深度展开

#### 为什么需要多线程？

Cocos Creator 运行在 JavaScript 引擎中（V8 / JavaScriptCore），**渲染逻辑和游戏逻辑都在主线程**执行。当遇到以下场景时，单线程会成为瓶颈：

- 寻路算法（A* / JPS，大地图下每次计算可能耗时 10-50ms）
- 大量物理碰撞检测（粒子碰撞、布料模拟）
- JSON / Protobuf 大数据解析（服务器推送战报）
- 图片编解码（运行时生成贴图）
- 复杂数学运算（ procedural terrain generation）

#### Web Worker 基础架构

```
主线程 (Main Thread)
  ├── Cocos Engine (渲染 + 游戏循环)
  ├── Worker: pathfinding.worker.js (寻路)
  ├── Worker: physics.worker.js (物理模拟)
  └── Worker: netcode.worker.js (网络协议解析)

  ↕ postMessage / Transferable Objects ↕
```

#### 在 Cocos 项目中创建 Worker

```typescript
// 1. 创建 Worker 文件：src/workers/pathfinding.worker.ts
self.onmessage = function(e: MessageEvent) {
    const { grid, start, end } = e.data;
    const path = findPath(grid, start, end); // A* 寻路

    // 使用 Transferable 传回数据，避免拷贝
    const result = new Float32Array(path.flat());
    self.postMessage({ path: result.buffer }, [result.buffer]);
};

function findPath(grid: number[][], start: [number, number], end: [number, number]): number[][] {
    // A* 算法实现...
    return path;
}
```

```typescript
// 2. 主线程封装 Worker 管理
export class PathfindingWorker {
    private worker: Worker | null = null;
    private pendingResolvers: Map<number, (path: number[]) => void> = new Map();
    private taskId = 0;

    init(): void {
        // Cocos 3.x 中通过 assetManager 或 vite 插件加载 Worker
        this.worker = new Worker(new URL('../workers/pathfinding.worker.ts', import.meta.url));

        this.worker.onmessage = (e: MessageEvent) => {
            const { taskId, path } = e.data;
            const resolver = this.pendingResolvers.get(taskId);
            if (resolver) {
                resolver(Array.from(new Float32Array(path)));
                this.pendingResolvers.delete(taskId);
            }
        };
    }

    /** 异步寻路请求 */
    requestPath(grid: number[][], start: [number, number], end: [number, number]): Promise<number[]> {
        return new Promise((resolve) => {
            const id = ++this.taskId;
            this.pendingResolvers.set(id, resolve);
            // grid 通过 structured clone 传递（大数据建议用 SharedArrayBuffer）
            this.worker!.postMessage({ taskId: id, grid, start, end });
        });
    }

    destroy(): void {
        this.worker?.terminate();
        this.worker = null;
        this.pendingResolvers.clear();
    }
}
```

#### 数据传输方式对比

| 方式 | 拷贝开销 | 适用场景 | 限制 |
|------|---------|---------|------|
| `postMessage(data)` | 深拷贝（Structured Clone） | 小对象、配置 | 序列化耗时 |
| `postMessage(data, [buffer])` | 零拷贝（Transferable） | ArrayBuffer / ImageBitmap | 传后主线程不可用 |
| `SharedArrayBuffer` | 零拷贝（共享内存） | 高频读写的大数据 | 需 COOP/COEP 头 |
| `Atomics + SAB` | 零拷贝 + 同步 | 实时音视频、流式数据 | 需要手动同步 |

#### 原生平台（JSB）多线程

在原生环境下，Cocos 通过 `native` 模块提供 C++ 线程池能力：

```typescript
// 使用 Cocos 的 Task 系统（如果可用）
if (sys.platform === sys.Platform.NATIVE) {
    // 通过 jsb 调用 C++ 线程池
    jsb.Task.pushTask(() => {
        // 这段代码在 C++ 后台线程执行
        const result = heavyComputation();
        // 切回主线程更新 UI
        jsb.Task.pushMainTask(() => {
            this.updateUI(result);
        });
    });
}
```

#### 实际应用：Worker 化的 A* 寻路

```typescript
// 游戏中的使用
const pathfinding = new PathfindingWorker();
pathfinding.init();

// 玩家点击地图寻路时
onTouchEnd(touch: Vec2) {
    const gridPos = this.worldToGrid(touch);
    pathfinding.requestPath(this.mapGrid, this.playerPos, gridPos)
        .then(path => {
            // 收到结果后，在主线程设置角色移动
            this.player.setMovePath(path);
        });
    // 注意：如果 60fps 下一帧没收到结果，可以播放"思考"动画过渡
}
```

#### 性能基准参考

在 100×100 网格 A* 寻路测试中：

| 方案 | 主线程耗时 | 帧率影响 |
|------|-----------|---------|
| 主线程同步计算 | 15-30ms | 掉帧到 30-40fps |
| Web Worker 异步 | <1ms（仅消息开销） | 无掉帧 |
| SharedArrayBuffer + Worker | <0.3ms | 无掉帧 |

### ⚡ 实战经验

1. **Worker 初始化时机**：不要在游戏启动时同步创建多个 Worker，每个 Worker 的 spawn 约需 50-200ms。建议在 Loading 场景预热创建，或按需懒加载。
2. **Transferable 坑**：`postMessage(data, [transferList])` 中的 `transferList` 必须是 `ArrayBuffer` 而非 `TypedArray`。传错会导致数据被拷贝而非转移，性能差 10 倍。正确写法：`worker.postMessage({buf: arr.buffer}, [arr.buffer])`。
3. **Vite 构建 Worker**：Cocos 3.x 使用 Vite 构建，`new Worker(new URL('./xxx.worker.ts', import.meta.url))` 是标准写法。不要用内联 `Blob` 方式创建 Worker——在原生平台不兼容。
4. **SharedArrayBuffer 跨域要求**：使用 SAB 需要服务器返回 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp` 头。部署时务必配置 CDN/Nginx，否则浏览器会拒绝创建。

### 🔗 相关问题

- 如何在不阻塞主线程的情况下解析大型 JSON / Protobuf 数据？
- Web Worker 之间能否直接通信（SharedWorker）？
- 原生平台 JSB 多线程与 Web Worker 的性能差异有多大？
