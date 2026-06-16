---
title: "布隆过滤器是什么？游戏中如何用它做资源预检和防重复加载？"
category: "programming"
level: 3
tags: ["概率数据结构", "布隆过滤器", "资源管理", "性能优化"]
related: ["programming/asset-management-async", "programming/hash-table-game", "programming/cache-eviction-game"]
hint: "不是哈希表——用位数组+多哈希牺牲确定性换取 1/100 的内存占用，'可能存在'和'绝对不存在'的区分是关键。"
---

## 参考答案

### ✅ 核心要点

1. **本质是"概率 membership 测试"**：布隆过滤器（Bloom Filter）用一个 m 位的位数组 + k 个独立哈希函数，回答"元素是否在集合中"。它的核心特性是**单向误差**：说"不存在"就一定不存在（no false negative），说"存在"可能误判（false positive，多个元素的哈希位重叠导致）。这个特性恰好匹配"防重复加载"——宁可重复加载一次（误判），也不能漏掉。
2. **空间效率碾压 HashSet**：存储 100 万个 URL 是否已加载，HashSet 需存完整字符串（平均 60 字节 × 100 万 ≈ 60MB），布隆过滤器在 1% 误判率下只需 ~1.2MB（每位表示存在性，约 9.6 位/元素）。空间节省 50 倍，这是它在大规模去重场景不可替代的原因。
3. **三个游戏中的杀手级场景**：①**资源去重加载**（图集/音频/配置表防重复下载，海外手游包体 2GB+ 必备）；②**玩家 ID 黑名单/白名单预检**（封禁库百万级，先用 BF 快速过滤 99%，未命中才查数据库）；③**邮件/交易/成就去重**（防刷漏洞：玩家重复领奖励时 O(1) 拦截）。共同点：集合大、查询频繁、误判可接受。
4. **标准布隆不能删除**：因为一个位可能被多个元素共享（哈希碰撞），清 0 会误伤其他元素。需要删除用 **Counting Bloom Filter**（每位用计数器替代 0/1，删除时计数减一），但内存翻 4-8 倍。游戏中资源加载场景几乎只增不删，标准版足够；玩家在线状态这种频繁增删的场景才需要 Counting 版。
5. **参数选择决定性能**：位数组长度 m 和哈希函数数 k 由"预期元素数 n"和"可接受误判率 p"决定：`m = -n·ln(p) / (ln2)²`，`k = (m/n)·ln2`。1% 误判率约需 9.6 位/元素、7 个哈希函数；降到 0.1% 需 14.4 位/元素。游戏项目通常按 1% 设计——误判一次多加载一份资源的成本远低于多花 50% 内存。
6. **哈希函数的选择**：不要用 k 个独立哈希（太慢），业界标准是用 2 个独立哈希 h1、h2 然后 `g_i(x) = (h1(x) + i·h2(x)) % m`（Kirsch-Mitzenmacher 论文），性能提升数倍。游戏客户端常用 `murmur3` 做基础哈希，再双哈希派生。

### 📖 深度展开

**1. 布隆过滤器核心实现（位操作 + 双哈希派生）**

```typescript
class BloomFilter {
  private bits: Uint8Array;   // 位数组（用字节数组模拟，每位表示一个 slot）
  private readonly bitCount: number;  // m：总位数
  private readonly hashCount: number; // k：哈希函数数
  private count = 0;

  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    // m = -n * ln(p) / (ln2)^2
    const ln2 = Math.LN2;
    this.bitCount = Math.ceil(
      -expectedItems * Math.log(falsePositiveRate) / (ln2 * ln2)
    );
    // k = (m/n) * ln2
    this.hashCount = Math.max(1, Math.ceil((this.bitCount / expectedItems) * ln2));
    this.bits = new Uint8Array(Math.ceil(this.bitCount / 8));
  }

  // 双哈希派生：用 murmur3 的两个独立结果生成 k 个哈希值
  private hashIndices(key: string): number[] {
    const h1 = this.murmur3(key, 0);
    const h2 = this.murmur3(key, 0x5bd1e995);
    const indices: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      // Kirsch-Mitzenmacher: g_i = (h1 + i*h2) % m
      indices.push(Math.abs((h1 + i * h2) % this.bitCount));
    }
    return indices;
  }

  add(key: string): void {
    for (const idx of this.hashIndices(key)) {
      this.bits[idx >> 3] |= (1 << (idx & 7));  // 置位
    }
    this.count++;
  }

  // 返回 false = 一定不存在；返回 true = 可能存在（有误判）
  mightContain(key: string): boolean {
    for (const idx of this.hashIndices(key)) {
      if ((this.bits[idx >> 3] & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }

  // 简化版 murmur3 32 位哈希（游戏客户端够用）
  private murmur3(key: string, seed: number): number {
    let h = seed;
    for (let i = 0; i < key.length; i++) {
      h = Math.imul(h ^ key.charCodeAt(i), 0x5bd1e995);
      h ^= h >>> 15;
    }
    return h >>> 0;
  }

  get estimatedCount() { return this.count; }
}
```

