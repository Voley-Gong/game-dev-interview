---
title: "游戏资源加载与管理系统如何设计？"
category: "programming"
level: 3
tags: ["资源管理", "异步加载", "引用计数", "内存优化", "架构设计"]
related: ["programming/memory-gc-optimization", "programming/async-coroutine-scheduling"]
hint: "不只是『加载图片』，而是引用计数、异步队列、LRU 缓存、依赖关系图的系统工程。"
---

## 参考答案

### ✅ 核心要点

1. **引用计数是资源管理的基石**：每个资源维护一个引用计数，加载时 +1，释放时 -1，归零时才真正卸载。多个系统共享同一纹理时，引用计数确保不会提前释放导致其他系统出现黑块或崩溃。
2. **异步加载必须配合优先级队列**：资源请求不能阻塞主线程（否则掉帧），但也不能无序并发（会导致内存峰值飙升）。用优先级队列让 UI 紧急资源插队，预加载资源降级后台处理。
3. **依赖关系图决定加载顺序**：一个 Prefab 可能引用多个纹理、材质、动画，必须先加载依赖再加载本体。用拓扑排序构建加载计划，避免「材质加载完了但纹理还没好」的空指针。
4. **LRU 缓存控制内存上限**：手机游戏内存预算严格（低端机可能只有 512MB 可用），必须设定缓存上限，超出时按 LRU（最近最少使用）策略淘汰资源，防止 OOM 崩溃。
5. **资源版本管理与热更新**：资源需要版本号和哈希校验，热更新时只下载变化的资源包（增量更新），而非整包重下。Cocos 的 Asset Bundle、Unity 的 Addressables 都基于这一理念。
6. **加载状态机防止重复加载**：同一资源在一帧内被请求多次时，不应发起多次 IO，而应返回同一个 Promise，所有请求者在加载完成后统一回调。

### 📖 深度展开

#### 1. 引用计数资源管理器完整实现

```typescript
interface AssetRecord {
  asset: any;                    // 实际资源对象
  refCount: number;              // 引用计数
  state: 'loading' | 'loaded' | 'unloading';
  dependents: string[];          // 依赖的其他资源路径
  pendingCallbacks: Array<(asset: any) => void>; // 等待加载的回调
  size: number;                  // 资源占用内存（字节）
}

class AssetManager {
  private records = new Map<string, AssetRecord>();
  private totalMemory = 0;
  private maxMemory: number;     // 内存上限（字节）
  private lruList: string[] = []; // 最近使用顺序（尾部为最久未用）

  constructor(maxMemoryMB: number) {
    this.maxMemory = maxMemoryMB * 1024 * 1024;
  }

  // 加载资源并增加引用计数
  async load<T>(path: string): Promise<T> {
    let record = this.records.get(path);

    if (record) {
      // 已加载或正在加载
      record.refCount++;
      this.touchLRU(path);
      if (record.state === 'loaded') {
        return record.asset as T;
      }
      // 正在加载，挂载到回调链
      return new Promise<T>((resolve) => {
        record!.pendingCallbacks.push((asset) => resolve(asset as T));
      });
    }

    // 首次加载：创建记录
    record = {
      asset: null,
      refCount: 1,
      state: 'loading',
      dependents: [],
      pendingCallbacks: [],
      size: 0,
    };
    this.records.set(path, record);

    // 先递归加载依赖
    const deps = await this.loadDependencies(path);
    record.dependents = deps;

    // 检查内存是否超限，超限则触发 LRU 淘汰
    await this.ensureMemoryBudget(estimatedSize);

    // 执行实际加载（引擎 API）
    const asset = await this.doLoadAsset(path);
    record.asset = asset;
    record.size = this.estimateSize(asset);
    record.state = 'loaded';
    this.totalMemory += record.size;
    this.touchLRU(path);

    // 触发所有等待中的回调
    for (const cb of record.pendingCallbacks) {
      cb(asset);
    }
    record.pendingCallbacks = [];

    return asset as T;
  }

  // 释放引用，引用计数归零时真正卸载
  release(path: string): void {
    const record = this.records.get(path);
    if (!record || record.refCount <= 0) {
      console.warn(`[AssetManager] Over-release: ${path}`);
      return;
    }

    record.refCount--;

    if (record.refCount === 0 && record.state === 'loaded') {
      // 卸载本体
      this.unloadAsset(record.asset);
      record.state = 'unloading';
      this.totalMemory -= record.size;

      // 递归释放依赖（依赖也可能被其他资源引用）
      for (const dep of record.dependents) {
        this.release(dep);
      }

      this.records.delete(path);
      this.lruList = this.lruList.filter(p => p !== path);
    }
  }

  // LRU 淘汰：当内存接近上限时释放最久未用的资源
  private async ensureMemoryBudget(incomingSize: number): Promise<void> {
    while (this.totalMemory + incomingSize > this.maxMemory
           && this.lruList.length > 0) {
      const evictPath = this.lruList.shift()!; // 移除最久未用
      const record = this.records.get(evictPath);
      if (record && record.refCount === 0) {
        this.unloadAsset(record.asset);
        this.totalMemory -= record.size;
        this.records.delete(evictPath);
        console.log(`[AssetManager] LRU evicted: ${evictPath}`);
      }
    }
  }

  private touchLRU(path: string): void {
    this.lruList = this.lruList.filter(p => p !== path);
    this.lruList.push(path);
  }
}
```

