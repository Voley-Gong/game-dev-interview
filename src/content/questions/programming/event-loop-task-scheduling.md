---
title: "JavaScript 事件循环是怎样的？宏任务、微任务与游戏主循环如何协同？"
category: "programming"
level: 3
tags: ["异步编程", "事件循环", "宏任务", "微任务", "游戏循环", "性能优化", "requestAnimationFrame"]
related: ["programming/async-coroutine-scheduling", "programming/promise-concurrency-pool", "programming/web-worker-multithreading"]
hint: "setTimeout 排在 requestAnimationFrame 之后还是之前？一个 Promise 微任务会不会把整帧拖到掉帧？游戏主循环和 JS 事件循环是两条线，搅在一起就掉帧。"
---

## 参考答案

### ✅ 核心要点

1. **事件循环（Event Loop）是 JS 单线程异步的调度核心**。JS 主线程只有一个，靠\"调用栈 + 任务队列\"实现并发：同步代码在调用栈执行，异步操作（定时器、网络、IO）交给宿主环境（浏览器/Node）处理后，把回调作为\"任务\"推入队列；调用栈空了，事件循环就从队列取任务执行，如此循环。理解它的关键不是\"单线程\"，而是\"任务被分类、排队、按优先级取出\"——这个调度顺序直接决定了游戏里\"哪段代码先跑\"。
2. **宏任务（Macrotask）和微任务（Microtask）是两条独立队列，优先级不同**。宏任务：`setTimeout`、`setInterval`、`I/O`、UI 事件、`postMessage`、`requestAnimationFrame`（部分规范归为渲染步骤）。微任务：`Promise.then` 的回调、`queueMicrotask`、`MutationObserver`。**铁律：每个宏任务执行完后、下一个宏任务之前，会清空当前所有的微任务队列**——这意味着一个宏任务里塞 1000 个 Promise，它们会在本轮渲染前全部跑完，可能直接卡死帧。
3. **微任务的\"插队\"特性是性能杀手也是利器**。微任务总在\"当前同步代码之后、下一次渲染之前\"执行，没有延迟。好处是\"尽快响应\"（Promise 链不会等 16ms）；坏处是微任务过多会无限延后渲染——`Promise.resolve().then` 递归链可以永远不让出主线程，页面/UI 完全冻结。游戏里大量用 `.then` 串联的资源加载链，若每帧堆积微任务，会吃掉本该用于渲染/逻辑的帧时间。
4. **游戏主循环（Game Loop）应基于 `requestAnimationFrame`，而非 `setInterval`**。`requestAnimationFrame`（rAF）回调在浏览器每次重绘前触发，频率与显示器刷新率同步（通常 60Hz/120Hz），且\"页面不可见时自动暂停\"省电。`setInterval` 固定间隔、不与渲染同步、后台标签页仍跑（节流但跑），会导致逻辑与渲染错帧、后台白白耗电。游戏的标准做法：`rAF` 驱动\"更新+渲染\"一帧、用\"固定时间步长（Fixed Timestep）\"分离逻辑更新与帧率。
5. **帧预算（Frame Budget）是 16.67ms（60fps），超了就掉帧**。一帧里事件循环要完成：取一个宏任务（如 rAF 回调）→ 跑游戏 update + render → 清空这一轮产生的微任务 → 浏览器布局/绘制。任何一段超时都会让这一帧超过 16.67ms，表现为掉帧（jank）。用 `performance.now()` 测量每段耗时，把重的计算拆到 Web Worker 或分帧（时间切片），是保帧的关键。
6. **`async/await` 本质是 Promise 的语法糖，每个 `await` 是一次微任务让出**。`await` 之后的代码相当于 `.then` 的回调，进入微任务队列。这意味着 `await` 不是\"阻塞等待\"而是\"挂起当前函数、让出主线程\"——事件循环可以去跑别的任务。但连续 `await` 串行化（`await a(); await b()`）会浪费时间，能用 `Promise.all` 并行的别串行；同时一个函数里多次 `await` 会产生多个微任务检查点，增加调度开销。