**2. 资源防重复加载：游戏客户端典型流程**

```
玩家进入新场景，需加载 500 个资源（纹理/音频/配置）：

                   资源请求 (assetId)
                          ↓
                ┌─────────────────────┐
                │ 1. 查内存缓存 LRU   │
                │    (Map<id, Asset>) │
                └─────────────────────┘
                    ↓ 命中           ↓ 未命中
                    返回缓存         ┌─────────────────────┐
                                     │ 2. 查布隆过滤器     │ ← O(1) 预检
                                     │    mightContain?   │
                                     └─────────────────────┘
                                       ↓ false(不存在)    ↓ true(可能存在)
                                       标记为待加载       查磁盘索引(IndexedDB)
                                       加入下载队列        ↓ 找到          ↓ 没找到
                                                          从本地读取       (布隆误判)
                                                          加入布隆         加入下载队列

关键收益：500 个资源中 380 个本地已有 → 布隆 100% 拦截，无需查磁盘索引
        剩余 120 个 → 布隆说"可能存在"，查磁盘发现 115 个真存在、5 个误判
        最终只下载 5 个真正缺失的资源，避免全量扫描磁盘索引（IO 重）
```

```typescript
// 资源管理器集成布隆过滤器：双层缓存预检
class AssetLoader {
  private memCache = new Map<string, Asset>();      // L1 内存
  private bloom = new BloomFilter(50000, 0.01);    // L2 布隆（磁盘预检）
  private diskIndex: DiskIndex;                    // L3 磁盘索引（重）

  async load(assetId: string): Promise<Asset> {
    // L1：内存命中直接返回
    const cached = this.memCache.get(assetId);
    if (cached) return cached;

    // L2：布隆预检，false 一定不在磁盘 → 直接下载
    if (!this.bloom.mightContain(assetId)) {
      return this.downloadAndCache(assetId);
    }
    // 布隆说"可能存在" → 查磁盘索引确认（少量误判会走到这里）
    const diskAsset = await this.diskIndex.get(assetId);
    if (diskAsset) return diskAsset;
    // 磁盘也没有（布隆误判）→ 下载
    return this.downloadAndCache(assetId);
  }

  private async downloadAndCache(assetId: string): Promise<Asset> {
    const asset = await fetchFromCDN(assetId);
    this.memCache.set(assetId, asset);
    this.bloom.add(assetId);            // 加入布隆，下次预检命中
    await this.diskIndex.set(assetId, asset);
    return asset;
  }
}
```

**3. 布隆过滤器 vs HashSet vs Counting Bloom：选型对比**

| 维度 | 标准 Bloom Filter | Counting Bloom Filter | HashSet<string> |
|------|------------------|----------------------|-----------------|
| **内存**（100万元素，1%误判） | ~1.2 MB | ~9.6 MB（4位计数器） | ~60 MB（存完整字符串） |
| **查询时间** | O(k)≈常数，~7次哈希 | O(k) 同左 | O(1) 平均，但有哈希冲突 |
| **支持删除** | ❌ 不支持 | ✅ 支持（计数减一） | ✅ 支持 |
| **误判** | 有 false positive | 有 false positive | 无（精确） |
| **漏判** | 无 false negative | 无 false negative | 无 |
| **游戏场景** | 资源去重、成就去重（只增不删） | 玩家在线状态、好友列表（频繁增删） | 小规模精确集合（< 1万元素） |
| **序列化** | 位数组直接 dump 到磁盘 | 计数器数组 dump | 需序列化所有字符串 |

