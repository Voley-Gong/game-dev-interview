---
title: "Unity 中 Transform 层级与世界坐标变换是怎样的？localPosition 与 position 的区别和性能差异？"
category: "unity"
level: 2
tags: ["引擎架构", "Transform", "坐标系", "矩阵变换"]
related: ["unity/gameobject-component-model", "unity/monobehaviour-lifecycle"]
hint: "从局部坐标到世界坐标，Transform 是如何通过层级关系链式计算的？每次访问 position 属性背后发生了什么？"
---

## 参考答案

### ✅ 核心要点

1. **Transform 是树形结构**：每个 Transform 有且仅有一个 parent，形成层级链
2. **localPosition / localRotation / localScale** 是相对于父节点的变换
3. **position / rotation / lossyScale** 是世界空间变换，通过父级链递推计算
4. **访问 world 属性有计算开销**：每次读取 `transform.position` 可能触发整个父链矩阵重算
5. **SetParent 的两个参数**：`worldPositionStays` 决定是否保持世界坐标不变

### 📖 深度展开

#### 坐标空间与变换链

Unity 使用右手坐标系（Y 轴朝上），Transform 维护两个空间：

```
World Space                    Local Space
    ↑                               ↑
    |  position                     |  localPosition
    |  rotation (Quaternion)        |  localRotation
    |  lossyScale                   |  localScale
    |                               |
    +--→ World Matrix  ←--→  Local Matrix
         (TRS)                   (localTRS)
```

**世界矩阵的计算是一个自底向上的递归过程：**

```
WorldMatrix(this) = WorldMatrix(parent) × LocalMatrix(this)

等价展开：
WorldMatrix = ParentWorld × Translate(localPos) × Rotate(localRot) × Scale(localScale)
```

对于深层嵌套的对象：

```
Root (depth=0)
 └─ A (depth=1)
     └─ B (depth=2)
         └─ C (depth=3)
```

C 的世界矩阵 = Root.world × A.local × B.local × C.local

#### position 属性背后的机制

```csharp
// Unity 内部（简化伪代码）
public Vector3 position
{
    get
    {
        // 如果世界矩阵是 dirty 的，会重新计算
        // 遍历父链，逐级计算 LocalToWorldMatrix
        return cachedWorldMatrix.GetColumn(3); // 提取平移分量
    }
    set
    {
        // 设置 world position 需要逆推 localPosition
        // localPos = parentWorldMatrix.inverse * worldPos
        if (parent != null)
            localPosition = parent.localToWorldMatrix.inverse.MultiplyPoint(value);
        else
            localPosition = value;
    }
}
```

**性能关键点：** 当父级变换发生变化时，所有子级的世界矩阵会被标记为 dirty。在下一帧渲染或物理更新前，Unity 会重新计算这些矩阵。但在脚本中直接访问 `transform.position` 时，如果矩阵是 dirty 的，会立即触发重算（即所谓的 "hierarchy dirty" 检查）。

#### lossyScale 为什么叫 "lossy"

```csharp
// lossyScale 的计算
lossyScale = parentLossyScale ⊙ localScale  // 逐分量相乘

// 但如果层级中有旋转+缩放的组合，结果可能不准确
// 例如：父级旋转45° + 非均匀缩放 → 剪切变形（shear）
// 这时 lossyScale 无法准确表示，只能给出近似值
```

| 属性 | 读性能 | 写性能 | 注意事项 |
|------|--------|--------|----------|
| localPosition | O(1) 直接读 | O(1) 标记 dirty | 首选操作 |
| position | 可能触发父链遍历 | 需要逆矩阵计算 | 避免在热循环中频繁访问 |
| localRotation | O(1) | O(1) | Quaternion 操作 |
| rotation | 可能触发重算 | 需要逆变换 | 批量操作时考虑缓存 |
| lossyScale | 可能不准确 | 只读 | 有旋转+非均匀缩放时不可靠 |

#### SetParent 详解

```csharp
// worldPositionStays = true（默认）
// 保持世界坐标不变 → 重新计算 localPosition/localRotation
// 代价：一次逆矩阵计算

// worldPositionStays = false
// 直接使用原 local 值 → 对象会在新父级下"跳"到新位置
// 代价：无，但视觉效果会突变
transform.SetParent(newParent, true);  // 保持世界位置
transform.SetParent(newParent, false); // 保持局部位置
transform.SetParent(null, true);       // 脱离父级，变为根级

// 批量 reparent 时的性能建议
void ReparentBatch(List<Transform> children, Transform newParent)
{
    // 优化：先记录所有 worldPosition
    // 再统一 reparent（避免中间 reparent 影响后续计算）
    var worldPositions = new NativeArray<Vector3>(children.Count, Allocator.Temp);
    for (int i = 0; i < children.Count; i++)
        worldPositions[i] = children[i].position;

    for (int i = 0; i < children.Count; i++)
    {
        children[i].SetParent(newParent, false);
        children[i].position = worldPositions[i]; // 统一修正
    }
    worldPositions.Dispose();
}
```

#### 坐标空间转换 API

```csharp
// TransformPoint / InverseTransformPoint / TransformDirection
Vector3 worldPos = transform.TransformPoint(localPos);     // 点：受缩放影响
Vector3 localPos = transform.InverseTransformPoint(worldPos);
Vector3 worldDir = transform.TransformDirection(localDir); // 方向：不受缩放影响
Vector3 worldVec = transform.TransformVector(localVec);    // 向量：受缩放影响

// 实战：将世界坐标投射到局部空间做判断
bool IsInFront(Transform ref, Vector3 worldPoint)
{
    Vector3 localPoint = ref.InverseTransformPoint(worldPoint);
    return localPoint.z > 0; // 局部 Z+ 方向
}
```

### ⚡ 实战经验

1. **热循环中避免频繁访问 `transform.position`**：在 Update 中每帧访问几十个深层嵌套对象的 `position` 会触发大量的矩阵重算。应缓存到局部变量 `var pos = transform.position`，或使用 `localPosition` 代替。

2. **深层嵌套是性能杀手**：Unity 官方建议层级深度不超过 10 层。深层级不仅影响矩阵计算，还影响 culling 和 bounding box 更新。遇到过角色骨骼挂载在 15 层深的 UI 节点下导致帧率暴跌的案例。

3. **Rigidbody 与 Transform 的坑**：当 Rigidbody 使用 `interpolation` 时，不要在 `FixedUpdate` 中手动修改 `transform.position`，会导致插值抖动。应使用 `Rigidbody.MovePosition` 或 `AddForce` 系方法。

4. **SetParent 在协程中要注意时序**：`SetParent` 后如果立即访问 `position`，有时会取到旧值（因为 Unity 的变换系统在 `OnEndOfFrame` 才完全刷新）。如果需要精确值，使用 `Physics.SyncTransforms()` 或等待下一帧。

### 🔗 相关问题

- Unity 中 Rigidbody 的 interpolation 与 Transform 的更新顺序是怎样的？
- 如何高效地批量更新数千个对象的 Transform（DOTS / ECS 方案）？
- Unity 中四元数（Quaternion）旋转与欧拉角（Euler）的区别和选择标准？
