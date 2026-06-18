---
title: "如何实现游戏资源缓存？LRU 与 LFU 淘汰策略该怎么选？"
category: "programming"
level: 2
tags: ["数据结构", "缓存", "LRU", "LFU", "性能优化", "资源管理", "哈希表"]
related: ["programming/memory-gc-optimization", "programming/slot-map-generational-index", "programming/priority-queue-binary-heap"]
hint: "缓存满了该踢谁？LRU 踢'最久没用'的，LFU 踢'用得最少'的——但游戏资源有自己的脾气：贴图用完就废、音效反复触发，淘汰策略选错会疯狂重复加载。"
---

## 参考答案

### ✅ 核心要点

1. **缓存的本质是用空间换时间 + 容量有限必须淘汰**。游戏里贴图、模型、音效、配置表加载昂贵（磁盘 IO + 解码），但内存有限不能全装下。缓存（Cache）把\"最近/最常访问\"的资源留在内存，容量超限时按淘汰策略（Eviction Policy）踢出\"最不值得留\"的。淘汰策略选对，命中率（Hit Rate）高、加载卡顿少；选错则反复\"加载→淘汰→再加载\"，造成缓存抖动（Cache Thrashing）。
2. **LRU（Least Recently Used）踢\"最久没用过的\"**。核心直觉：\"最近用过的，大概率马上还会用\"。实现需要一个哈希表（O(1) 查找）+ 双向链表（O(1) 移动到头部/删除尾部）：每次访问把节点移到链表头，满了就从链表尾删。LRU 对\"局部性好的访问模式\"（如连续渲染同一场景的资源）命中率极高，是通用资源缓存的默认选择。
3. **LFU（Least Frequently Used）踢\"累计访问次数最少的\"**。核心直觉：\"用得多的更可能再用\"。它统计每个资源的访问频次，淘汰频次最低的。LFU 的优势是\"扫描型访问不会冲掉热点\"——遍历一遍所有贴图不会把高频音效挤出去；劣势是\"老热点\"频次积累太高，即使很久没用了也不会被淘汰（频率污染），需要配合\"频次衰减\"（按时间折半）才好用。
4. **游戏资源的访问模式决定策略选择**。贴图/模型：场景内高频、切场景后不再用 → LRU 最合适（离开场景自然被淘汰）。UI 图集/常用音效：全程高频、稳定热点 → LFU 或干脆常驻不淘汰。配置表/脚本：加载一次永久使用 → 不需要淘汰策略，直接全量缓存。盲目套用单一 LRU 会让\"高频小资源\"和\"低频大资源\"互相挤兑。
5. **O(1) 实现的关键是\"哈希表 + 双向链表\"组合**。纯链表查找 O(n)（淘汰时找最旧的）、纯哈希表无法维护顺序。组合后：哈希表存 `key → 链表节点`，访问时 O(1) 拿到节点并移到头部，淘汰时 O(1) 删尾部节点。这是 LeetCode 经典题（LRU Cache），但游戏工程版还要处理：异步加载（缓存未命中时发起加载但不阻塞）、引用计数（资源被引用时不能淘汰）、弱引用回退。
6. **缓存不是越大越好，命中率 vs 内存占用要权衡**。缓存过大挤占渲染/逻辑内存导致 OOM 或 GC 频繁；过小命中率低反复加载。监控指标是\"命中率\"（Hit/Access）和\"淘汰速率\"（Evictions/sec）——命中率 <80% 且淘汰速率高说明容量不足或策略不对。手游典型贴图缓存 50-100MB，需按机型分档（低端机 30MB、高端机 150MB）。

### 📖 深度展开

#### 1. LRU 缓存的 O(1) 实现（哈希表 + 双向链表）

