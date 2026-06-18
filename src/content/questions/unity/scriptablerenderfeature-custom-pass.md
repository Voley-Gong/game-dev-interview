---
title: "Unity URP 中 ScriptableRenderFeature 如何实现自定义渲染 Pass？"
category: "unity"
level: 3
tags: ["URP", "渲染管线", "ScriptableRenderFeature", "后处理", "Shader"]
related: ["unity/urp-render-pipeline", "unity/post-processing-stack", "unity/shader-material-system"]
hint: "想实现描边、扫描线、全屏扭曲等自定义渲染效果，URP 的正确扩展点是什么？"
---

## 参考答案

### ✅ 核心要点

1. **ScriptableRenderFeature 是 URP 的扩展点**：无需修改 URP 源码，通过 Feature + Pass 组合实现自定义渲染逻辑
2. **执行流程**：`Create()` 配置 Pass → `AddRenderPasses()` 注入管线 → Pass 的 `Execute()` 执行渲染命令
3. **RenderPassEvent 控制时机**：在 `BeforeRenderingPostProcessing`、`AfterRenderingTransparents` 等节点插入，决定了自定义效果与内置渲染的先后
4. **Blit 链路**：通过 `Blitter.BlitCameraTexture` 在 RT 之间传递，实现全屏后处理风格的效果
5. **多相机兼容**：需在 `AddRenderPasses` 中通过 `renderingData.cameraData.cameraType` 过滤，避免 Preview 相机也执行自定义 Pass

### 📖 深度展开

#### 完整的实现结构

```
ScriptableRendererFeature (资产/配置层)
  ├── Create()           → 初始化 Pass
  └── AddRenderPasses()  → 每帧注入 Pass 到渲染队列
  
ScriptableRenderPass (执行层)
  ├── OnCameraSetup()    → 配置 RT、获取渲染目标
  ├── Execute()          → 核心渲染逻辑（CommandBuffer）
  └── OnCameraCleanup()  → 释放临时 RT
```

#### 示例：实现全屏描边（Outline）效果

**第 1 步：定义 Feature**

```csharp
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public class OutlineFeature : ScriptableRendererFeature
{
    [System.Serializable]
    public class OutlineSettings
    {
        public RenderPassEvent renderPassEvent = RenderPassEvent.BeforeRenderingPostProcessing;
        public Material outlineMaterial;      // 描边材质
        public int blurIterations = 3;        // 模糊迭代次数
        public float blurSpread = 1.5f;       // 模糊扩散
        [Range(0, 5)] public float intensity = 1.5f;
    }

    public OutlineSettings settings = new OutlineSettings();
    private OutlinePass _pass;

    public override void Create()
    {
        _pass = new OutlinePass(settings)
        {
            renderPassEvent = settings.renderPassEvent
        };
    }

    public override void AddRenderPasses(ScriptableRenderer renderer, ref RenderingData renderingData)
    {
        // 跳过 Preview 相机和 Reflection 相机
        if (renderingData.cameraData.cameraType != CameraType.Game) return;
        if (settings.outlineMaterial == null) return;

        _pass.Setup(renderer.cameraColorTargetHandle);
        renderer.EnqueuePass(_pass);
    }

    protected override void Dispose(bool disposing)
    {
        _pass?.Dispose();
    }
}
```

**第 2 步：定义 Pass**

```csharp
public class OutlinePass : ScriptableRenderPass
{
    private readonly OutlineFeature.OutlineSettings _settings;
    private RTHandle _sourceHandle;
    private RTHandle _tempTexture0;
    private RTHandle _tempTexture1;

    private static readonly int IntensityId = Shader.PropertyToID("_Intensity");
    private static readonly int BlurSizeId = Shader.PropertyToID("_BlurSize");

    public OutlinePass(OutlineFeature.OutlineSettings settings)
    {
        _settings = settings;
    }

    public void Setup(RTHandle source)
    {
        _sourceHandle = source;
    }

    public override void OnCameraSetup(CommandBuffer cmd, ref RenderingData renderingData)
    {
        var desc = renderingData.cameraData.cameraTargetDescriptor;
        desc.depthBufferBits = 0; // 后处理 RT 不需要深度

        // 注意：URP 14+ 使用 RTHandles，不再用 RenderTargetIdentifier
        Blitter.GetBlitTextureTemporaryRT(cmd, ref _tempTexture0, desc, FilterMode.Bilinear);
        Blitter.GetBlitTextureTemporaryRT(cmd, ref _tempTexture1, desc, FilterMode.Bilinear);
    }

    public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
    {
        var cmd = CommandBufferPool.Get("OutlineEffect");

        // Pass 1: 提取亮边 → _tempTexture0
        Blitter.BlitCameraTexture(cmd, _sourceHandle, _tempTexture0, _settings.outlineMaterial, 0);

        // Pass 2: 多次模糊
        cmd.SetFloat(BlurSizeId, _settings.blurSpread);
        for (int i = 0; i < _settings.blurIterations; i++)
        {
            Blitter.BlitCameraTexture(cmd, _tempTexture0, _tempTexture1, _settings.outlineMaterial, 1);
            Blitter.BlitCameraTexture(cmd, _tempTexture1, _tempTexture0, _settings.outlineMaterial, 2);
        }

        // Pass 3: 叠加回主画面
        cmd.SetFloat(IntensityId, _settings.intensity);
        Blitter.BlitCameraTexture(cmd, _tempTexture0, _sourceHandle, _settings.outlineMaterial, 3);

        context.ExecuteCommandBuffer(cmd);
        CommandBufferPool.Release(cmd);
    }

    public void Dispose()
    {
        _tempTexture0?.Release();
        _tempTexture1?.Release();
    }
}
```

