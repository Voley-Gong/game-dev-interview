---
title: "Unity 物理引擎中 Raycast 的原理是什么？如何正确使用和优化？"
category: "unity"
level: 2
tags: ["物理引擎", "Raycast", "碰撞检测", "PhysX"]
related: ["unity/monobehaviour-lifecycle"]
hint: "Raycast 不只是「射一条线」，背后涉及 BVH 加速结构和 Broadphase/Narrowphase 两阶段检测。"
---

## 参考答案

### ✅ 核心要点

1. **Raycast = 射线检测**：从一点沿方向发射射线，返回第一个（或所有）被击中的 Collider
2. **底层是 PhysX 引擎**：Unity 使用 NVIDIA PhysX，Raycast 依赖场景的 BVH（层次包围盒）加速结构
3. **两阶段检测**：Broadphase（AABB 粗筛）→ Narrowphase（精确几何计算交点）
4. **API 系列**：`Physics.Raycast`（单个）、`Physics.RaycastAll`（所有）、`Physics.SphereCast`（球体）、`Physics.BoxCast`（盒体）、`Physics.CapsuleCast`（胶囊体）
5. **性能与场景规模相关**：Collider 数量、Layer Mask 过滤、BVH 重建频率共同决定开销

### 📖 深度展开

#### 核心 API 详解

```csharp
// 1. 基础 Raycast — 返回是否击中 + RaycastHit 结构体
bool hit = Physics.Raycast(
    origin: transform.position,
    direction: transform.forward,
    hitInfo: out RaycastHit hit,
    maxDistance: 100f,
    layerMask: LayerMask.GetMask("Enemy", "Wall"),
    queryTriggerInteraction: QueryTriggerInteraction.Ignore
);

if (hit)
{
    Debug.Log($"击中: {hit.collider.name}");
    Debug.Log($"击中点: {hit.point}");
    Debug.Log($"法线: {hit.normal}");
    Debug.Log($"距离: {hit.distance}");
}

// 2. RaycastAll — 获取路径上所有被击中的物体（按距离排序）
RaycastHit[] hits = Physics.RaycastAll(
    transform.position, transform.forward, 100f,
    LayerMask.GetMask("Enemy")
);

// 3. SphereCast — 球体扫掠检测，常用于子弹/投射物
bool hit = Physics.SphereCast(
    transform.position, radius: 0.5f,
    direction: velocity.normalized,
    hitInfo: out RaycastHit sphereHit,
    maxDistance: velocity.magnitude * Time.fixedDeltaTime
);

// 4. OverlapSphere — 球形范围查询（不发射射线，直接查区域内所有 Collider）
Collider[] cols = Physics.OverlapSphere(
    explosionCenter, radius: 5f,
    LayerMask.GetMask("Destructible")
);
```

#### 检测流程图

```
Physics.Raycast(origin, dir, out hit, maxDist)
            │
            ▼
┌───────────────────────┐
│   Broadphase 粗筛      │  ← BVH 树遍历，O(log n)
│   用 AABB 与射线求交    │     快速排除不可能命中的 Collider
└───────────┬───────────┘
            │ 候选 Collider 集合
            ▼
┌───────────────────────┐
│  Narrowphase 精确计算   │  ← 三角形/凸包/球体精确几何求交
│  计算实际交点和法线      │     只对候选集做精确计算
└───────────┬───────────┘
            │ 最近的交点信息
            ▼
     RaycastHit {
        collider, point, normal,
        distance, rigidbody, transform
     }
```

#### Layer Mask — 最常被忽略的优化

```csharp
// ❌ 危险：不传 layerMask 会检测所有 Layer 的 Collider
Physics.Raycast(origin, dir, out hit, 100f);

// ✅ 正确：只检测需要的 Layer
int enemyLayer = LayerMask.GetMask("Enemy", "Destroyable");
Physics.Raycast(origin, dir, out hit, 100f, enemyLayer);

// LayerMask 位运算原理：
// Layer 0 = 1 << 0 = 1     (二进制: 0000 0001)
// Layer 3 = 1 << 3 = 8     (二进制: 0000 1000)
// 多层合并 = 位或运算
// "Enemy" | "Wall" = 1<<8 | 1<<9 = 768 (二进制: 0011 0000 0000)
```

#### Raycast vs OverlapSphere vs SphereCast 对比

| 方法 | 形状 | 是否检测路径 | 典型用途 | 性能 |
|------|------|-------------|---------|------|
| `Raycast` | 零宽射线 | 是 | 射线武器、点击拾取、视线判断 | 最快 |
| `RaycastAll` | 零宽射线 | 是（全部） | 穿透射击、多目标命中 | 中等 |
| `SphereCast` | 球体扫掠 | 是 | 子弹碰撞预检测、胶囊体移动 | 中等 |
| `OverlapSphere` | 球体区域 | 否（瞬时） | 爆炸伤害范围、AOE 检测 | 较快 |
| `BoxCast` | 盒体扫掠 | 是 | 门检测、区域通行判断 | 中等 |
| `OverlapBox` | 盒体区域 | 否 | 触发器区域、空间划分查询 | 较快 |

#### 性能优化策略

```csharp
// 策略1：缓存 RaycastHit 数组，避免每次 new（Unity 2022+）
private static readonly RaycastHit[] HitBuffer = new RaycastHit[32];

int count = Physics.RaycastNonAlloc(
    origin, direction, HitBuffer, maxDistance, layerMask
);
for (int i = 0; i < count; i++)
{
    ProcessHit(HitBuffer[i]);
}

// 策略2：避免在 Update 中每帧 Raycast，改为事件驱动
// ❌ 每帧射线检测
void Update()
{
    if (Physics.Raycast(...)) { }
}

// ✅ 仅在输入事件时检测
void OnFireButton()
{
    if (Physics.Raycast(cam.transform.position, cam.transform.forward, out hit, 100f))
    {
        DealDamage(hit.collider.GetComponent<IDamageable>());
    }
}

// 策略3：合理使用 QueryTriggerInteraction
// 默认使用全局设置，明确指定可减少不必要的 Trigger 检测
Physics.Raycast(
    origin, dir, out hit, dist, layerMask,
    QueryTriggerInteraction.Ignore  // 跳过所有 Trigger Collider
);
```

### ⚡ 实战经验

- **RaycastAll 的坑**：返回的数组不是按距离排序的（老版本），需要手动 `System.Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance))`，或者直接用 `RaycastNonAlloc` + 手动管理
- **SphereCast 起点在 Collider 内部不会检测到该 Collider**：这是 PhysX 的设计，子弹从枪口发射时枪口不能和自己的 Collider 重叠，否则跳过初始碰撞体导致穿模
- **MeshCollider 性能陷阱**：凸 MeshCollider 的 Raycast 开销远大于 Primitive Collider（Box/Sphere/Capsule），移动端尽量用组合 Primitive 近似替代
- **FixedUpdate 中做物理 Raycast**：当 Raycast 用于判断物理碰撞（如角色落地检测）时，应放在 `FixedUpdate` 中保持和物理引擎同步，否则可能出现抖动

### 🔗 相关问题

- Physics 与 Physics2D 有什么区别？为什么不能混用？
- 如何实现可见性检测（AI 视野判断）？Raycast + Layer Mask 有哪些注意事项？
- CharacterController 和 Rigidbody + Collider 在移动碰撞处理上有什么区别？
