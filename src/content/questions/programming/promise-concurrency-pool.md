---
title: "如何实现 Promise 并发控制（异步池）？批量请求如何限流？"
category: "programming"
level: 2
tags: ["异步编程", "Promise", "并发控制", "性能优化", "网络请求"]
related: ["programming/asset-management-async", "programming/async-coroutine-scheduling", "programming/event-bus-architecture"]
hint: "Promise.all 一次发 500 个请求会触发限流和 OOM——需要一个并发上限可配的异步池，跑完一个补一个，还要处理失败重试和取消。"
---

## 参考答案

### ✅ 核心要点

1. **`Promise.all` 是全量并发，没有限流能力**：传入 500 个 Promise 会同时发起 500 个网络请求/文件读取，浏览器对同一域名有 6 个并发连接上限（HTTP/1.1），多余的排队；Node.js 无限制则会打爆下游服务器或耗尽文件描述符导致 OOM。游戏批量拉排行榜、同步背包、预加载资源时必须自己控制并发数，而非依赖 `Promise.all`。
2. **异步池的核心模型是"滑动窗口"**：维护一个大小为 `concurrency` 的"在途任务集合"，启动时先填满窗口，每当有一个任务完成（resolve 或 reject）就从待办队列取下一个补上，直到队列清空。本质是用有限的工作槽位串行化地消费无限的任务队列。
3. **三种主流实现各有取舍**：递归补位法（最直观，适合理解）、`p-limit` 风格的信号量法（生产首选，轻量）、`Promise.all` + 分批切片法（最简单但利用率低，前一批慢任务会阻塞整批）。生产环境推荐信号量法——它能在任意任务完成的瞬间立刻补位，不浪费槽位。
4. **错误处理策略决定业务正确性**：`Promise.all` 任一失败就整体 reject（fail-fast），但批量场景通常希望"尽可能多成功"——用 `Promise.allSettled` 收集全部结果再分类处理（fulfilled / rejected），或实现"失败重试 N 次 + 最终失败收集"的增强池。游戏资源加载中单个贴图失败不应让整批预加载崩溃。
5. **取消与优先级是进阶需求**：长时间批量任务（如下载几百 MB 资源包）需要支持中途取消（AbortController / cancellation token），让玩家切场景时能中断加载；高优先级任务（当前 UI 需要的图）应能插队到队列头部，而非 FIFO 排在几百个预加载任务后面。
6. **并发数不是越大越好，要按瓶颈调参**：网络密集型任务并发数受带宽和服务器限流约束（一般 6-16），CPU/IO 密集型受线程池大小约束。监控指标是"在途任务平均耗时"和"队列等待时长"——如果队列总在空等说明并发数偏小可调大，如果在途任务大量超时说明并发数过大打爆了下游。

### 📖 深度展开

#### 1. 信号量法异步池（生产首选实现）

```typescript
// 通用 Promise 池：控制最大并发，支持失败重试和取消
type Task<T> = () => Promise<T>;

class AsyncTaskPool<T> {
  private queue: Array<{ task: Task<T>; resolve: (v: T) => void; reject: (e: unknown) => void; retries: number }> = [];
  private active = 0;            // 当前在途任务数
  private cancelled = false;

  constructor(private concurrency: number, private maxRetries = 0) {}

  // 提交单个任务，返回 Promise（结果或最终错误）
  add(task: Task<T>): Promise<T> {
    if (this.cancelled) return Promise.reject(new Error('pool cancelled'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject, retries: this.maxRetries });
      this.tryRun();
    });
  }

  // 批量提交并等待全部完成（allSettled 语义，不因单个失败而中断整批）
  addAll(tasks: Task<T>[]): Promise<PromiseSettledResult<T>[]> {
    return Promise.allSettled(tasks.map(t => this.add(t)));
  }

  private tryRun(): void {
    // 只要还有空闲槽位且队列非空，就补位启动
    while (this.active < this.concurrency && this.queue.length > 0 && !this.cancelled) {
      const item = this.queue.shift()!;
      this.active++;
      item.task()
        .then(item.resolve)
        .catch((err) => {
          // 失败重试：还有重试次数就重新入队尾，否则彻底 reject
          if (item.retries > 0 && !this.cancelled) {
            item.retries--;
            this.queue.push(item);
          } else {
            item.reject(err);
          }
        })
        .finally(() => {
          this.active--;       // ⚡ 关键：无论成功失败都释放槽位
          this.tryRun();        // 槽位空出立刻补下一个，不浪费
        });
    }
  }

  cancel(): void { this.cancelled = true; this.queue = []; }
}

// 用法：限制并发为 8，单个失败重试 2 次
const pool = new AsyncTaskPool(8, 2);
const results = await pool.addAll(
  assetUrls.map(url => () => fetch(url).then(r => r.arrayBuffer()))
);
const ok = results.filter(r => r.status === 'fulfilled');
console.log(`成功 ${ok.length}/${results.length}`);
```

#### 2. 三种实现方案对比