**第 3 步：注册到 URP Renderer 资产**

```
1. 选中 Universal Renderer Data 资产
2. 点击 "Add Renderer Feature" → 选择 "Outline Feature"
3. 配置描边材质和参数
4. 效果自动生效，可在 Scene 视图中实时预览
```

#### RenderPassEvent 时机选择

| 事件 | 时机 | 典型用途 |
|------|------|---------|
| `BeforeRenderingPrepasses` | 阴影前 | 自定义阴影 Pass |
| `AfterRenderingOpaques` | 不透明物后 | 自定义延迟光照、SSAO |
| `AfterRenderingSkybox` | 天空盒后 | 全屏天气效果 |
| `BeforeRenderingPostProcessing` | 后处理前 | 自定义后效（描边、扫描线） |
| `AfterRenderingPostProcessing` | 后处理后 | 最终画面调整、水印 |
| `BeforeRenderingTransparents` | 透明物前 | 透明排序前的特殊效果 |

#### RTHandle vs 旧版 RTIdentifier

```
URP 版本演进：

URP 12 (Unity 2021)  → RenderTargetIdentifier
URP 14 (Unity 2022)  → RTHandle (推荐)
URP 17 (Unity 6)     → RTHandle + Blitter API（强制）

关键 API 变化：
  旧：cmd.GetTemporaryRT()
  新：Blitter.GetBlitTextureTemporaryRT()

  旧：cmd.Blit()
  新：Blitter.BlitCameraTexture()

  旧：RenderTargetIdentifier
  新：RTHandle
```

#### 多 Feature 的渲染顺序

```
Renderer Asset Feature 列表：
  [0] SSAO Feature        ← 先执行
  [1] Outline Feature
  [2] Color Grading        ← 后执行

执行顺序由两个因素决定：
  1. renderPassEvent（大框架排序）
  2. Feature 在列表中的位置（同 event 时排序）
```

### ⚡ 实战经验

1. **RTHandle 生命周期管理**：`OnCameraSetup` 中分配的临时 RT 必须在 `Dispose` 中释放，否则切换场景或销毁相机时会泄漏 GPU 内存。用 `RTHandles.Release(_handle)` 确保释放，在 Editor 下用 Render Doc 验证是否有未释放的 RT
2. **MSAA 兼容性**：当相机开启了 MSAA，`cameraColorTarget` 可能是 MSAA 纹理，直接 Blit 会失败。需要在 Blit 前调用 `cmd.DisableShaderKeyword("MSAA")` 或在 `OnCameraSetup` 中检查 `cameraTargetDescriptor.msaaSamples > 1` 并先 ResolveMSAA
3. **Scene 视图不显示**：自定义 Feature 默认只在 Game 视图生效。如果需要 Scene 视图也显示，需在 `AddRenderPasses` 中允许 `CameraType.SceneView`，但要注意 Preview 相机的缩略图也会执行 Pass，需排除 `CameraType.Preview`
4. **SRP Batcher 兼容**：自定义渲染 Pass 中的 `cmd.DrawRenderer` 调用会打断 SRP Batcher。如果只是全屏 Blit 不影响 Batcher，但如果有自定义几何体绘制，需用 `Shader.PropertyToID` 缓存所有属性名，避免每帧字符串分配

### 🔗 相关问题

- [URP 渲染管线的整体架构是怎样的？](unity/urp-render-pipeline)
- [Unity 后处理栈有哪些优化策略？](unity/post-processing-stack)
- [如何写一个自定义 Shader 实现 X 效果？](unity/shader-material-system)
