---
title: "Unity URP 中 Camera Stack 是什么？Base Camera、Overlay Camera 和 Wallet Camera 的区别与使用场景？"
category: "unity"
level: 2
tags: ["渲染管线", "URP", "Camera", "多摄像机"]
related: ["unity/urp-render-pipeline", "unity/post-processing-stack"]
hint: "URP 的 Camera Stack 取代了内置管线的多 Camera 叠加机制，它是如何工作的？性能开销在哪？"
---

## 参考答案

### ✅ 核心要点

1. **Camera Stack 是 URP 的多摄像机叠加方案**：由一个 Base Camera + N 个 Overlay Camera 组成
2. **三种 Render Type**：Base（渲染到屏幕/Texture）、Overlay（叠加到 Base 的输出上）、Skybox（钱包/特殊用途）
3. **渲染顺序由 Priority 控制**：Overlay Camera 按 Priority 值升序依次叠加
4. **每个 Camera 可以独立配置 Post Processing**：灵活组合后处理效果
5. **Camera Stack 的性能开销与 Camera 数量正相关**：每个 Overlay 都是一次完整的渲染 Pass

### 📖 深度展开

#### Camera Stack 工作原理

```
┌─────────────────────────────────────────┐
│           Camera Stack                  │
│                                         │
│  ┌─────────┐  Render Type: Base        │
│  │  Main   │  → Output: Screen         │
│  │ Camera  │  → Post Processing: On    │
│  └────┬────┘                            │
│       │                                 │
│  ┌────▼────┐  Render Type: Overlay     │
│  │  UI     │  → Post Processing: Off   │
│  │ Camera  │  → Clear Flags: Depth     │
│  └────┬────┘                            │
│       │                                 │
│  ┌────▼────┐  Render Type: Overlay     │
│  │ Effect │  → Post Processing: On     │
│  │ Camera │  → Render Texture: Glow RT │
│  └─────────┘                            │
│                                         │
│  Final Output → Screen Frame Buffer    │
└─────────────────────────────────────────┘
```

#### 与内置管线 Camera.clearFlags 的对比

| 特性 | Built-in (clearFlags) | URP (Camera Stack) |
|------|----------------------|-------------------|
| 叠加方式 | Depth + Clear Flags | Render Type: Overlay |
| 后处理控制 | 全局 | 每个 Camera 独立 |
| 性能管理 | 隐式 | 显式 Stack 组合 |
| 排序 | Depth 值 | Priority 值 |
| Render Texture | 支持 | 支持 + 更灵活 |

#### Base Camera vs Overlay Camera

```csharp
// 脚本控制 Camera Stack
var baseCamera = GetComponent<Camera>();
var cameraData = baseCamera.GetUniversalAdditionalCameraData();

// 添加 Overlay Camera 到 Stack
var overlayCamObj = new GameObject("OverlayCamera");
var overlayCam = overlayCamObj.AddComponent<Camera>();
var overlayData = overlayCam.GetUniversalAdditionalCameraData();
overlayData.renderType = CameraRenderType.Overlay;

cameraData.cameraStack.Add(overlayCam);

// 移除
cameraData.cameraStack.Remove(overlayCam);

// 动态排序（Priority 越小越先渲染）
overlayData.renderType = CameraRenderType.Overlay;
// 注意：排序由 cameraStack 列表顺序 + Priority 共同决定
```

#### 典型应用场景

**场景 1：3D 场景 + UI 叠加**

```
Base Camera (Priority: 0)
  → 渲染 3D 世界 + 主光照 + 阴影 + 后处理
Overlay Camera (Priority: 1)
  → 仅渲染 UI Layer
  → 不开后处理（UI 不需要 Bloom/Tone Mapping）
  → Clear Depth: 不清除（继承主相机的深度缓冲）
```