### 📖 深度展开

#### 1. 事件循环的一次完整迭代

```typescript
// 事件循环伪代码：理解\"一帧\"里宏任务和微任务的交替
console.log('1. 同步');

setTimeout(() => console.log('4. 宏任务(setTimeout)'), 0);     // 进宏任务队列
queueMicrotask(() => console.log('3. 微任务'));                 // 进微任务队列
Promise.resolve().then(() => console.log('3. 微任务(Promise)'));

console.log('2. 同步');

// 输出顺序：1 → 2 → 3(微任务) → 3(微任务) → 4(宏任务)
// ★ 规则：同步代码跑完 → 清空所有微任务 → 才取下一个宏任务
```

```
事件循环单次迭代（一帧）的完整流程：

  ┌─ 取一个宏任务（如 rAF 回调 / setTimeout / UI 事件）执行
  │     ↓
  │  执行中可能产生新的微任务和宏任务，分别入队
  │     ↓
  ├─ 清空【全部】微任务队列（一个微任务可能再产生微任务，继续清直到空）
  │     ↓     ← ★ 微任务不清空，绝不进下一步，这就是\"微任务风暴卡帧\"的根源
  │
  ├─ 浏览器渲染步骤（rAF 回调 → 样式计算 → 布局 → 绘制）★ 仅在需要时
  │     ↓
  └─ 回到顶部取下一个宏任务 ...

  游戏一帧的理想预算（60fps）：
    宏任务(游戏 update + render) ≤ 12ms  +  微任务清理 ≤ 2ms  +  渲染 ≤ 2ms ≈ 16ms
```

#### 2. 游戏主循环：rAF + 固定时间步长（Fixed Timestep）

```typescript
// ★ 标准游戏循环：rAF 驱动，固定步长更新逻辑，插值渲染
class GameLoop {
  private lastTime = 0;
  private accumulator = 0;
  private readonly FIXED_DT = 1000 / 60;     // 逻辑固定 60 步/秒，与帧率解耦

  start(): void {
    this.lastTime = performance.now();
    requestAnimationFrame(this.tick);        // ★ 用 rAF 而非 setInterval
  }

  private tick = (now: number): void => {
    let frameTime = now - this.lastTime;
    this.lastTime = now;
    if (frameTime > 250) frameTime = 250;    // ★ 防止切后台回来\"螺旋死亡\"

    // 固定步长：把变长的 frameTime 拆成多个 FIXED_DT 逻辑帧
    this.accumulator += frameTime;
    while (this.accumulator >= this.FIXED_DT) {
      this.update(this.FIXED_DT);            // 逻辑更新（确定性，固定 dt）
      this.accumulator -= this.FIXED_DT;
    }

    const alpha = this.accumulator / this.FIXED_DT;   // 剩余比例用于插值
    this.render(alpha);                       // 渲染：用 alpha 在逻辑帧间插值，平滑
    requestAnimationFrame(this.tick);
  };

  private update(dt: number) { /* 物理/AI，固定 dt 保证确定性 */ }
  private render(alpha: number) { /* 用 alpha 插值实体位置后绘制 */ }
}
```

#### 3. 定时/调度 API 在游戏中的对比

| API | 类型 | 触发时机 | 后台标签页 | 与渲染同步 | 游戏典型用途 |
|-----|------|---------|-----------|-----------|-------------|
| `requestAnimationFrame` | 渲染步 | 每次重绘前 | 自动暂停（省电） | ✅ 同步 | **游戏主循环（首选）** |
| `setTimeout(fn, 0)` | 宏任务 | 尽快（最小 ~4ms 节流） | 节流到 1000ms | ❌ | 延迟一帧执行、让出主线程 |
| `setInterval` | 宏任务 | 固定间隔 | 节流 | ❌ | ❌ 不推荐驱动游戏（会漂移） |
| `queueMicrotask` | 微任务 | 当前同步代码后立即 | 立即 | ❌ | 尽快响应、状态批处理 |
| `Promise.then` | 微任务 | 同上 | 立即 | ❌ | 异步链、资源加载回调 |
| `MessageChannel`/`postMessage` | 宏任务 | 尽快（无 4ms 节流） | 节流 | ❌ | 比 setTimeout(0) 更快的让出 |