```typescript
// 双向链表节点：prev/next 指针 + 存储的 key/value
interface LRUNode<K, V> {
  key: K; value: V; prev: LRUNode<K, V> | null; next: LRUNode<K, V> | null;
}

class LRUCache<K, V> {
  private map = new Map<K, LRUNode<K, V>>();   // ★ 哈希表：key → 节点，O(1) 查找
  private head: LRUNode<K, V>;                  // 哨兵头（最近使用）
  private tail: LRUNode<K, V>;                  // 哨兵尾（最久未用）

  constructor(private capacity: number) {
    // 哨兵节点省去边界判空，简化链表操作
    this.head = { key: null as K, value: null as V, prev: null, next: this.tail };
    this.tail = { key: null as K, value: null as V, prev: this.head, next: null };
    this.head.next = this.tail;
  }

  get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;        // 未命中
    this.moveToHead(node);              // ★ 命中：移到头部表示\"最近用过\"
    return node.value;
  }

  put(key: K, value: V): void {
    const node = this.map.get(key);
    if (node) {                          // 已存在：更新值并移到头部
      node.value = value;
      this.moveToHead(node);
      return;
    }
    const newNode: LRUNode<K, V> = { key, value, prev: null, next: null };
    this.map.set(key, newNode);
    this.addToHead(newNode);
    if (this.map.size > this.capacity) {
      const removed = this.removeTail();   // ★ 超容量：淘汰尾部（最久未用）
      this.map.delete(removed.key);
    }
  }

  private moveToHead(n: LRUNode<K, V>) { this.removeNode(n); this.addToHead(n); }
  private addToHead(n: LRUNode<K, V>) {
    n.prev = this.head; n.next = this.head.next;
    this.head.next!.prev = n; this.head.next = n;
  }
  private removeNode(n: LRUNode<K, V>) {
    n.prev!.next = n.next; n.next!.prev = n.prev;
  }
  private removeTail(): LRUNode<K, V> {
    const node = this.tail.prev!;
    this.removeNode(node);
    return node;
  }
}
```

#### 2. LRU vs LFU vs FIFO vs ARC 淘汰策略对比

```
缓存访问序列（容量=3）演示淘汰差异：
  访问: A B C A D A B   （D 是新资源，触发淘汰）

LRU（踢最久没用）:           LFU（踢用得最少）:           FIFO（先进先出）:
  [A]                        [A:1]                       [A]
  [A,B]                      [A:1,B:1]                   [A,B]
  [A,B,C]                    [A:1,B:1,C:1]               [A,B,C]
  A命中→[B,C,A]              A命中→[B:1,C:1,A:2]         A命中(不变)
  D加入踢B(最久)→[C,A,D]     D加入踢B/C(频次1)→[A:2,D:1] D加入踢A→[B,C,D]
  A命中→[C,D,A]              A命中→[C:1,D:1,A:3]         A未命中!(已被踢)
  B未命中(刚被踢!)           B未命中                      B未命中

观察：LRU 把刚淘汰的 B 又要用了 → 抖动；LFU 保住了高频的 A。
但若 A 是\"很久前的老热点\"，LFU 会一直留着它不放（频率污染）。
```

| 策略 | 淘汰依据 | 实现复杂度 | 抗扫描冲刷 | 频率污染 | 游戏典型场景 |
|------|---------|-----------|-----------|----------|-------------|
| **LRU** | 最近访问时间 | 中（哈希+双向链表） | ❌ 差（扫描冲掉热点） | 无 | 贴图/模型缓存（默认首选） |
| **LFU** | 累计访问次数 | 高（需频次结构） | ✅ 好 | ❌ 有（需衰减） | UI/常用音效/配置热点 |
| **FIFO** | 进入顺序 | 低（队列） | ❌ 差 | 无 | 简单临时缓冲、不推荐做资源缓存 |
| **ARC** | LRU+LFU 自适应 | 很高 | ✅ | 较少 | 高端场景，工程复杂很少用 |
| **TTL** | 过期时间 | 低（定时器） | N/A | 无 | 时效数据（排行榜、活动） |

#### 3. 游戏资源缓存实战（异步加载 + 引用计数）