```csharp
// 分层渲染配置
overlayCam.cullingMask = 1 << LayerMask.NameToLayer("UI");
baseCamera.cullingMask = ~(1 << LayerMask.NameToLayer("UI"));

var overlayData = overlayCam.GetUniversalAdditionalCameraData();
overlayData.renderType = CameraRenderType.Overlay;
// 关键：Overlay Camera 不应清除颜色缓冲
```

**场景 2：小地图 / 俯视相机**

```
Base Camera (主视角)
  → 渲染主场景
Overlay Camera (俯视)
  → Render Texture 输出到小地图 RawImage
  → 或者直接作为 PiP（画中画）叠加
```

**场景 3：多 Pass 特效（如描边、热扭曲）**

```csharp
// 使用 Renderer Feature + Camera Stack 组合
// 1. Base Camera 渲染主场景
// 2. Overlay Camera 使用特定 Layer 渲染需要描边的对象
// 3. Renderer Feature 在 Overlay Pass 中执行描边 Shader

// URP Renderer Feature 注册（简化）
public class OutlineFeature : ScriptableRendererFeature
{
    public override void AddRenderPasses(ScriptableRenderer renderer,
                                         ref RenderingData renderingData)
    {
        // 仅在特定 Camera 上执行
        if (renderingData.cameraData.cameraType != CameraType.Game)
            return;
        // ... 注入描边 Pass
    }
}
```

#### 性能分析

```
单个 Camera Stack 的渲染开销：

Base Camera:
  ├─ Culling          ~0.3ms (视场景复杂度)
  ├─ Shadow Pass      ~0.5ms
  ├─ Opaque Pass      ~2.0ms
  ├─ Transparent Pass ~0.8ms
  └─ Post Processing  ~1.0ms
                      ───────
                      ~4.6ms

每个 Overlay Camera:
  ├─ Culling          ~0.1ms (通常 Layer 过滤后很少)
  ├─ Opaque Pass      ~0.5ms
  └─ Post Processing  ~0.3ms (如果开启)
                      ───────
                      ~0.9ms × Overlay数量
```

| 优化策略 | 效果 | 说明 |
|---------|------|------|
| 减少 Overlay Camera 数量 | ⭐⭐⭐ | 每个 Overlay 都有固定开销 |
| 关闭不需要的 Overlay 后处理 | ⭐⭐ | 后处理是 Overlay 的大头 |
| 使用 Renderer Feature 代替多 Camera | ⭐⭐⭐ | 描边等效果用 Renderer Feature 更高效 |
| 合并 cullingMask | ⭐ | 减少 Layer 过滤次数 |

### ⚡ 实战经验

1. **能用 Renderer Feature 就别用 Overlay Camera**：很多场景下（描边、扫描线、夜视），Renderer Feature + Render Objects 比 Camera Stack 更高效，因为避免了额外的 culling 和 Pass 切换开销。只有在真正需要不同后处理组合或不同 FOV/视角时才用 Camera Stack。

2. **Overlay Camera 的后处理叠加是个坑**：如果 Base Camera 开了 Bloom，Overlay Camera 也开了 Bloom，效果会叠加导致过曝。通常 Overlay Camera 应该关闭后处理，只在 Base Camera 上统一处理。或者在最后一个 Overlay 上统一做后处理。

3. **Render Texture 输出的 Camera 不需要加入 Stack**：需要把场景渲染到 Texture 时（小地图、监控画面），直接用独立的 Base Camera 输出到 RenderTexture 即可，不要用 Overlay。Overlay 是叠加到同一个输出目标上的。

4. **Camera Stack 在 XR（VR/AR）下有限制**：URP 早期版本中，Camera Stack 在 XR 模式下不支持 Overlay。从 Unity 2022.2+ 开始才逐步完善 XR + Camera Stack 的兼容性，遇到 XR 项目要检查版本兼容性。

### 🔗 相关问题

- URP Renderer Feature 的 Render Objects Pass 如何实现自定义渲染顺序？
- 内置管线迁移到 URP 时，多摄像机系统的注意事项有哪些？
- URP 中如何实现分屏（Split Screen）多玩家渲染？