```typescript
// 性能技巧：用 MessageChannel 实现\"比 setTimeout(0) 更快的让出\"（时间切片）
// setTimeout(0) 被 HTML5 规范节流到 ≥4ms，MessageChannel 没有
const channel = new MessageChannel();
const yields: Array<() => void> = [];
channel.port1.onmessage = () => { const r = yields.shift(); r?.(); };  // 宏任务执行

// 把长任务切成 5ms 的片，每片后让出主线程跑渲染/输入，UI 不卡
async function chunkLongTask(tasks: (() => void)[]) {
  let start = performance.now();
  while (tasks.length) {
    tasks.shift()!();
    if (performance.now() - start > 5) {                // 超过 5ms 让出
      await new Promise<void>(r => yields.push(r));
      channel.port2.postMessage(null);                  // 触发下一个宏任务片
      start = performance.now();
    }
  }
}
```

### ⚡ 实战经验

- **`Promise` 微任务风暴把帧拖到 50ms**：背包系统每帧用 `.then` 链处理 200 个物品，200 个微任务在\"渲染前\"全部跑完，单帧飙到 50ms 掉到 20 帧。改用\"分帧处理\"（每帧只处理 10 个，剩余下帧继续）或干脆同步循环后，帧时间回到 3ms。教训：不要在每帧的更新里堆积大量微任务，微任务\"插队\"特性会无限延后渲染。
- **`setInterval` 驱动游戏循环导致逻辑漂移**：早期用 `setInterval(update, 16)`，但 setInterval 不保证精确间隔（被节流、被长任务阻塞），实际 dt 忽大忽小，物理模拟抖动、回放不一致。换成 rAF + 固定步长后，逻辑更新确定性稳定，回放功能也正常了。游戏循环永远用 rAF，setInterval 只适合\"每分钟检查一次推送\"这类低频任务。
- **切后台回来\"螺旋死亡（Spiral of Death）\"**：玩家切到后台 30 秒，回来时 `now - lastTime = 30000ms`，固定步长 while 循环要跑 1800 次逻辑更新追赶，直接卡死 10 秒。修复：clamp `frameTime` 到上限（如 250ms），超过就丢弃追赶——宁可逻辑短暂慢一拍也不要卡死，这是帧率无关游戏循环的必备防御。
- **`async/await` 串行化浪费一帧帧时间**：进场景时 `await loadA(); await loadB(); await loadC()` 三个资源串行加载 300ms，改成 `await Promise.all([loadA(), loadB(), loadC()])` 并行后 120ms。但注意：`Promise.all` 里任何一个 reject 会让整体失败，资源加载用 `Promise.allSettled` 收集部分成功更健壮。
- **`setTimeout(fn, 0)` 的 4ms 节流坑了\"下一帧执行\"逻辑**：想在当前帧渲染后、下一帧前执行某逻辑，用 `setTimeout(fn, 0)` 以为\"立即\"，实际被节流到 4ms 后且可能排到下下帧，逻辑时序错乱。要\"当前帧渲染后执行\"用 `requestAnimationFrame` 套两层（`rAF(() => rAF(fn))`），要\"尽快让出主线程\"用 `MessageChannel`——别迷信 setTimeout(0)。

### 🔗 相关问题

1. Node.js 的事件循环和浏览器的有何不同？（6 个阶段：timers/pending/poll/check/close callbacks，`process.nextTick` 优先级高于微任务）游戏服务端用 Node 时要注意什么？
2. `requestAnimationFrame` 在 120Hz/144Hz 高刷屏上回调频率是多少？固定步长游戏循环如何保证在高刷屏上逻辑不跑太快（不变成 120 逻辑帧/秒）？
3. 当一个宏任务里 `await` 了一个永不 resolve 的 Promise，事件循环会怎样？整个主线程会卡死吗？如何用超时机制防御（`Promise.race` + setTimeout）？
