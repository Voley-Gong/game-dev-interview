---
title: "ECS 架构的 Archetype、Chunk 与查询机制是怎样的？Unity DOTS/ECS 如何落地？"
category: "architecture"
level: 4
tags: ["ECS", "DOD", "Archetype", "Unity DOTS", "性能优化", "架构设计"]
related: ["architecture/component-based-architecture", "architecture/data-oriented-design", "architecture/multithreading-job-system-architecture"]
hint: "ECS 不是'把组件挂到实体上'那么简单——Archetype 分桶、Chunk 连续内存、Query 批量遍历才是它比传统组件化快几十倍的根本原因。"
---

## 参考答案

### ✅ 核心要点

1. **ECS 三要素 = Entity（ID）+ Component（纯数据）+ System（纯逻辑）**：数据与逻辑彻底分离，Component 不含任何方法只有字段，System 批量处理"拥有特定组件组合"的所有实体。
2. **Archetype 是核心数据结构**：拥有**相同组件集合**的实体被归入同一个 Archetype。比如 `{Position, Velocity}` 是一个 Archetype，`{Position, Velocity, Health}` 是另一个——组件组合不同就是不同 Archetype。
3. **Chunk 是连续内存块**：每个 Archetype 由若干个固定大小（通常 16KB）的 Chunk 组成，组件数据在 Chunk 内**按类型连续排布**（SoA 结构）。遍历时缓存命中率极高，这是 ECS 性能的物理根源。
4. **Query 按组件签名过滤**：System 通过 `EntityQuery` 声明"我要处理同时拥有 A、B 组件的实体"，框架找到匹配的 Chunk 后批量迭代，避免逐实体 `GetComponent` 的指针跳跃。
5. **Unity DOTS = ECS + Burst + Job System**：三者配合才能跑满性能——ECS 提供数据布局，Burst 做编译期 SIMD 优化，Job System 把遍历分摊到多核，缺一不可。

### 📖 深度展开

**传统 OOP 组件化 vs ECS 的内存布局：**

```
❌ OOP 组件化（每个对象是一坨，指针满天飞）：
  GameObject[0] → {Pos, Vel, Hp, AI...}  ┐
  GameObject[1] → {Pos, Vel, Hp, AI...}  ├ 每个对象散布在堆上
  GameObject[2] → {Pos, Vel, Hp, AI...}  ┘ 遍历 Velocity 时 cache miss 频繁

✅ ECS（同类数据连续排布，SoA）：
  Archetype = {Position, Velocity}
   └─ Chunk0 [Pos×N | Vel×N]   ← Position 数组紧挨着，连续 16KB
   └─ Chunk1 [Pos×N | Vel×N]
  System 只迭代 Velocity 列 → CPU 预取生效，SIMD 友好
```

**Unity DOTS/ECS 关键 API：**

```csharp
using Unity.Entities;
using Unity.Mathematics;
using Unity.Burst;

// 1. Component —— 纯数据 struct（必须是值类型，引用类型不能放 Chunk）
public struct Position : IComponentData { public float3 Value; }
public struct Velocity : IComponentData { public float3 Value; }

// 2. System —— 逻辑，IComponentSystemBase 派生
[BurstCompile]                      // 编译期生成 SIMD 优化代码
public partial struct MoveSystem : ISystem {
    private EntityQuery _query;     // 查询：所有同时拥有 Position+Velocity 的实体

    public void OnCreate(ref SystemState state) {
        // 要求必须有 Position、Velocity，且排除 Disabled 标记
        _query = SystemAPI.QueryBuilder()
            .WithAll<Position, Velocity>()
            .Build();
    }

    public void OnUpdate(ref SystemState state) {
        float dt = SystemAPI.Time.DeltaTime;
        // 直接拿到 Chunk 内数组，无 GC、无虚调用
        foreach (var (pos, vel) in _query.ToComponentDataArray<Position, Velocity>()) {
            // 注意：这是简化写法，实际用 IJobChunk 或 Aspects 批处理
        }

        // ✅ 推荐写法：Job 化并行
        state.Dependency = new MoveJob { Dt = dt }.ScheduleParallel(_query, state.Dependency);
    }
}

// 3. Job —— 并行遍历 Chunk
[BurstCompile]
partial struct MoveJob : IJobEntity {
    public float Dt;
    public void Execute(ref Position pos, in Velocity vel) {  // in=只读 ref=读写
        pos.Value += vel.Value * Dt;
    }
}

// 4. EntityCommandBuffer —— 解决"遍历时不能增删实体"的结构性变更问题
//    把"删除"命令录下来，帧末回放，避免遍历中改 Archetype 导致数组失效
```

**Archetype 变更的代价（结构性变更）：**

```
实体加/减组件 = 切换 Archetype
  原 Chunk {Pos, Vel}  →  把数据拷到新 Archetype 的 Chunk {Pos, Vel, Hp}
                          ↑ 版本号变化、引用失效、需同步点

教训：战斗中频繁 AddComponent 会导致 Archetype 反复迁移
      正确做法：预声明所有可能组件，用 enabled 标志位开关，而非增删组件
```

**ECS vs 传统组件化 vs 面向对象对比：**

| 维度 | 面向对象（深继承） | 组件化（OOP） | ECS（DOD） |
|------|--------------------|---------------|------------|
| 数据布局 | 散布堆上 | 对象内聚合 | Chunk 连续 SoA |
| 缓存命中率 | 差 | 差 | ✅ 极好 |
| 逻辑执行 | 每对象虚调用 | `GetComponent` 跳转 | 批量线性遍历 |
| 多核扩展 | 难（共享状态） | 难 | ✅ 天然 Job 并行 |
| 适用规模 | <1000 实体 | <10k 实体 | ✅ 10万+ 实体 |
| 学习成本 | 低 | 中 | 高（思维反转） |

### ⚡ 实战经验

- **别在热路径里 `EntityManager.AddComponent`**：每次结构性变更都触发 Archetype 迁移和版本号 bump，高频调用会让 ECS 的性能优势荡然无存。用 `IEnableableComponent` 的 `SetComponentEnabled` 开关组件，零成本启停。
- **Component 必须是值类型（struct）**：放 class 进 Chunk 会变成指针，缓存友好性瞬间归零。需要引用共享资源时用 `ISharedComponentData`（按值分桶）或在 System 里持有托管引用，别塞进实体数据。
- **EntityCommandBuffer 要在正确的同步点回放**：`BeginSimulationEntityCommandBufferSystem` 还是 `EndSimulationEntityCommandBufferSystem` 选错，会出现"这一帧加的血量下一帧才生效"的时序 bug。逻辑上需要立即生效的同步变更用 `EntityManager` 直接调（在非遍历上下文）。
- **DOTS 三件套要一起上**：只写 ECS 不开 Burst、不 Job 化，性能可能还不如传统写法——因为 ECS 引入了额外的间接寻址开销，必须靠 Burst+Job 把遍历成本摊薄才能反超。先用 Profiler 验证瓶颈确实是 CPU 后再迁移。

### 🔗 相关问题

1. Archetype-based ECS 和 Sparse-set ECS（如 Entitas、Flecs）在增删组件时性能差异是怎样的？
2. ECS 中如何表达"一对多"的关系（如英雄身上的 Buff 列表）？为什么用 `DynamicBuffer<T>` 而非 List？
3. 把一个传统 Unity 项目（大量 MonoBehaviour）渐进式迁移到 DOTS，有哪些实务策略和坑？
