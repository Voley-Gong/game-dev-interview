---
title: "Unity 物理系统中 Layer 和 LayerMask 的作用是什么？如何正确使用？"
category: "unity"
level: 2
tags: ["物理引擎", "Layer", "LayerMask", "碰撞检测", "Raycast"]
related: ["unity/physics-raycast", "unity/physics-joints-articulation"]
hint: "Layer 不只是分组工具，它是物理碰撞矩阵和射线检测过滤的核心机制。"
---

## 参考答案

### ✅ 核心要点

1. **Layer 是 32 位标记系统**：Unity 提供最多 32 个 Layer（0-31），前 8 个为内置保留
2. **LayerMask 是位掩码**：用位运算组合多个 Layer，用于 Raycast 过滤、物理碰撞矩阵控制
3. **碰撞矩阵配置**：Project Settings → Physics → Layer Collision Matrix 控制哪些 Layer 之间产生碰撞
4. **Raycast 中的 LayerMask**：精确控制射线击中哪些层，避免不必要的碰撞计算
5. **Camera.cullingMask**：Layer 也控制渲染剔除，不仅是物理系统

### 📖 深度展开

#### Layer 的本质

Unity 的 Layer 是一个 32 位的整数位标记：

```
Layer 0  → bit 0  → 0000 0000 0000 0000 0000 0000 0000 0001
Layer 1  → bit 1  → 0000 0000 0000 0000 0000 0000 0000 0010
Layer 5  → bit 5  → 0000 0000 0000 0000 0000 0000 0010 0000
Layer 31 → bit 31 → 1000 0000 0000 0000 0000 0000 0000 0000
```

`LayerMask` 就是一个 `int`（32 位整数），每一位代表一个 Layer 是否被包含。

#### LayerMask 的几种写法

```csharp
// ❌ 魔法数字，可读性差
LayerMask mask = 256; // 是哪个 Layer？完全看不出来

// ✅ 使用 LayerMask.NameToLayer（推荐命名常量）
int playerLayer = LayerMask.NameToLayer("Player");
int enemyLayer = LayerMask.NameToLayer("Enemy");
int groundLayer = LayerMask.NameToLayer("Ground");

// ✅ 通过 Inspector 序列化（最常用）
[SerializeField] private LayerMask hitMask; // Inspector 中可勾选

// ✅ 位运算组合
int mask = (1 << playerLayer) | (1 << enemyLayer); // Player | Enemy
// 或更简洁：
LayerMask combined = LayerMask.GetMask("Player", "Enemy");
```

#### Raycast 中使用 LayerMask

```csharp
public class WeaponController : MonoBehaviour
{
    [SerializeField] private LayerMask targetMask; // Inspector 配置

    void Fire()
    {
        Ray ray = Camera.main.ScreenPointToRay(Input.mousePosition);

        // 只检测 targetMask 包含的层
        if (Physics.Raycast(ray, out RaycastHit hit, 100f, targetMask))
        {
            var damageable = hit.collider.GetComponent<IDamageable>();
            damageable?.TakeDamage(10);
        }
    }
}

// 排除自身所在层的写法
int maskWithoutSelf = ~(1 << gameObject.layer);
if (Physics.Raycast(origin, direction, out hit, distance, maskWithoutSelf))
{
    // 射线不会击中自己
}
```

#### 碰撞矩阵（Layer Collision Matrix）

```
Project Settings → Physics → Layer Collision Matrix

         Player  Enemy  Ground  Bullet
Player     ✓      ✓      ✓       ✗
Enemy      ✓      ✓      ✓       ✓
Ground     ✓      ✓      —       ✗
Bullet     ✗      ✓      ✗       ✗
```

**规则**：取消勾选的两层之间不会产生任何碰撞事件（`OnCollisionEnter` 等），物理引擎会跳过这些碰撞对的计算。

#### 常见项目分层方案

| Layer ID | 名称 | 用途 |
|----------|------|------|
| 0 | Default | 默认层 |
| 1 | TransparentFX | 透明特效 |
| 2 | Ignore Raycast | 射线忽略 |
| 3 | Water | 水面 |
| 4 | UI | UGUI |
| 5 | Player | 玩家角色 |
| 6 | Enemy | 敌人 |
| 7 | Ground | 地面/地形 |
| 8 | Bullet | 子弹/投射物 |
| 9 | Trigger | 纯触发器（无物理反馈） |
| 10 | Obstacle | 障碍物（寻路遮挡） |
| 11 | Invisible | 不可见碰撞体（相机遮挡体） |

#### LayerMask 性能优势

```csharp
// ❌ 击中所有层后在代码中过滤 — 浪费物理计算
if (Physics.Raycast(ray, out hit, 100f))
{
    if (hit.collider.CompareTag("Enemy")) { /* ... */ }
}

// ✅ 引擎层直接过滤 — 只计算目标层
LayerMask enemyMask = LayerMask.GetMask("Enemy");
if (Physics.Raycast(ray, out hit, 100f, enemyMask))
{
    // hit 一定是 Enemy 层的对象
}
```

引擎在 Narrow Phase 之前就会用 LayerMask 剔除无关碰撞体，避免进入昂贵的 SAT/GJK 碰撞检测。

#### Camera.cullingMask 与物理 LayerMask 的区别

```csharp
// Layer 同时影响渲染和物理，但需要分开配置：

// 渲染：控制 Camera 显示哪些层
Camera.main.cullingMask = LayerMask.GetMask("Default", "Player", "Enemy");

// 物理：控制 Raycast 检测哪些层
LayerMask physicsMask = LayerMask.GetMask("Ground", "Obstacle");

// 典型用法：隐形单位
// — 渲染层设为 InvisibleWall（Camera cullingMask 排除它）
// — 物理层仍为 Default（碰撞正常工作）
```

### ⚡ 实战经验

- **Layer 数量有限**：只有 32 个，项目早期就要规划好分层方案，后期改 Layer 名/顺序成本极高（所有 Prefab 的 Layer 配置会错位）
- **`CompareTag` vs Layer**：`CompareTag` 用于单个标签判断，Layer 用于批量碰撞/射线过滤；不要用 Tag 替代 Layer 做物理过滤
- **`QueryTriggerInteraction`**：Raycast 默认使用 Physics.queriesHitBackfaces 和全局设置，需要精确控制触发器检测时传 `QueryTriggerInteraction.Collide` 或 `Ignore`
- **编辑器中 Layer 名称变更**：重命名 Layer 不会更新已有资产的 Layer 赋值（因为是按 ID 存储的），批量 Prefab 修改要特别留意

### 🔗 相关问题

- Physics.Raycast 的 `QueryTriggerInteraction` 参数有什么作用？
- 如何实现「子弹穿过队友但击中敌人」的碰撞逻辑？
- NavMesh 寻路中 Area Cost 和 Layer 有什么关系？
