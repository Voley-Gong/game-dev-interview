---
title: "Unity 遮挡裁剪（Occlusion Culling）和可见性裁剪的原理是什么？如何正确烘焙和使用？"
category: "unity"
level: 2
tags: ["渲染优化", "裁剪", "性能优化"]
related: ["unity/lod-object-pool", "unity/drawcall-batching"]
hint: "Frustum Culling、Occlusion Culling、Back-face Culling 有什么区别？为什么烘焙了 Occlusion 还是看不到效果？"
---

## 参考答案

### ✅ 核心要点

1. **三层裁剪体系**：Frustum Culling（视锥裁剪）→ Occlusion Culling（遮挡裁剪）→ Back-face Culling（背面裁剪），从粗到细逐层剔除不可见物体
2. **Frustum Culling** 是自动的运行时裁剪，基于包围盒（Bounds）与摄像机视锥体的相交测试
3. **Occlusion Culling** 需要离线烘焙 Occlusion Data，运行时利用 PVS（Potentially Visible Set）快速判断被遮挡区域
4. **烘焙质量取决于场景结构**：静态标记（Static → Occluder/Occludee）、Cell Size、Smallest Occluder 等参数影响精度和包体
5. **误用会导致"突然消失"或"穿模才出现"**，核心排查方向是 Bounds 不准、烘焙参数不当、动态物体未正确处理

### 📖 深度展开

#### 三种裁剪的执行阶段

```
场景中所有 Renderer
  │
  ▼
┌─────────────────────┐
│  Frustum Culling    │  ← 运行时自动，包围盒 vs 视锥体
│  (CPU, 自动)         │
└─────────┬───────────┘
          │ 通过的物体
          ▼
┌─────────────────────┐
│  Occlusion Culling  │  ← 运行时查询烘焙数据
│  (CPU, 需烘焙)       │
└─────────┬───────────┘
          │ 未被遮挡的物体
          ▼
┌─────────────────────┐
│  提交渲染 → GPU       │
│  Back-face Culling   │  ← GPU 硬件层，丢弃背面三角面
│  Shadow Culling      │  ← 阴影渲染的额外裁剪
└─────────────────────┘
```

#### Occlusion Culling 烘焙原理

Unity 使用 **Umbra** 中间件进行遮挡裁剪烘焙。核心流程：

1. 将场景划分为 **Cells（格子）**
2. 每个 Cell 记录从该位置可能看到的其他 Cells 集合 → **PVS（Potentially Visible Set）**
3. 运行时根据摄像机所在 Cell，查表获取可见集合，跳过 PVS 之外的 Renderer

| 烘焙参数 | 作用 | 推荐值 |
|----------|------|--------|
| Smallest Occluder | 能作为遮挡物的最小尺寸 | 根据场景调，室内 5m，室外 10-25m |
| Smallest Hole | 能透过视线的小洞尺寸 | 0.25m（默认），过大会漏裁 |
| Backface Threshold | 背面三角形阈值 | 100（默认） |
| Cell Size | 空间划分格子大小 | 默认自动，手动调可增精度 |

#### 运行时使用

**内置管线：**
- Window → Rendering → Occlusion Culling → Bake
- 摄像机需勾选 `Occlusion Culling`（默认开启）

**URP：**
- URP 自动支持 Occlusion Culling，在 Universal Additional Camera Data 中确认

**代码查询（运行时可见性判断）：**

```csharp
using UnityEngine;

public class VisibilityChecker : MonoBehaviour
{
    public Camera mainCamera;
    public Renderer target;

    void Update()
    {
        // GeometryUtility.CalculateFrustumPlanes 获取视锥平面
        var planes = GeometryUtility.CalculateFrustumPlanes(mainCamera);
        Bounds bounds = target.bounds;

        // 方式1：视锥裁剪判断（不含遮挡）
        bool inFrustum = GeometryUtility.TestPlanesAABB(planes, bounds);

        // 方式2：Occlusion Culling 由引擎自动处理
        // 如果物体被 Occlusion 剔除，OnBecameInvisible/OnBecameVisible 会被调用
        // 也可以用 Renderer.isVisible 判断
        bool isVisible = target.isVisible;

        if (inFrustum && !isVisible)
        {
            Debug.Log($"{target.name} 在视锥内但被遮挡裁剪");
        }
    }

    // 更精确的可见性回调
    void OnBecameVisible() => Debug.Log("进入视野");
    void OnBecameInvisible() => Debug.Log("离开视野");
}
```

#### 静态标记详解

```
Occluder Static   → 该物体会被作为遮挡体参与烘焙（墙壁、建筑）
Occludee Static   → 该物体可被遮挡（小物体、道具）
```

- 大型建筑：同时勾选 Occluder + Occludee
- 小型道具：只勾 Occludee
- 透明物体（玻璃）：**不要**勾 Occluder（透明物不应遮挡）

#### 与 LOD、Draw Call 的协同

```
渲染优化决策树：
1. 物体是否在视锥内？        → Frustum Culling
2. 物体是否被遮挡？          → Occlusion Culling
3. 物体选择哪个 LOD 级别？   → LOD Group
4. 同批物体能否合并 DrawCall？→ Static/Dynamic Batching, SRP Batcher
```

### ⚡ 实战经验

1. **"物体突然消失"是 Bounds 不准的典型症状**：Mesh Renderer 的 Bounds 是本地空间 AABB，如果粒子系统或动态变形导致实际几何体超出 Bounds，裁剪会误判。用 `renderer.bounds`（世界空间） vs `mesh.bounds`（本地空间）排查
2. **室内场景烘焙效果显著，开放世界几乎无效**：Occlusion Culling 的收益取决于场景是否有大量遮挡物。开放世界优先用 LOD + HLOD + Streaming
3. **烘焙后必须测试多角度**：在游戏实际摄像机路径上验证裁剪效果。用 Scene View 的 Occlusion Culling 预览模式，红色 = 被裁剪，白色 = 可见
4. **动态物体不会被烘焙为遮挡体，但可作为被遮挡物**：如果动态物体频繁闪现/消失，检查是否误标了 Static Occluder

### 🔗 相关问题

- Unity 中 LOD Group 的工作原理是什么？LOD 0/1/2 的切换依据是什么？
- 开放世界场景的渲染优化策略有哪些？HLOD 和 Streaming 方案如何选择？
- 如何用 Unity Profiler 和 Frame Debugger 分析裁剪是否生效？
