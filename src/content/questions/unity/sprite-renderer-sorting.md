---
title: "Unity 2D 渲染中 SpriteRenderer 的排序机制是怎样的？Sorting Layer 和 Order in Layer 如何影响渲染顺序？"
category: "unity"
level: 2
tags: ["2D渲染", "SpriteRenderer", "Sorting Layer", "渲染排序", "DrawCall"]
related: ["unity/drawcall-batching", "unity/sprite-atlas-optimization"]
hint: "2D 游戏中多个精灵的渲染顺序由什么决定？透视关系如何用排序实现？"
---

## 参考答案

### ✅ 核心要点

1. **Sorting Layer** 是全局排序的"大组"，优先级高于一切 Transform 的 Z 值
2. **Order in Layer** 是同一 Sorting Layer 内部的精细排序（int 值越大越晚渲染=越靠前）
3. **同 Sorting Layer + 同 Order** 时，回退到 **Z 坐标 / Sorting Axis** 决定先后
4. **Camera 的 Transparency Sort Axis** 控制同一排序级别下的 fallback 规则（默认 0,0,1 即按 Z 排）
5. **Material / Shader 的 Render Queue** 只在不同材质之间生效，2D 中通常不作为主要排序手段

### 📖 深度展开

#### 排序优先级完整链路

Unity 2D 渲染排序的完整决策链如下（从高到低）：

```
1. Sorting Layer（全局优先级）
     ↓ 相同时
2. Order in Layer（组内优先级）
     ↓ 相同时
3. Camera.transparencySortMode（透视排序模式）
     ├── Orthographic → 按 Z 值（或自定义 Axis）
     ├── Perspective → 按到相机距离
     └── Custom Axis → 按指定轴向投影距离
     ↓ 相同时
4. Material Render Queue（Shader 队列）
     ↓ 相同时
5. 场景中的对象创建顺序 / Spawn 顺序（不稳定，不推荐依赖）
```

#### Sorting Layer 配置

Sorting Layer 在 **Project Settings → Tags and Layers → Sorting Layers** 中管理，是一个有序列表：

```
Sorting Layers（从上到下 = 先渲染到后渲染）:
┌─────────────────────┐
│ Background          │  ← 最先绘制（最远）
│ Terrain             │
│ Decorations         │
│ Characters          │
│ Effects             │
│ UI                  │  ← 最后绘制（最前）
└─────────────────────┘
```

#### SpriteRenderer 关键属性

| 属性 | 作用 | 性能影响 |
|------|------|----------|
| `sortingLayerName` | 所属 Sorting Layer | 切换 Layer 无额外开销 |
| `sortingOrder` | 组内排序值 | 修改会触发排序重算 |
| `sortingLayerID` | Layer 的唯一 ID（底层使用） | 比 name 查找更快 |
| `color` | 顶点颜色着色 | 无额外开销（顶点属性） |
| `flipX / flipY` | 翻转 | 无额外开销（UV 变换） |
| `sprite` | 引用的 Sprite 资源 | 切换 Sprite 可能触发新的 batch |

#### Camera Transparency Sort Mode

```csharp
// 正交相机默认按 Z 排序，2D "伪3D" 场景需要自定义轴
// 经典 45° 俯视角（如动物森友会风格）使用 Custom Axis:
Camera.main.transparencySortMode = TransparencySortMode.CustomAxis;
Camera.main.transparencySortAxis = new Vector3(0, 1, 0.1f);
// X=0, Y=1, Z=0.1 → 屏幕上方 + 远处 Z 的对象先渲染
// 效果：越靠下越靠前，远处与近处自然过渡
```

#### 与 DrawCall 合批的关系

```
关键规则：
├── 不同 Sorting Layer 的 Sprite → 不可能合批
├── 同 Sorting Layer 但不同 Material → 不合批
├── 同 Sorting Layer + 同 Material + 同 Texture(Sprite Atlas) → 可以合批
└── 合批内按排序顺序提交
```

**优化策略：**
- 把不需要精确排序的背景元素放到同一 Sorting Layer，用 Order 区分
- 使用 Sprite Atlas 把同 Layer 的精灵打到一张图集上 → 减少纹理切换 → 合批成功
- 避免在角色层混用不同 Material（如部分用 Default、部分用加描边 Shader）

#### 代码示例：运行时动态排序

```csharp
// Y 轴排序的经典 2D 模式（角色 Y 越大越靠前，模拟透视）
[RequireComponent(typeof(SpriteRenderer))]
public class YSortByPosition : MonoBehaviour
{
    private SpriteRenderer _renderer;
    private Transform _transform;
    
    void Awake()
    {
        _renderer = GetComponent<SpriteRenderer>();
        _transform = transform;
    }
    
    // 优化：不需要每帧更新，只在 Y 变化时更新
    private float _lastY;
    private const float THRESHOLD = 0.01f;
    
    void LateUpdate()
    {
        float y = _transform.position.y;
        if (Mathf.Abs(y - _lastY) > THRESHOLD)
        {
            // 负号：Y 越大（上方）应该先渲染，Y 越小（下方）后渲染（覆盖上方）
            _renderer.sortingOrder = Mathf.RoundToInt(-y * 100);
            _lastY = y;
        }
    }
}
```

#### 3D 物体与 2D Sprite 混排

在 3D + 2D 混合项目中，排序更容易出问题：

| 场景 | 问题 | 解决方案 |
|------|------|----------|
| 3D Mesh 与 Sprite 渲染顺序乱 | Sorting Layer 只对 Renderer 子类生效 | 给 3D Mesh 的 Material 设置 Render Queue < 2000（Background）使其在 Sprite 后面 |
| Particle System 被 Sprite 遮挡 | 粒子默认不参与 Sorting Layer | 设置 Particle System 的 Sorting Layer 或调整 Render Queue |
| 多相机叠加时排序错误 | 每个相机独立渲染各自的 Renderer | 使用 Camera Stack（URP）或 Depth 严格控制 |

### ⚡ 实战经验

- **"为什么我的角色被背景挡住了？"** → 99% 是 Sorting Layer 配置错误，检查 Tags and Layers 面板
- **动态 Y 轴排序性能问题** → 不要每帧对所有角色做 `sortingOrder` 更新，用阈值检测+批处理；角色多时考虑用 Job System 并行计算
- **Tilemap 与角色混排** → Tilemap Renderer 也有 Sorting Layer 和 Order，确保 Tilemap 的 Order 比角色小，或放到更靠前的 Sorting Layer
- **使用 Sprite Atlas 减少因排序导致的 DrawCall 增加** → 同一图集的 Sprite 即使 Order 不同，只要 Material 相同就能合批

### 🔗 相关问题

- Unity Draw Call Batching 的触发条件是什么？2D 场景如何最大化合批？
- Sprite Atlas 的打包策略和运行时加载机制是什么？
- URP 中 2D Renderer 与默认管线的排序有何不同？
