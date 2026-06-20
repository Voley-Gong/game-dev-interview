---
title: "Unity 中 CommandBuffer 和 RenderTexture 如何实现自定义渲染效果？"
category: "unity"
level: 3
tags: ["渲染管线", "CommandBuffer", "RenderTexture", "后处理", "高级渲染"]
related: ["unity/urp-render-pipeline", "unity/scriptablerenderfeature-custom-pass", "unity/shader-material-system"]
hint: "小地图、描边、透视镜、水面反射——这些效果背后的共同渲染工具是什么？"
---

## 参考答案

### ✅ 核心要点

1. **RenderTexture** 是 GPU 上的离屏渲染目标，可将 Camera 或 Shader 输出渲染到纹理
2. **CommandBuffer** 允许在渲染管线的特定插入点注入自定义 GPU 命令（DrawMesh、Blit、SetRenderTarget 等）
3. 两者配合可实现：小地图、监控屏幕、描边后处理、传送门特效、水面反射等
4. **CameraRenderTarget** 经 RenderTexture 中转后可被 Material 的 `_MainTex` 引用，形成"渲染→采样"闭环
5. CommandBuffer 可挂载到 CameraEvent / RenderPassEvent 的不同阶段，精确控制执行时机

### 📖 深度展开

#### RenderTexture 基础

```csharp
// 创建一个 RenderTexture
RenderTexture rt = new RenderTexture(512, 512, 24, RenderTextureFormat.ARGB32);
rt.antiAliasing = 4;
rt.Create();

// 方式1：将 Camera 输出定向到 RenderTexture
miniMapCamera.targetTexture = rt;
// 之后 rt 可作为 Material 的纹理使用
miniMapMaterial.SetTexture("_MainTex", rt);

// 方式2：在 Shader 中将渲染结果读取回来
Graphics.Blit(src, rt, outlineMaterial); // 源 → RT → 经过材质处理
```

#### CommandBuffer 注入自定义渲染命令

```csharp
// 创建 CommandBuffer
CommandBuffer cmd = new CommandBuffer { name = "Outline Effect" };

// 获取目标 RenderTexture
int tempRT = Shader.PropertyToID("_TempOutlineTex");
cmd.GetTemporaryRT(tempRT, Screen.width, Screen.height, 0);

// 渲染指定层级的对象到临时纹理
cmd.SetRenderTarget(tempRT);
cmd.ClearRenderTarget(true, true, Color.clear);
foreach (var renderer in outlineRenderers)
{
    cmd.DrawRenderer(renderer, outlineMaterial);
}

// Blit 回主目标
cmd.Blit(tempRT, BuiltinRenderTextureType.CameraTarget, blendMaterial);

// 挂到管线中（内置管线）
camera.AddCommandBuffer(CameraEvent.AfterForwardOpaque, cmd);
```

#### URP 中的 CommandBuffer

```csharp
// URP 中通过 ScriptableRenderPass 使用 CommandBuffer
public class OutlineRenderPass : ScriptableRenderPass
{
    public override void Execute(ScriptableRenderContext context, ref RenderingData renderingData)
    {
        CommandBuffer cmd = CommandBufferPool.Get("Outline");
        // ... 自定义渲染命令
        context.ExecuteCommandBuffer(cmd);
        CommandBufferPool.Release(cmd);
    }
}
```

#### 常见应用场景对比

| 场景 | 实现方式 | 性能注意点 |
|------|----------|------------|
| 小地图 | 顶置 Camera → RenderTexture → RawImage | RT 分辨率不宜过高（256~512 足够） |
| 描边效果 | CommandBuffer 渲染轮廓层 → Blit 混合 | 控制被渲染对象数量，避免逐帧搜索 |
| 监控屏幕 | Camera → RT → Mesh 材质采样 | 多个屏幕可共享同一张 RT |
| 传送门特效 | 传送门 Camera → RT → 传送门 Material | 注意 RT 的 Clear 时机和Stencil |
| 水面反射 | Planar Reflection（反射 Camera） | 反射 RT 分辨率减半，MSAA 关闭 |

#### CommandBuffer 可挂载的事件点

```
CameraEvent（内置管线）:
  BeforeDepthTexture → AfterDepthTexture
  BeforeGBuffer → AfterGBuffer
  BeforeForwardOpaque → AfterForwardOpaque
  BeforeForwardAlpha → AfterForwardAlpha
  BeforeImageEffects → AfterImageEffects

RenderPassEvent（URP）:
  BeforeRendering → AfterRendering
  BeforeRenderingOpaques → AfterRenderingOpaques
  BeforeRenderingTransparents → AfterRenderingTransparents
  BeforeRenderingPostProcessing → AfterRenderingPostProcessing
```

### ⚡ 实战经验

- **RenderTexture 必须手动 Release**：`rt.Release()` 释放 GPU 资源，否则内存泄漏。用 `RenderTexture.GetTemporary()` + `ReleaseTemporary()` 可让引擎池化管理
- **CommandBuffer 中的 RT 大小要匹配**：多分辨率适配时用 `Screen.width/height`，不要硬编码 1920×1080
- **URP 项目不要混用 Camera.AddCommandBuffer**：URP 不支持内置管线的 CameraEvent，必须用 ScriptableRenderPass + ScriptableRenderFeature
- **MSAA RenderTexture 在 Android 上开销大**：移动端尽量用 FXAA 替代 MSAA，或直接关闭 RT 的 antiAliasing
- **CommandBufferPool 复用**：每帧 Allocate/Free 会产生 GC 垃圾，务必用 `CommandBufferPool.Get/Release`

### 🔗 相关问题

- URP 中 ScriptableRenderFeature 和 CommandBuffer 有什么关系？
- 如何实现一个安全的 RenderTexture 对象池，避免频繁分配？
- 多 Camera 同时渲染到同一张 RenderTexture 会有什么问题？
