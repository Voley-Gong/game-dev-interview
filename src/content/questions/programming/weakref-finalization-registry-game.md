---
title: "WeakRef、FinalizationRegistry 和 WeakMap 在游戏中怎么用？如何实现「不泄漏」的资源缓存？"
category: "programming"
level: 3
tags: ["JavaScript", "内存管理", "WeakRef", "FinalizationRegistry", "WeakMap", "GC", "资源缓存", "自动清理"]
related: ["programming/memory-gc-optimization", "programming/closure-memory-leak", "programming/lru-lfu-cache-game"]
hint: "强引用会让对象永远活在 GC 图里。WeakRef/WeakMap 不阻止回收，适合做「有就用、没有就重建」的资源缓存。FinalizationRegistry 能在对象被 GC 时收到回调做清理——但它是「最终一致」不是「即时」，别拿它当析构函数用。"
---

## 参考答案

### ✅ 核心要点

1. **强引用（普通引用）让对象永驻内存，是缓存泄漏的根源**。JS 的 GC 通过「可达性分析」判断对象是否存活：只要从 GC Root（全局对象、调用栈、事件队列）有一条强引用链能到达该对象，它就不会被回收。把对象塞进 `Map`/数组做缓存，即使业务代码已经不再需要它，这条强引用链依然存在，对象永远无法被 GC——这就是「缓存越涨越大」的本质。游戏里纹理、音效、角色配置的缓存如果用强引用 `Map`，玩久了内存必然膨胀到 OOM。
2. **WeakMap / WeakSet 的 key 是弱引用，不阻止 key 被 GC**。`WeakMap` 的特殊之处在于：它对 key 持有弱引用（不计入可达性），一旦 key 在外部没有其他强引用，GC 可以回收这个 key，对应的 entry 也会被自动清除。典型用途：给对象附加「旁路数据」（如给实体附加私有的元信息），对象销毁时附加数据自动消失，无需手动清理。但 WeakMap 的 key 必须是对象，且不可遍历（无法 `keys()`/`size`），这是为了不暴露 GC 内部状态。
3. **WeakRef 显式创建对对象的弱引用，`.deref()` 取值可能返回 undefined**。`new WeakRef(obj)` 创建一个弱引用容器，`ref.deref()` 返回原始对象——如果对象已被 GC，则返回 `undefined`。使用模式：先 deref，有值直接用；没值就重建并重新包装。这是实现「软缓存（有就用、没就重建）」的核心原语。注意 WeakRef 不保证对象一定被回收（取决于 GC 策略和内存压力），所以它是「内存友好」而非「精确控制生命周期」的工具。
4. **FinalizationRegistry 在对象被 GC 回收时触发回调，但它是「尽力而为、可能延迟」的**。`new FinalizationRegistry((heldValue) => { /* 清理逻辑 */ })` 注册一个回调，当被监听的对象被 GC 时，回调会收到一个 `heldValue`（你注册时提供的「清理凭证」，如资源句柄）。关键认知：这个回调**不是析构函数**——它可能在 GC 后很久才触发、甚至运行时关闭时根本不触发。它适合做「最终一致的兜底清理」（如关闭文件句柄、注销事件），绝不能用来跑「必须精确执行」的逻辑（如保存存档、提交战绩）。
5. **三者配合能实现「零泄漏的资源缓存」：WeakMap 做旁路数据、WeakRef 做软缓存、FinalizationRegistry 做兜底清理**。游戏资源缓存的理想形态：纹理加载后用 WeakRef 持有，内存紧张时 GC 自动回收纹理、FinalizationRegistry 触发 GPU 纹理释放；下次用到时 deref 返回 undefined、自动重新加载。整个过程无需手动管理生命周期，内存占用随实际使用量自动伸缩。但要配合 LRU 策略控制「近期最少使用」的强引用，避免热资源被 GC 误回收导致频繁重加载（抖动）。

### 📖 深度展开

#### 1. 强引用泄漏 vs WeakMap 自动清理

