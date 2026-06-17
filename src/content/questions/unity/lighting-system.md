---
title: "Unity 光照系统：Lightmap、Realtime、Mixed 三种光照模式的区别与优化策略是什么？"
category: "unity"
level: 2
tags: ["光照", "Lightmap", "渲染", "性能优化"]
related: ["unity/urp-render-pipeline", "unity/shader-material-system"]
hint: "从光照模式分类、烘焙原理、Light Probes、实时GI四个层面理解 Unity 光照体系。"
---

## 参考答案

### ✅ 核心要点

1. **三种光照模式**：Realtime（实时光）、Baked（烘焙光）、Mixed（混合光），各有性能与视觉权衡
2. **Lightmap 烘焙**：将静态光照预计算到纹理中，运行时零计算开销，但只适用于静态物体
3. **Light Probes**：为动态物体提供烘焙光照的近似值，填补了静态 Lightmap 与动态物体之间的鸿沟
4. **Mixed Lighting 的 Subtractive/Baked Indirect/Shadowmask** 三种模式在质量和灵活性间权衡
5. **Progressive Lightmapper** 是当前主流烘焙器，基于 CPU/GPU 路径追踪，比旧版 Enlighten 快数倍

### 📖 深度展开

#### 三种光照模式对比

| 维度 | Realtime（实时） | Baked（烘焙） | Mixed（混合） |
|------|-----------------|--------------|--------------|
| 运行时开销 | 高（逐像素计算） | 极低（采样纹理） | 中等 |
| 动态物体支持 | ✅ 完美 | ❌ 不可用 | ✅ 部分（Light Probes） |
| 阴影质量 | 中等 | 最高（预计算） | 高 |
| 光照变化 | ✅ 实时更新 | ❌ 固定不变 | ⚠️ 受限 |
| 适用场景 | 角色、动态物体 | 静态环境 | 大部分游戏场景 |

#### Lightmap 烘焙流程

```
场景准备
  ├── 标记物体为 Static（Lightmap Static）
  ├── 配置光源（方向光、点光、面光）
  ├── 设置 Lighting Settings
  │    ├── Lightmapper: Progressive
  │    ├── Direct Samples: 32
  │    ├── Indirect Samples: 512
  │    ├── Bounces: 2~3
  │    └── Lightmap Resolution: 10~40 texels/unit
  └── 点击 Generate Lighting
       ↓
  Progressive Lightmapper
  ├── CPU 渱染路径追踪 → 逐像素收敛
  ├── GPU Lightmapper（可选，更快）
  └── 输出:
       ├── LightmapColor（直接+间接光颜色）
       ├── LightmapDir（方向光信息，用于法线计算）
       └── ShadowMask（阴影遮罩，Mixed 模式用）
```

#### Light Probes 详解

Light Probes 是空间中的采样点，记录烘焙光照的球谐函数（Spherical Harmonics）系数，动态物体通过插值获取近似光照：

```
Light Probe Group 布局示例（俯视图）：

  ●─────●─────●─────●
  │     │     │     │
  ●─────●─────●─────●     ← 网格状分布
  │   [Player]   │     │       动态角色在此移动
  ●─────●─────●─────●       → 插值最近的 4 个 Probe
  │     │     │     │
  ●─────●─────●─────●

  ● = Light Probe（球谐光照采样点）
```

**球谐函数（SH）存储：**

```csharp
// Unity 内部使用 3 阶球谐函数存储光照信息
// L2 SH 需要 9 个系数 × 3(RGB) = 27 个 float
// 运行时根据物体位置在 Probe 间做三线性插值

// 在 Shader 中获取 SH 光照：
// ShadeSH9(half4(normal, 1)) → 返回环境光颜色
```

#### Mixed Lighting 三种模式

| 模式 | 直接光 | 间接光 | 阴影 | 适用场景 |
|------|--------|--------|------|---------|
| **Baked Indirect** | 实时 | 烘焙 | 实时（仅实时光阴影） | 最高质量，性能中等 |
| **Subtractive** | 烘焙 | 烘焙 | 实时光照静态物阴影 | 移动端，性能优先 |
| **Shadowmask** | 实时 | 烘焙 | 烘焙阴影+实时阴影混合 | 主机/PC，质量与性能兼顾 |

