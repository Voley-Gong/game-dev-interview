---
title: "游戏中的缓存淘汰策略（LRU/LFU）怎么实现和选型？"
category: "programming"
level: 2
tags: ["缓存", "LRU", "LFU", "算法", "资源管理", "性能优化"]
related: ["programming/memory-gc-optimization", "programming/asset-management-async"]
hint: "不是开个 Map 就完事——纹理/技能特效缓存膨胀到几百 MB 时，淘汰策略决定了内存稳定还是崩。"
---

## 参考答案

### ✅ 核心要点

1. **缓存必须有上限**：游戏里的资源缓存（纹理、特效、配置、动画片段）只增不减，LRU/LFU 的本质就是"满了该踢谁"。没上限的缓存 = 慢性内存泄漏。
2. **LRU（最近最少使用）淘汰最久没访问的**：基于"时间局部性"假设——刚用过的大概率还要用。实现核心是哈希表 + 双向链表，保证 get/put 都是 O(1)。
3. **LFU（最不经常使用）淘汰访问频率最低的**：基于"频率局部性"——用得多的更值得留。缺点是新数据刚进来频率低容易被误杀，且实现比 LRU 复杂（要维护频率桶）。
4. **游戏场景偏向 LRU**：玩家在场景里看什么、碰什么具有强时间局部性（当前关卡的纹理、当前角色的技能特效）。LFU 更适合排行榜、热门资源这类长期统计场景。
5. **淘汰时机和代价要分离**：不要在淘汰时同步销毁 GPU 纹理（可能卡帧），应该标记为"可回收"，放到帧末或加载间隙再真正释放。
6. **TS/JS 有现成的 O(1) 妙招**：`Map` 的迭代顺序就是插入顺序，利用 `delete` + `set` 即可在不手写双向链表的前提下实现 LRU，但要警惕高频 `delete` 对 V8 的 hidden class 影响。

### 📖 深度展开

**1. LRU 经典实现：哈希表 + 双向链表（O(1)）**

```
访问 key=3 时：

哈希表 (Map<key, Node>)
  1 → Node(1) ⇄ Node(3) ⇄ Node(2) ⇄ Node(4)
       ↑head                          ↑tail  (最久未用，淘汰目标)

读 key=3 → 命中 → 把 Node(3) 移到 head
写入新 key → 若满，先踢 tail，再 head 插入

所有操作都是指针搬动，不遍历，O(1)
```

```typescript
class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key)!;
    this.map.delete(key);   // 删除再重新插入，让它变成"最新"
    this.map.set(key, v);
    return v;
  }

  put(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      // Map 迭代按插入顺序，first 就是最久未用的
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}
```

> ⚠️ 这个 Map 版很简洁，但每次 get 都 `delete+set` 会触发 V8 的字典退化。**高频热路径（每帧数百次访问）建议手写双向链表版**，避免 GC 抖动。

**2. LRU vs LFU vs FIFO 选型对比**

| 策略 | 淘汰依据 | 实现复杂度 | 适合的游戏场景 | 典型坑 |
|------|----------|-----------|---------------|--------|
| **LRU** | 最久没访问 | 中（链表） | 纹理/特效/角色资源缓存 | 全量扫描式访问会污染（如加载界面） |
| **LFU** | 访问次数最少 | 高（频率桶） | 排行榜、热门装扮统计 | 新数据"冷启动"被误杀 |
| **FIFO** | 先进先出 | 低（队列） | 日志、临时下载缓存 | 经常访问的热点也可能被踢 |
| **ARC** | LRU+LFU 自适应 | 很高 | 通用数据库缓存 | 游戏侧很少用，过度设计 |

**3. 游戏实战：纹理缓存 + 延迟销毁**

```typescript
// 纹理不能在淘汰瞬间销毁（GPU 上传/引用计数），用"待回收"队列分离
interface CacheEntry<T> {
  value: T;
  lastUsed: number;     // 帧时间戳，LRU 判定
  refCount: number;     // 引用计数，>0 不允许淘汰
}

class TextureCache {
  private entries = new Map<string, CacheEntry<Texture>>();
  private gcQueue: string[] = [];        // 标记待回收，帧末统一处理
  constructor(private max = 256) {}

  acquire(id: string, now: number): Texture | null {
    const e = this.entries.get(id);
    if (e) { e.lastUsed = now; e.refCount++; return e.value; }
    return null; // 未命中，由调用方异步加载后 put
  }

  release(id: string) {
    const e = this.entries.get(id);
    if (e) e.refCount--;
  }

  // 帧末调用：淘汰 LRU 但跳过引用中的，真正的 GPU 销毁延后
  evict(now: number) {
    if (this.entries.size <= this.max) return;
    const sorted = [...this.entries.entries()]
      .filter(([, e]) => e.refCount === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed); // 升序，最旧在前
    for (const [id] of sorted) {
      if (this.entries.size <= this.max) break;
      this.gcQueue.push(id);    // 不立即销毁，进队列
      this.entries.delete(id);
    }
  }
}
```

```
淘汰流程（避免卡帧）：

游戏帧
  ├─ Update: 大量 acquire/release（refCount 动态变化）
  ├─ Render: 使用纹理
  └─ LateUpdate: evict() 标记 → gcQueue
                          ↓
                下一帧加载间隙: 真正 gl.deleteTexture()
```

### ⚡ 实战经验

- **排行榜用 LFU/计数，资源用 LRU**：一个卡牌游戏把排行榜和卡面纹理混在一个 LRU 缓存里，结果热门排行榜查询挤占了卡面，战斗中频繁重新加载纹理掉帧。拆成两个独立缓存后各自调上限解决。
- **预热比淘汰更重要**：每局开始一次性预加载该局所有角色纹理进缓存，战斗中命中率从 72% 提升到 99%，淘汰几乎不触发。缓存策略是兜底，不是主力。
- **加载界面会污染 LRU**：开场加载界面顺序访问 500 张图，把战斗热点全挤掉了。解法是加载时标记 `pin`（不计入 LRU），加载完统一 unpin。
- **Map.keys() 在超大缓存上不便宜**：一个 5000 条的配置缓存用 Map 版 LRU，每帧 `keys().next()` 在低端机贡献了 0.3ms。换成手写双向链表（O(1) 取最旧节点）后降到可忽略。
- **监控淘汰率**：埋点统计 `hitRate` 和 `evictions/frame`，命中率长期 <90% 说明 capacity 太小或预热不够，别等内存爆了才查。

### 🔗 相关问题

1. 手写双向链表版 LRU 时，为什么用 dummy head/tail 哨兵节点？get/put 的边界条件怎么处理？
2. `WeakMap` 能用来做缓存吗？它和 LRU 的"主动淘汰"在语义上有什么本质区别？
3. 多线程（Web Worker）下共享缓存怎么加锁？无锁的读写拷贝（copy-on-read）为什么在游戏里更常见？