```typescript
// Counting Bloom Filter：支持删除，用于玩家在线状态预检
class CountingBloomFilter {
  private counters: Uint8Array;  // 4 位计数器（最大 15，够用且省内存）
  private readonly slots: number;
  private readonly hashCount: number;

  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    const ln2 = Math.LN2;
    this.slots = Math.ceil(-expectedItems * Math.log(falsePositiveRate) / (ln2 * ln2));
    this.hashCount = Math.max(1, Math.ceil((this.slots / expectedItems) * ln2));
    this.counters = new Uint8Array(this.slots);  // 每个 slot 用 1 字节存 4 位计数（简化）
  }

  add(key: string): void {
    for (const idx of this.hashIndices(key)) {
      if (this.counters[idx] < 15) this.counters[idx]++;  // 防溢出
    }
  }

  remove(key: string): void {
    // ⚠️ 只有确认 key 确实存在时才能调用，否则会破坏其他元素
    for (const idx of this.hashIndices(key)) {
      if (this.counters[idx] > 0) this.counters[idx]--;
    }
  }

  mightContain(key: string): boolean {
    for (const idx of this.hashIndices(key)) {
      if (this.counters[idx] === 0) return false;
    }
    return true;
  }
  private hashIndices(key: string): number[] { /* 同标准版 */ return []; }
}
```

### ⚡ 实战经验

- **误判率别压太低**：项目初期把资源布隆的误判率设成 0.001%（追求"几乎不误判"），结果位数组膨胀到 28MB（200 万资源），手游包体 +28MB 触发应用商店警告。改成 1% 后内存降到 2.4MB，每周偶发 1-2 次误判（多下载一个已存在资源，玩家完全无感），ROI 极高。
- **布隆满了必须重建**：当实际元素数远超预期 n 时，误判率会指数级恶化。一次线上事故：预期 50 万资源的布隆被塞了 200 万（多版本资源未清理），实测误判率从 1% 飙到 60%，资源加载请求被错误路由到磁盘索引扫描，加载时间从 80ms 涨到 2.3s。监控误判率（采样查询统计），超过阈值就重建（双 buffer 切换，旧 buffer 继续服务查询）。
- **哈希函数别用 `String.hashCode`**：Java/JS 默认字符串哈希分布性差，布隆位聚集严重，实测 100 万元素时误判率比理论值高 3 倍。换成 `murmur3` 或 `xxHash` 后误判率回归理论值。性能差异不大（murmur3 32 位 ~3ns/哈希），但分布性是布隆正确性的生命线。
- **CDN 防盗链场景的妙用**：客户端用布隆存"已下载过的资源 ID 列表"，进入新场景时先把待加载列表发给服务器，服务器返回差集。1000 个请求资源的场景，布隆过滤掉 850 个本地已有，网络请求量降 85%，弱网下场景加载从 4.2s 降到 0.8s。这是海外手游（高延迟）的标配优化。
- **序列化恢复注意版本**：布隆位数组直接 `JSON.stringify` 写 IndexedDB，下次启动读回来继续用。踩过一次坑：版本升级后哈希算法从 `murmur3` 换成 `xxHash`，旧位数组和新哈希不匹配，所有查询都误判（说"存在"实际没有）。解决：序列化时存算法版本号，版本不符时丢弃重建（首次加载慢一次，可接受）。

### 🔗 相关问题

1. 布隆过滤器的误判率会随元素数增长而上升，如何在不停服的前提下动态扩容？（提示：Scale Bloom Filter / Dynamic Bloom Filter，多层数组叠加）
2. Cuckoo Filter（布谷鸟过滤器）相比布隆过滤器有什么优势？为什么它在支持删除的同时还能保持更低内存？游戏中的什么场景更适合用 Cuckoo？
3. 如果游戏需要"防重复领取奖励"且奖励池动态变化（新活动增加新奖励），布隆过滤器是否还合适？是否应该用 Counting Bloom 或直接退化为数据库唯一索引？