**Shadowmask 模式（推荐）工作原理：**

```
静态物体阴影:
  ┌─────────────┐
  │ ShadowMask  │  ← 烘焙的阴影遮罩纹理
  │ (RGBA)      │     R: 方向光阴影, G: 点光阴影...
  └──────┬──────┘
         ↓
  Pixel Shader:
  最终阴影 = min(实时阴影, ShadowMask采样)
  → 远处用烘焙阴影（省性能），近处用实时阴影（保质量）

动态物体阴影:
  → 始终使用实时阴影（无法烘焙）
```

#### 代码示例：运行时控制光照

```csharp
using UnityEngine;
using UnityEngine.Rendering;

public class LightingController : MonoBehaviour
{
    [Header("光源引用")]
    public Light directionalLight;
    public Light[] indoorLights;

    [Header("时间设置")]
    public float dayDuration = 120f; // 一个日夜循环秒数

    private LightmapData[] originalLightmaps;
    private LightmapData[] nightLightmaps;

    void Start()
    {
        // 缓存原始 Lightmap 数据
        originalLightmaps = LightmapSettings.lightmaps;

        // 根据时间段切换 Lightmap（室内/室外）
        // 注意：Lightmap 切换会有明显卡顿，建议预加载
    }

    void Update()
    {
        // 昼夜变化驱动方向光角度和颜色
        float sunAngle = (Time.time / dayDuration) * 360f % 360f;
        directionalLight.transform.rotation =
            Quaternion.Euler(sunAngle, 170f, 0f);

        // 日出日落色温变化
        float t = Mathf.Clamp01(Mathf.Sin(sunAngle * Mathf.Deg2Rad));
        directionalLight.color = Color.Lerp(
            new Color(1.0f, 0.6f, 0.4f),  // 日落暖色
            new Color(1.0f, 0.95f, 0.85f), // 正午白光
            t
        );
        directionalLight.intensity = Mathf.Lerp(0.3f, 1.2f, t);
    }

    // 性能优化：远处使用烘焙阴影，近处切换实时
    public void OptimizeShadowDistance()
    {
        // URP 设置
        var urpAsset = GraphicsSettings.currentRenderPipeline
            as UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset;
        if (urpAsset != null)
        {
            urpAsset.shadowDistance = 30f; // 30米内实时阴影
        }
    }
}
```

#### URP 中的光照特性

URP 对光照有特殊限制和能力：

```
URP 光照限制：
  ├── 方向光：1 个（主光），支持阴影
  ├── 附加光（Additional Lights）：
  │    ├── Per Vertex：逐顶点计算（移动端）
  │    └── Per Pixel：逐像素计算（PC/主机）
  ├── 附加光数量限制：默认 8（可调，移动端建议 ≤4）
  └── 反射探针（Reflection Probe）：支持，开销较大需控制数量
```

### ⚡ 实战经验

- **移动端烘焙参数参考**：Lightmap Resolution 用 10~20 texels/unit，Direct Samples 32，Indirect Samples 256~512，Bounces 2 次，单张 Lightmap Atlas 用 1024×1024，通常 2~4 张 atlas 足够一个中等场景
- **Light Probe 布局是艺术**：不能均匀分布，要在光照变化剧烈的区域（如门口、窗边）加密，在开阔区域可以稀疏，否则动态角色穿过阴影区域时光照会突变
- **Shadowmask 是性价比之王**：比 Subtractive 质量高一档，比 Baked Indirect 性能更好，如果不确定选哪个 Mixed 模式，默认 Shadowmask
- **避免运行时动态切换 Lightmap**：`LightmapSettings.lightmaps = newArray` 会导致明显的帧卡顿（GC + 上传纹理），需要切换的场景应在加载时预载两套 Lightmap

### 🔗 相关问题

- Unity 的 Realtime GI（Enlighten）为什么在 URP 中被弃用？未来光照方案趋势是什么？
- Reflection Probe 的性能开销如何控制？什么场景下用 Planar Reflection 替代？
- Lightmap 参数（Resolution、Padding、Max Atlas Size）如何针对移动端调优？