```typescript
// ❌ 强引用 Map 做缓存：实体销毁了，缓存里还留着，内存泄漏
const entityMeta = new Map<Entity, MetaData>();
function onEntityCreate(e: Entity) {
  entityMeta.set(e, loadMeta(e));   // 强引用：e 永远无法被 GC
}
function onEntityDestroy(e: Entity) {
  // 忘了 delete？泄漏。删早了？use-after-free。手动管理容易出错
  entityMeta.delete(e);             // 必须手动删，漏一处就泄漏
}

// ✅ WeakMap：key 是弱引用，e 被销毁后 entry 自动消失，零泄漏
const entityMeta = new WeakMap<Entity, MetaData>();
function onEntityCreate(e: Entity) {
  entityMeta.set(e, loadMeta(e));   // 弱引用 key：不阻止 e 被 GC
}
// onEntityDestroy 里什么都不用写！e 失去外部强引用后，entry 自动被 GC 清除
```

```
强引用 vs 弱引用的 GC 可达性：

  GC Root (全局/栈)
    │
    ├─ entityMap (强引用 Map)
    │     └── Entity#1 ──→ MetaData    ← Entity#1 即使业务不用了，仍被 Map 强引用，永驻
    │
    └─ entityMeta (WeakMap)
          └─(weak)─→ Entity#2 ──→ MetaData   ← Entity#2 外部无强引用 → GC 回收 → entry 自动消失
```

#### 2. WeakRef 软缓存：纹理资源「有就用、没就重建」

```typescript
// ★ 用 WeakRef + FinalizationRegistry 实现自动伸缩的纹理缓存
class TextureCache {
  private cache = new Map<string, WeakRef<Texture>>();  // 弱引用持有纹理
  private registry = new FinalizationRegistry<string>((key) => {
    // ★ 纹理被 GC 时触发：释放 GPU 显存 + 清理缓存条目
    const ref = this.cache.get(key);
    if (ref && !ref.deref()) {     // 二次确认：确实被回收了（可能已被新纹理覆盖）
      this.cache.delete(key);
      gpuDestroyTexture(key);      // 兜底释放 GPU 资源
      console.log(`[Cache] 纹理 ${key} 被 GC，释放 GPU 显存`);
    }
  });

  get(url: string): Texture {
    const ref = this.cache.get(url);
    const tex = ref?.deref();      // ★ 可能返回 undefined（已被 GC）
    if (tex) return tex;           // 缓存命中，直接用

    const loaded = loadTexture(url);            // miss，重新加载
    this.cache.set(url, new WeakRef(loaded));
    this.registry.register(loaded, url, loaded); // 监听回收，凭证传 url
    return loaded;
  }
}
// 优势：内存紧张时 GC 自动回收冷门纹理，无需手动 LRU 淘汰；
//       热纹理因被场景图强引用，不会被误回收
```

#### 3. 三种弱引用 API 的对比与适用场景

| API | 引用对象类型 | 阻止 GC？ | 可遍历/可计数？ | 典型游戏用途 |
|-----|------------|----------|--------------|-------------|
| `WeakMap` | key 必须是对象 | ❌ key 可被回收 | ❌ 无 size/keys | **实体旁路元数据**、对象→私有映射 |
| `WeakSet` | 只存对象 | ❌ 元素可被回收 | ❌ 无 size | 标记「已访问」「已处理」 |
| `WeakRef` | 任意对象的弱壳 | ❌ 可被回收 | `.deref()` 取值 | **软缓存**（纹理/音效，有就用没就建） |
| `FinalizationRegistry` | 监听 GC 事件 | — | 回调式，异步 | **兜底资源释放**（GPU 句柄、文件句柄） |
| 普通 `Map`/`Set` | 任意 | ✅ 永驻 | ✅ 可遍历 | LRU 强引用区（保热资源不被回收） |

```
完整的「双层缓存」架构（弱引用层 + LRU 强引用层）：

  请求纹理 get(url)
       ↓
  ┌─ LRU 强引用层（保 top-N 热资源） ──┐  命中？→ 返回（热路径，绝不回收）
  └────────────────────────────────────┘
       ↓ miss
  ┌─ WeakRef 软缓存层（冷资源） ───────┐  deref() 有值？→ 返回 + 提升进 LRU
  └────────────────────────────────────┘
       ↓ miss / 已被 GC
  重新加载 → 写入两层 + 注册 FinalizationRegistry
       ↓
  内存压力 → GC 回收 WeakRef 层冷资源 → FinalizationRegistry 释放 GPU 显存
  （LRU 层的热资源受强引用保护，绝不被误回收）
```