```typescript
// 游戏资源缓存：LRU 基础上叠加\"异步加载\"和\"引用计数\"两个工程必需
interface CachedAsset { data: unknown; refCount: number; loading?: Promise<unknown> }

class AssetCache {
  private lru = new LRUCache<string, CachedAsset>(256);   // 容量 256 个资源
  private loaders = new Map<string, (url: string) => Promise<unknown>>();

  register(type: string, loader: (url: string) => Promise<unknown>) {
    this.loaders.set(type, loader);
  }

  // 异步获取：未命中则发起加载（不阻塞调用方），命中则直接返回
  async load(url: string): Promise<unknown> {
    const cached = this.lru.get(url);
    if (cached) { cached.refCount++; return cached.data; }   // ★ 命中：引用计数 +1

    // 未命中：先占位防重复加载（多个请求同时要同一资源只加载一次）
    const loading = this.fireLoad(url);
    const asset: CachedAsset = { data: null, refCount: 1, loading };
    this.lru.put(url, asset);
    asset.data = await loading;
    return asset.data;
  }

  // 引用计数归零才允许被淘汰——正在被使用的资源绝不能踢
  release(url: string): void {
    const cached = this.lru.get(url);
    if (cached && --cached.refCount <= 0) {
      this.dispose(url, cached.data);    // ★ 真正释放底层资源（GPU 纹理、音频句柄）
      this.lru.put(url, { ...cached, refCount: 0 });
    }
  }

  private fireLoad(url: string): Promise<unknown> {
    const type = url.split('.').pop()!;
    const loader = this.loaders.get(type);
    if (!loader) throw new Error(`无加载器: ${type}`);
    return loader(url);
  }
  private dispose(url: string, data: unknown) { /* 释放 GPU 纹理/音频句柄 */ }
}
```

### ⚡ 实战经验

- **LRU 缓存被\"全量遍历\"冲垮是经典翻车**：背包 UI 一次性遍历加载 500 张物品图标，把缓存里的常用战斗特效贴图全冲掉了，关背包后打怪特效重新从磁盘加载卡顿 200ms。修复：背包图标用独立的 LFU 小缓存（抗扫描），战斗特效用 LRU 大缓存，按用途分仓而不是一个大池子。
- **淘汰正在被引用的资源导致黑屏/崩溃**：贴图 A 正被某个 Sprite 显示着，LRU 容量满了把它淘汰并释放了 GPU 纹理，Sprite 直接变黑块甚至访问已释放内存崩溃。必须叠加引用计数：refCount>0 的资源标记\"不可淘汰\"，或淘汰时只移出缓存但不释放底层资源直到引用归零。
- **缓存容量按机型分档避免低端机 OOM**：统一设 100MB 贴图缓存在 2GB 内存的低端安卓机上直接 OOM 崩溃。按 `device.memory` 或 `navigator.deviceMemory` 分档：低端 30MB、中端 80MB、高端 150MB，并加运行时监控——内存吃紧时主动缩容（缩到 50% 容量）而不是等系统杀进程。
- **异步加载防重复\"同时发起 N 次同一请求\"**：玩家快速连续点击同一按钮，每个点击都触发 `load(url)`，若未做\"占位\"会同时发起 N 个磁盘请求。必须用 Promise 占位：第一个请求发起后缓存 `loading: Promise`，后续请求直接 await 同一个 Promise，磁盘只读一次。
- **命中率监控驱动调参**：上线后发现贴图缓存命中率只有 45%，Profile 显示大量时间花在重复解码。根因是容量太小（只够装半个场景的资源）。容量翻倍后命中率到 92%，加载卡顿减少 70%。命中率应作为性能指标持续上报，低于阈值告警——缓存是\"隐式优化\"，不监控就不知道它在帮忙还是在添乱。

### 🔗 相关问题

1. LFU 的\"频率污染\"（老热点频次虚高永不淘汰）如何解决？频次衰减（decay）和对数计数器（Counter-Based LFU）各是什么思路？
2. 多级缓存（L1 内存 / L2 IndexedDB / L3 CDN）如何协同？每一级的淘汰策略和一致性如何保证？游戏离线包又该怎么缓存？
3. 分布式/多实例场景下（多台游戏服务器），本地缓存如何避免各自为政？是否需要分布式缓存（Redis）？游戏为什么极少这么做？
