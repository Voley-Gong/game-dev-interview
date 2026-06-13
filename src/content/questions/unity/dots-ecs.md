---
title: "Unity DOTS/ECS 架构的核心思想是什么？"
category: "unity"
level: 4
tags: ["ECS", "DOTS", "架构", "性能"]
hint: "数据导向设计如何解决传统 OOP 在游戏中的性能瓶颈？"
---

## 参考答案

### ✅ 核心要点

1. **Entity**：纯 ID，不包含数据和行为
2. **Component**：纯数据（struct），按内存布局连续存储
3. **System**：纯逻辑，批量处理匹配的 Component
4. **数据局部性**：连续内存 → CPU 缓存友好 → 性能飞跃

### 📖 深度展开

**传统 OOP vs ECS：**

```
// OOP: 对象是数据+行为的封装
class Enemy : MonoBehaviour {
    float hp;        // 散落在堆中各处
    Vector3 pos;     // 缓存不友好
    void Update() {  // 虚函数调用开销
        // 处理逻辑
    }
}
// 遍历 10000 个 Enemy → 10000 次缓存 miss

// ECS: 数据和逻辑分离
struct Health : IComponentData { float Value; }
struct Position : IComponentData { float3 Value; }

class MovementSystem : SystemBase {
    protected override void OnUpdate() {
        // 批量处理，数据连续存储
        // SIMD 友好，Burst 编译器优化
        Entities
            .ForEach((ref Position pos, in Velocity vel) => {
                pos.Value += vel.Value * deltaTime;
            }).ScheduleParallel();
    }
}
// 遍历 10000 个 Entity → 缓存连续，几乎 0 miss
```

**DOTS 三件套：**

| 技术 | 作用 |
|------|------|
| **ECS** | 架构模式，数据与逻辑分离 |
| **Burst Compiler** | 基于 LLVM 的高性能编译器，SIMD 优化 |
| **C# Job System** | 多线程并行，安全的任务调度 |

**性能提升原理：**

1. **内存连续**：相同 Component 存储在连续内存块（Archetype）
2. **CPU 缓存**：L1/L2 缓存命中率从 ~10% 提升到 ~90%
3. **无 GC**：全部使用 struct，栈分配
4. **SIMD**：Burst 自动向量化
5. **多线程**：Job System 自动并行

### ⚡ 实战经验

- **适用场景**：大量同质实体（子弹、粒子、小兵）效果最佳
- **不适用**：复杂的单个对象（如玩家角色）传统 OOP 更合适
- **学习曲线陡峭**：思维模式完全不同，团队需要时间适应
- **混合使用**：GameObject + ECS 混合方案（Entities.ForEach 支持互操作）
- **生产就绪**：Unity ECS 1.0 已发布，可生产使用但生态还在成长中