```
任务队列：[T1, T2, T3, T4, T5, T6, T7, T8, T9, T10]   并发上限 = 3

方案A - 分批切片 (Promise.all × N批)：        利用率低 ⚠️
  批次1: [T1 T2 T3] → 全部完成
  批次2: [T4 T5 T6] → 全部完成       ← T4 慢，T5/T6 空等，槽位浪费
  批次3: [T7 T8 T9] ...

方案B - 递归补位：                            直观但栈深 ⚠️
  启动 T1 T2 T3 → T1完成 → 启动 T4 → T3完成 → 启动 T5 ...

方案C - 信号量 (tryRun 循环补位)：            生产首选 ✅
  槽位满 [T1 T2 T3] → 任一完成瞬间补下一个，零空等
  T1done→T4, T2done→T5, T3done→T6 ... 始终保持 3 个在途
```

| 方案 | 槽位利用率 | 实现复杂度 | 失败处理 | 取消支持 | 适用场景 |
|------|----------|----------|---------|---------|---------|
| **分批切片** (`Promise.all` × 批) | 低（慢任务阻塞整批） | 极低（10 行） | 整批 fail-fast | ❌ 难 | 快速原型、任务耗时均匀 |
| **递归补位** | 高 | 中 | 可自定义 | ⚠️ 中等 | 中小规模、易读优先 |
| **信号量** (`tryRun`) | 高（零空等） | 中（30 行） | 重试/收集可控 | ✅ 易 | **生产环境（首选）** |
| **`p-limit` 库** | 高 | 零（引库） | 需配合 allSettled | ⚠️ 弱 | 不想造轮子 |

#### 3. 游戏实战：资源预加载进度与中断

```typescript
// 进入关卡前预加载 300 个资源，并发 8，支持玩家取消和实时进度
class PreloadController {
  private pool = new AsyncTaskPool<ArrayBuffer>(8, 1);
  private total = 0;
  private done = 0;
  public onProgress: ((pct: number) => void) | null = null;

  async preload(urls: string[]): Promise<Map<string, ArrayBuffer>> {
    this.total = urls.length;
    this.done = 0;
    const assets = new Map<string, ArrayBuffer>();

    const settled = await this.pool.addAll(
      urls.map(url => () => fetch(url)
        .then(r => r.arrayBuffer())
        .then(buf => { assets.set(url, buf); return buf; })
        .finally(() => { this.done++; this.onProgress?.(this.done / this.total); })
      )
    );

    const failed = settled.filter(r => r.status === 'rejected');
    if (failed.length > 0) console.warn(`预加载失败 ${failed.length}/${urls.length}，已降级处理`);
    return assets;   // 即使部分失败也返回已成功的，不阻塞进场景
  }

  // 玩家点击"取消"或切场景时中断
  abort(): void { this.pool.cancel(); }
}

// UI 进度条
preload.onProgress = pct => loadingBar.fill = pct;     // 0.0 → 1.0
```

### ⚡ 实战经验

- **`Promise.all` 全量并发打爆服务器是最常见的线上事故**：某游戏开服活动一次性 `Promise.all` 拉取 800 个玩家头像 URL，瞬间 800 个请求打穿 CDN 回源，源站限流后大量请求超时，头像大面积加载失败。改为并发 16 的异步池后，总耗时仅增加 2 秒，但服务器 QPS 峰值降到 1/50，零超时。
- **并发数要根据瓶颈动态调整**：Wi-Fi 环境并发 16 最快，但 4G 弱网下并发 16 会导致每个请求都慢（带宽争抢），并发 4 反而总耗时更短。生产中应根据 `navigator.connection.effectiveType` 或实测 RTT 动态选并发数——弱网降到 4-6，宽带升到 12-16。
- **失败重试别无脑重试整个批次**：单个资源 URL 配错（404）会无限重试拖垮整批。重试必须有次数上限（2-3 次）和退避间隔（指数退避 200ms/400ms/800ms），且只重试"瞬时错误"（网络超时、5xx），不重试"永久错误"（404、403）。区分错误类型是健壮池的标志。
- **进度条要反映真实剩余而非已完成**：用 `done/total` 做进度条会在最后几个慢任务上"卡 99%"很久（长尾效应）。更准的估算是"已用时间 ÷ (已用时间 × 完成率)"预测总时长，或按资源字节大小加权——大资源权重高，进度条更平滑。
- **别忘了 AbortController 做真正的网络取消**：异步池的 `cancel()` 只是停止派发新任务，但**已经在途的 fetch 不会中断**（请求已发出）。要真正取消网络请求必须给 fetch 传 `AbortSignal`，`abort()` 后浏览器才会终止 TCP 连接，否则切场景后仍在偷偷下载浪费流量。

### 🔗 相关问题

1. `Promise.all`、`Promise.allSettled`、`Promise.any`、`Promise.race` 四者的语义和失败行为有何区别？分别适合什么批量场景？
2. 当任务之间有依赖关系（B 必须等 A 完成）时，如何用拓扑排序 + 异步池构建带依赖的批量执行计划？
3. Node.js 的 worker_threads 或浏览器 Web Worker 中，如何跨线程实现一个共享的并发池？多线程下并发计数器如何保证原子性？