```typescript
// 双层缓存的命中逻辑（避免热资源频繁重加载的抖动）
class TwoLayerTextureCache {
  private lru = new Map<string, Texture>();        // 强引用，保热资源
  private soft = new Map<string, WeakRef<Texture>>(); // 弱引用，冷资源
  private readonly LRU_MAX = 50;                   // 强引用上限

  get(url: string): Texture {
    // 1. 强引用层命中（热路径）
    const hot = this.lru.get(url);
    if (hot) return hot;

    // 2. 弱引用层命中：提升到强引用层（防止刚用完就被 GC）
    const ref = this.soft.get(url);
    const warm = ref?.deref();
    if (warm) { this.promote(url, warm); return warm; }

    // 3. 双层都 miss：加载
    const tex = loadTexture(url);
    this.promote(url, tex);
    return tex;
  }

  private promote(url: string, tex: Texture) {
    if (this.lru.size >= this.LRU_MAX) {
      const [evictedKey, evictedTex] = this.lru.entries().next().value!;
      this.lru.delete(evictedKey);
      this.soft.set(evictedKey, new WeakRef(evictedTex)); // 降级到弱引用层
    }
    this.lru.set(url, tex);
    this.soft.delete(url);  // 强引用层有了，弱引用层不用重复
  }
}
```

### ⚡ 实战经验

- **FinalizationRegistry 回调延迟触发害死人**：依赖 `FinalizationRegistry` 回调来「对象销毁时自动保存战绩」，结果玩家强杀进程时回调根本没触发，战绩丢失。FinalizationRegistry 是「尽力而为」，GC 策略、内存压力、进程退出都会影响是否/何时触发。**任何「必须执行」的清理（存档、上报、付费）都要用显式 `dispose()` 调用，FinalizationRegistry 只能当兜底**。
- **WeakRef 缓存导致热资源被误回收「抖动」**：纯 WeakRef 缓存纹理，Boss 战激烈时场景图恰好没强引用某背景纹理，GC 把它回收了，下一帧重新加载卡了 **120ms** 掉帧。修复：加 LRU 强引用层保住 top-50 热资源（双层缓存），抖动消失。教训：纯弱引用缓存适合「重建廉价」的对象，纹理这种重建贵的必须搭配强引用保活。
- **WeakMap 的 key 必须是对象，给 number ID 附加数据要用对象壳**：想用 `WeakMap<number, Meta>` 给实体 ID 附加元数据，编译报错——key 必须是对象。解法是把 ID 包装成对象（`const id = { value: 1001 }`）或改用 slot-map 的代际索引对象。这反过来说明 WeakMap 适合「给对象实例附加数据」，不适合「给原始 ID 附加数据」。
- **V8 的 GC 可能很久不回收弱引用对象，别指望即时释放**：在内存充裕的开发机上， WeakRef 的对象可能几十分钟都不被 GC（V8 按「内存压力触发」而非「引用消失即回收」），导致你以为「自动清理」生效了，上线到低端机内存紧张时才暴露问题。测试时手动触发 `--expose-gc` + `gc()` 或用 `FinalizationRegistry` 打日志验证清理确实发生。

### 🔗 相关问题

- **WeakRef 和 Java 的 `WeakReference`/`SoftReference` 有什么区别？** —— 提示：Java 区分 Weak（下次 GC 必回收）和 Soft（内存不足才回收）两种强度，JS 的 WeakRef 只有一种、行为接近 Soft（由引擎决定），无法精确控制回收时机。
- **FinalizationRegistry 能用来实现 RAII（资源获取即初始化）吗？** —— 提示：不能。RAII 要求「离开作用域立即析构」，JS 是 GC 语言没有确定性析构；FinalizationRegistry 的回调时机不确定。需要确定性释放必须用显式 `dispose()`/`using`（TC39 Explicit Resource Management 提案）。
- **WeakMap 和 LRU 缓存该怎么选？** —— 提示：WeakMap 适合「key 的生命周期由外部决定」的旁路数据（对象销毁自动清理）；LRU 适合「需要主动控制容量上限」的资源缓存（纹理/音效）。游戏资源缓存常用两者结合：WeakRef 做软缓存层、LRU 做强引用保活层。
