---
title: "Unity URP 渲染管线与内置管线有什么区别？如何选择？"
category: "unity"
level: 2
tags: ["渲染管线", "URP", "HDRP", "性能优化"]
related: ["unity/drawcall-batching"]
hint: "从架构灵活度、性能表现、平台兼容性三个维度对比 URP 和 Built-in 管线。"
---

## 参考答案

### ✅ 核心要点

1. **URP（Universal Render Pipeline）** 是 Unity 官方主推的可编程渲染管线，专为跨平台高性能场景设计
2. **核心架构差异**：Built-in 是固定管线黑盒；URP 将渲染拆分为可自定义的 RenderFeature + RenderPass
3. **性能优势**：URP 默认使用 SRP Batcher，大幅减少 SetPassCall 开销；移动端 GPU 帧时间显著降低
4. **功能取舍**：URP 部分高级特性（如实时 GI、某些后处理）支持不如 Built-in / HDRP 完善
5. **选择原则**：移动端/跨平台选 URP；PC 高画质 3A 选 HDRP；老项目快速验证可用 Built-in

### 📖 深度展开

#### 管线架构对比

```
Built-in Pipeline (固定)
┌──────────────────────────┐
│  Unity 内部黑盒处理        │
│  (无法插入自定义 Pass)     │
└──────────────────────────┘

URP (可编程)
┌─────────────────────────────────────┐
│  RenderPipelineAsset (配置入口)       │
│   ├── Renderer (Forward/Deferred)    │
│   │    ├── RenderPass 1: Shadow      │
│   │    ├── RenderPass 2: Opaque      │
│   │    ├── RenderPass 3: Skybox      │
│   │    ├── RenderPass 4: Transparent │
│   │    └── RenderPass 5: PostFX      │
│   ├── RenderFeature (自定义 Pass)     │
│   └── Shader (Shader Graph / HLSL)   │
└─────────────────────────────────────┘
```

#### 三种管线横向对比

| 维度 | Built-in | URP | HDRP |
|------|----------|-----|------|
| 目标平台 | 全平台 | 全平台（移动端最优） | PC/主机 |
| 渲染路径 | Forward / Deferred | Forward / Forward+ / Deferred | Deferred Only |
| SRP Batcher | ❌ | ✅ | ✅ |
| Shader Graph | ❌ | ✅ | ✅ |
| 实时 GI | ✅ Enlighten | ⚠️ 有限 | ✅ 高质量 |
| 后处理 | PostProcessing Stack | 内置 Volume 系统 | 内置高级 Volume |
| 包体大小 | 最小 | 中等 | 最大 |
| 学习曲线 | 低 | 中 | 高 |
| 维护状态 | 不再新增功能 | 持续更新 | 持续更新 |

#### SRP Batcher 原理

SRP Batcher 是 URP 的核心性能利器。传统渲染中，每个材质的 CBUFFER（Constant Buffer）更新都会打断 GPU 管线；SRP Batcher 要求 Shader 使用 `CBUFFER_START(UnityPerMaterial)` 宏声明材质属性，引擎就能将相同 Shader 的材质批处理，避免重复设置管线状态：

```hlsl
// URP 兼容 Shader 必须这样声明材质属性
CBUFFER_START(UnityPerMaterial)
    float4 _BaseMap_ST;
    float4 _BaseColor;
    float _Cutoff;
    float _Smoothness;
CBUFFER_END
```

```
传统渲染:                        SRP Batcher:
Material A → SetPass → Draw      Material A ─┐
Material B → SetPass → Draw      Material B ─┤→ 一次管线设置 → 批量 Draw
Material C → SetPass → Draw      Material C ─┘
(3 次 GPU 状态切换)               (1 次 GPU 状态切换)
```

#### 自定义 RenderFeature 示例

URP 最强大的能力之一是通过 RenderFeature 插入自定义渲染逻辑，比如描边、扫描线、夜视等效果：

```csharp
// 自定义 RenderFeature：在渲染完成后绘制全屏描边
public class OutlineFeature : ScriptableRendererFeature
{
    public RenderPassEvent renderPassEvent = RenderPassEvent.AfterRenderingOpaques;
    public Material outlineMaterial;

    private OutlinePass outlinePass;

    public override void Create()
    {
        outlinePass = new OutlinePass(outlineMaterial)
        {
            renderPassEvent = renderPassEvent
        };
    }

    public override void AddRenderPasses(
        ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        if (outlineMaterial != null)
            renderer.EnqueuePass(outlinePass);
    }

    protected override void Dispose(bool disposing)
    {
        outlinePass?.Dispose();
    }
}
```

### ⚡ 实战经验

- **迁移成本评估**：从 Built-in 迁移到 URP 不是一键切换，所有自定义 Shader 都需要重写为 URP 兼容版本（使用 URP Shader 模板），工作量可能很大
- **移动端首选 URP**：实测在 Android 中端机上，URP + SRP Batcher 比同等场景的 Built-in 管线帧时间降低 20%~40%，尤其是 DrawCall 密集的场景
- **RenderFeature 不是免费的**：每个 RenderFeature 都会额外增加 GPU 开销，移动端要谨慎使用，通过 Frame Debugger 确认每个 Pass 的实际开销
- **Forward+ 是折中方案**：URP 的 Forward+ 模式在处理多光源时优于纯 Forward，但需要 WebGL 2.0 / GLES 3.1+ 支持，低配设备要兜底

### 🔗 相关问题

- SRP Batcher 和 GPU Instancing 有什么区别？能同时使用吗？
- 如何实现 URP 下的自定义后处理效果（Bloom、色彩校正等）？
- URP 的 Deferred 渲染路径在移动端是否值得使用？
