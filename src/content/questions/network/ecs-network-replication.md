---
title: "ECS（Entity-Component-System）架构下的网络复制系统如何设计？"
category: "network"
level: 4
tags: ["ECS", "DOTS", "数据导向", "网络复制", "架构设计"]
related: ["network/property-replication-system", "network/snapshot-delta-sync", "network/protocol-layer-architecture"]
hint: "传统 OOP 里每个 Actor 调 OnRep_Property()，ECS 里没有对象，只有数据数组和 System 迭代——复制系统怎么知道哪些 Component 变了？怎么批量序列化？"
---

## 参考答案

### ✅ 核心要点

1. **Component 即复制单元**：每个 Component 类型对应一个 Replication Chunk，按 Archetype 批量管理
2. **Dirty 标记驱动**：System 写入 Component 时自动置 Dirty，复制系统只扫描 Dirty Chunk
3. **批量序列化**：同 Archetype 的同类型 Component 在内存中连续排列，可 SIMD 友好地批量打包
4. **Query 过滤 + 优先级**：用 Entity Query 过滤可见实体（AOI + 组件掩码），再按优先级排序压缩
5. **客户端 ECS 镜像**：客户端维护一份只读 ECS World，收到的快照直接 memcpy 到 Component 数组

### 📖 深度展开

#### 传统 OOP 复制 vs ECS 复制

| 维度 | 传统 Actor 复制 | ECS 复制 |
|------|----------------|----------|
| 复制单元 | Actor / UObject | Component（数据切片） |
| 序列化方式 | 逐对象遍历属性 | 按 Component 类型批量序列化 |
| 内存布局 | 指针跳转，缓存不友好 | Archetype Chunk 连续内存 |
| Dirty 检测 | 每个 Actor 维护 dirty set | Component 数据块级 dirty flag |
| 反序列化 | 逐 Actor 反射赋值 | memcpy 到对应 Chunk |
| 性能（10k 实体） | ~15ms | ~2ms |

#### Dirty 标记的实现

```csharp
// ECS Component 定义（Unity DOTS 风格）
public struct NetworkTransform : IComponentData
{
    public float3 Position;
    public quaternion Rotation;
}

// System 写入时标记 dirty
[WriteGroup(typeof(NetworkTransform))]
public struct NetworkTransformDirty : IComponentData, IComponentDataCleanup {} 

public partial class MovementSystem : SystemBase
{
    protected override void OnUpdate()
    {
        Entities
            .WithAll<NetworkTransform>()
            .ForEach((ref NetworkTransform transform, 
                       ref NetworkTransformDirty dirty,
                       in Velocity velocity) =>
            {
                transform.Position += velocity.Value * SystemAPI.Time.DeltaTime;
                // 写入数据时自动标记 dirty
                dirty = new NetworkTransformDirty();
            }).ScheduleParallel();
    }
}
```

#### 复制管线架构

```
服务器 Tick N
    │
    ├── 1. System Update（各业务 System 写 Component 数据）
    │
    ├── 2. Replication System 扫描 Dirty
    │       ├── EntityQuery: Has<NetworkTransform, NetworkTransformDirty>()
    │       ├── 按 Archetype Chunk 分组
    │       └── 每个 Chunk 连续内存遍历
    │
    ├── 3. AOI 过滤（Interest Management）
    │       └── 只复制玩家视野内的实体
    │
    ├── 4. 优先级排序
    │       ├── 距离权重：近的优先
    │       ├── 类型权重：玩家 > NPC > 场景物件
    │       └── 历史频率：长期不变的降级
    │
    ├── 5. Delta 压缩序列化
    │       ├── Baseline（上一帧快照）
    │       ├── 变化的字段才写入 bitstream
    │       └── 同 Archetype 连续实体打包
    │
    └── 6. 发送（按连接分发）

客户端收到快照
    ├── 反序列化 → 直接写入对应 Archetype Chunk
    ├── 清除服务器传来的 dirty 标记
    └── 触发插值 System（Entity Interpolation）
```

#### Unity DOTS Netcode 的实践

Unity 官方 Netcode for Entities 采用 GhostSerializer / GhostDeserializer：

```csharp
// Ghost Component 定义
[GhostComponent]
public struct GhostPlayer : IComponentData
{
    [GhostField(Quantization = 100, Interpolate = true)]
    public float3 Position;

    [GhostField(Quantization = 100, Interpolate = true)] 
    public quaternion Rotation;

    [GhostField] // 默认不插值
    public int Health;
}
```

- `[GhostField]` 标记需要复制的字段
- `Quantization` 指定定点量化精度
- `Interpolate` 指定是否插值
- 自动生成序列化代码（SourceGen），零运行时反射

#### 内存级 Delta 计算

```cpp
// 伪代码：同 Archetype Chunk 级别的 Delta
struct ArchetypeChunk {
    Archetype archetype;      // 组件类型组合
    void* componentData[];    // 各组件数组的起始指针
    int count;                // Chunk 内实体数量
    uint64_t chunkVersion;    // 整个 Chunk 的版本号
};

// 快速判断 Chunk 是否有变化
bool hasChanges = chunk.chunkVersion > lastSentVersion[chunkIndex];

// 有变化时按字段级比较
for (int fieldIdx : replicatedFields) {
    if (memcmp(chunk.componentData[fieldIdx], 
               baseline.chunk.componentData[fieldIdx], 
               chunk.count * fieldSize) != 0) 
    {
        emitFieldDelta(chunk, fieldIdx, baseline);
    }
}
```

### ⚡ 实战经验

1. **不要用反射做 ECS 复制**：SourceGen / 代码生成是唯一可接受方案，反射的 GC 和间接调用会吃掉 ECS 的性能红利
2. **Chunk 级 Dirty 比 Entity 级 Dirty 快 10 倍**：一个 Chunk 最多 128 个实体，整体扫描比逐个标记省 cache miss
3. **客户端 ECS World 应只读**：客户端不跑权威模拟逻辑，只做插值和渲染，收到快照直接覆盖。不要让客户端 ECS 与服务器产生分歧判断
4. **Archetype 变化是性能陷阱**：Entity 加减 Component 会导致 Archetype 迁移（整块拷贝），战斗中频繁加减 Tag Component 会制造大量碎片。建议用 Tag 而非 Enableable，或用状态位替代增删

### 🔗 相关问题

- ECS 的 Component 数据布局对 SIMD 友好的序列化有什么优势？
- 如何实现 ECS 架构下的 Client-Side Prediction？
- Unity Netcode for Entities 与 Unreal Replication 在数据流上的根本差异？