#### 2. 异步加载优先级队列架构

```
资源请求进入
  ↓
┌─────────────────────────────────────┐
│         优先级队列 (3级)              │
│  ┌─────────┐ ┌─────────┐ ┌────────┐ │
│  │ High(0) │ │ Mid(1)  │ │ Low(2) │ │
│  │ UI/角色  │ │ 场景物   │ │ 预加载  │ │
│  └────┬────┘ └────┬────┘ └───┬────┘ │
│       └─────┬─────┘─────┬────┘      │
│             ↓           ↓            │
│       并发加载器池 (maxConcurrent=4)  │
│       Worker1  Worker2  Worker3  W4 │
└─────────────────┬───────────────────┘
                  ↓
        加载完成回调（主线程）

并发控制规则：
- High 队列总是优先出队
- 同优先级内 FIFO
- 最大并发数根据平台调整（手机2-3，PC 6-8）
- 超时检测：单个资源加载超 30s 报警
```

```typescript
class PrioritizedLoadQueue {
  private queues: AssetRequest[][] = [[], [], []]; // 3个优先级
  private running = 0;
  private maxConcurrent = 4;

  request(path: string, priority: 0 | 1 | 2): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queues[priority].push({ path, resolve, reject });
      this.tryNext();
    });
  }

  private tryNext(): void {
    while (this.running < this.maxConcurrent) {
      const req = this.dequeue();
      if (!req) break;

      this.running++;
      this.loadAsset(req.path)
        .then(req.resolve)
        .catch(req.reject)
        .finally(() => {
          this.running--;
          this.tryNext(); // 加载完成后继续取下一个
        });
    }
  }

  private dequeue(): AssetRequest | null {
    for (let p = 0; p < 3; p++) {
      if (this.queues[p].length > 0) {
        return this.queues[p].shift()!;
      }
    }
    return null;
  }
}
```

#### 3. 各平台资源管理策略对比

| 策略维度 | Cocos Creator | Unity Addressables | 自研方案 |
|---------|--------------|--------------------|---------| 
| 寻址方式 | UUID + Bundle 路径 | 字符串地址 | 自定义 Key |
| 依赖解析 | 引擎自动 | 自动 | 需自行维护依赖图 |
| 引用计数 | 手动 retain/release | 自动（Handle） | 需自实现 |
| 热更新 | Asset Bundle 增量 | Catalog 增量 | 需自研 diff |
| 内存预算控制 | 无内置 | 有 Profile 工具 | 需自实现 LRU |
| 异步 API | Promise/回调 | Task/Coroutine | 可选 |
| 适用场景 | Cocos 小游戏 | 中大型 Unity 项目 | 极致优化定制 |

### ⚡ 实战经验

- **引用计数泄漏是最隐蔽的 bug**：某游戏进入/退出关卡 30 次后内存从 300MB 涨到 800MB，排查发现关卡退出时只释放了 Prefab 但没释放其引用的 12 张纹理。必须建立完整的依赖链释放，或用 `WeakRef` 辅助检测。
- **并发加载导致内存尖峰**：场景切换时同时请求 200 个资源，瞬时内存峰值超出预算导致 iOS OOM 崩溃。解决方案是分帧加载——每帧最多发起 8 个请求，配合加载进度条，总耗时增加 0.5 秒但峰值降低 60%。
- **纹理是内存大户**：一张 2048×2048 的 RGBA 纹理占用 16MB 内存，一个场景用 50 张就是 800MB。必须做纹理压缩（ASTC/ETC2）、尺寸控制和 mipmap 策略——UI 纹理关 mipmap 省 33% 内存。
- **热更新的增量包要做哈希校验**：曾遇到 CDN 缓存导致玩家下到旧版本资源包，与新代码不兼容直接黑屏。每个资源文件必须带版本号 + MD5，加载时校验不匹配则强制重下。
- **预加载时机比加载本身更重要**：在 Loading 界面预加载下一场景 80% 的资源，进入场景时只补加载动态部分，可以将场景切换卡顿从 2 秒降到 0.3 秒。但预加载太多会占用当前场景的内存预算，需要精细平衡。

### 🔗 相关问题

- 如何实现资源的热更新增量包？Diff 算法怎么选？
- 纹理压缩格式（ASTC、ETC2、PVRTC）如何根据目标平台选择？
- 如何在不卡主线程的前提下做资源加载进度条？
