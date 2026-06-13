---
title: "大地图/开放世界的资源加载策略怎么设计？"
category: "architecture"
level: 4
tags: ["大地图", "资源加载", "架构"]
hint: "不能一次性加载整个世界，也不能频繁卡顿——关键是流式加载。"
---

## 参考答案

### ✅ 核心要点

1. **分块加载（Chunk）**：将世界划分为网格，按需加载/卸载
2. **LOD（Level of Detail）**：远处用低精度模型
3. **流式加载（Streaming）**：后台线程加载，主线程无卡顿
4. **优先级队列**：玩家附近的优先加载
5. **预加载**：移动方向前方的 Chunk 提前加载

### 📖 深度展开

**分块系统设计：**

```
世界地图（4096 × 4096）
  划分为 16×16 块，每块 256×256

玩家位置 → 计算当前所在 Chunk
  加载：当前 Chunk + 周围 8 个 Chunk（3×3 区域）
  卸载：距离超过 2 Chunk 的块
  预加载：移动方向前方 1-2 Chunk

内存估算：
  单 Chunk ≈ 5-15 MB（地形 + 模型 + 纹理）
  9 Chunk 同时驻留 ≈ 45-135 MB
  可控且可调
```

**加载优先级：**

```typescript
enum LoadPriority {
  Critical = 0,   // 玩家脚下地面
  High = 1,       // 相邻 Chunk 地形
  Medium = 2,     // 建筑/植被
  Low = 3,        // 远处装饰
  Preload = 4,    // 预加载区域
}

class ChunkLoadQueue {
  private queue: PriorityQueue<ChunkRequest>;
  
  update(playerPos: Vector3) {
    // 1. 计算需要的 Chunk
    const needed = this.getNeededChunks(playerPos);
    // 2. 对比已加载的，决定加载/卸载
    const toLoad = needed.filter(c => !this.loaded.has(c));
    const toUnload = this.loaded.filter(c => !needed.includes(c));
    // 3. 按优先级入队
    toLoad.forEach(c => this.queue.enqueue(c, this.calcPriority(c, playerPos)));
    // 4. 每帧加载 N 个（分帧）
    const budget = this.perFrameBudget; // 如 2ms
    this.processQueue(budget);
    // 5. 异步卸载
    toUnload.forEach(c => this.unloadChunk(c));
  }
}
```

**LOD 策略：**

| 距离 | LOD 级别 | 模型面数 | 纹理尺寸 |
|------|----------|----------|----------|
| 0-50m | LOD0 | 原始 | 原始 |
| 50-150m | LOD1 | 50% | 1/2 |
| 150-300m | LOD2 | 25% | 1/4 |
| 300m+ | LOD3/Billboard | 极简 | 64px |

### ⚡ 实战经验

- **加载预算**：每帧最多花 2-4ms 在加载上，保持帧率稳定
- **深度缓冲降级**：远处用 Imposter（公告板）替代 3D 模型
- **MipMap**：远处纹理自动降级，减少显存和采样开销
- **高度图地形**：大地图用高度图 + SplatMap 比完整 Mesh 更高效
- **编辑器支持**：Chunk 划分和烘焙在编辑器中完成，运行时只负责加载

### 🔗 相关问题

- AssetBundle 加载策略？
- 如何设计资源管理器？
