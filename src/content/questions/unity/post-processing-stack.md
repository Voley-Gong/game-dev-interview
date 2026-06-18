---
title: "Unity 后处理（Post-Processing）系统的工作原理与优化策略？"
category: "unity"
level: 2
tags: ["渲染管线", "后处理", "URP", "HDRP", "性能优化"]
related: ["unity/urp-render-pipeline", "unity/mobile-optimization"]
hint: "后处理效果是全屏执行的，想想到底发生了几次全屏 Render Pass？"
---

## 参考答案

### ✅ 核心要点

1. **后处理**是在场景渲染完成后、上屏前对最终画面进行像素级处理的阶段（全屏 Shader Pass）
2. Unity 有两套系统：**Post Processing Stack v2**（Built-in 管线）和 **Volume 系统**（URP/HDRP）
3. URP 使用 **Volume + Volume Component** 架构，通过权重混合实现平滑过渡（如受伤时画面变红）
4. 后处理是 **性能重灾区**：每个 Effect 至少一次全屏 Draw Call + 一次 Render Texture 切换
5. 移动端需要严格裁剪后处理效果列表，优先使用单 Pass 合并的 LUT/Grading 方案

### 📖 深度展开

#### URP Volume 系统架构

```
Camera (URP Camera)
  └── Volume Manager (全局管理)
       ├── Global Volume (全局后处理)
       │    └── Profile (后处理配置资产)
       │         ├── Bloom (VolumeComponent)
       │         ├── ColorAdjustments
       │         ├── DepthOfField
       │         └── Vignette
       │
       ├── Local Volume (局部触发器)
       │    ├── Blend Distance: 2m (进入区域时的混合距离)
       │    └── Priority: 1 (多个 Volume 重叠时的优先级)
       │
       └── Volume Stack (运行时混合栈)
            └── 按权重插值各 Component 参数 → 最终渲染参数
```

#### URP 后处理渲染流程

```
场景不透明渲染 → 深度/法线 Pass → 透明物体渲染
  ↓
后处理链 (Post-Processing Pass)
  ├── 1. Depth of Field (DoF)        ← 需要 Depth Texture
  ├── 2. Motion Blur                  ← 需要速度缓冲 (Motion Vectors)
  ├── 3. Color Grading (LUT)          ← Tonemapping + 色彩校正
  ├── 4. Bloom                        ← 多级下采样 → 叠加
  ├── 5. Chromatic Aberration         ← 径向扭曲
  ├── 6. Vignette / Film Grain        ← 边缘暗角 + 噪点
  └── 7. FXAA / SMAA                  ← 抗锯齿
  ↓
最终输出到 Screen
```

#### 后处理效果性能对比表

| 效果 | GPU 开销 | 移动端建议 | 说明 |
|------|----------|------------|------|
| Color Grading (LUT) | ⭐ 低 | ✅ 推荐 | 预烘焙 LUT，运行时仅一次纹理查找 |
| Bloom | ⭐⭐⭐ 高 | ⚠️ 谨慎 | 多级降采样迭代（通常6级），阈值采集 |
| Depth of Field | ⭐⭐⭐⭐ 很高 | ❌ 不推荐 | 散景 DoF 需要多 Pass + 高斯模糊 |
| Motion Blur | ⭐⭐⭐ 高 | ❌ 不推荐 | 需要每帧速度缓冲 |
| Vignette | ⭐ 低 | ✅ 可用 | 单 Pass 简单计算 |
| Chromatic Aberration | ⭐ 低 | ✅ 可用 | 单 Pass 径向偏移 |
| Screen Space Ambient Occlusion | ⭐⭐⭐⭐ 很高 | ❌ 不推荐 | 半球采样 + 降噪 |
| FXAA | ⭐ 低 | ✅ 推荐 | 单 Pass，移动端首选 AA |

#### Volume 权重混合代码示例

```csharp
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

public class DamageEffectController : MonoBehaviour
{
    [SerializeField] private Volume _damageVolume;
    [SerializeField] private float _fadeSpeed = 2f;

    private Vignette _vignette;
    private ColorAdjustments _colorAdjustments;
    private float _targetWeight = 0f;

    void Start()
    {
        // 从 Profile 中获取具体的 Component 引用
        _damageVolume.profile.TryGet(out _vignette);
        _damageVolume.profile.TryGet(out _colorAdjustments);
    }

    void Update()
    {
        // 通过 Volume.weight 控制整体混合强度
        _damageVolume.weight = Mathf.MoveTowards(
            _damageVolume.weight,
            _targetWeight,
            _fadeSpeed * Time.deltaTime
        );
    }

    public void TriggerDamage()
    {
        _targetWeight = 1f;
        // 动态修改后处理参数
        if (_vignette != null)
            _vignette.intensity.value = 0.8f;
        if (_colorAdjustments != null)
        {
            _colorAdjustments.saturation.value = -60f;  // 画面去饱和
            _colorAdjustments.colorFilter.value = Color.red; // 偏红
        }

        // 0.5 秒后开始恢复
        Invoke(nameof(Recover), 0.5f);
    }

    private void Recover() => _targetWeight = 0f;
}
```

#### URP Renderer Feature 自定义后处理

```csharp
// Unity 2022+ URP 自定义后处理 Pass
public class CustomGrayscalePass : ScriptableRenderPass
{
    private RTHandle _source;
    private Material _material;
    private RTHandle _tempTexture;

    public override void OnCameraSetup(CommandBuffer cmd, ref RenderingData data)
    {
        _source = data.renderer.cameraColorTargetHandle;
        // 分配临时 Render Texture
        RenderingUtils.ReAllocateIfNeeded(ref _tempTexture, data.cameraData.cameraTargetDescriptor);
    }

    public override void Execute(ScriptableRenderContext context, ref RenderingData data)
    {
        if (_material == null) return;

        CommandBuffer cmd = CommandBufferPool.Get("CustomGrayscale");
        // Blit: source → temp (执行 Shader) → source
        Blitter.BlitCameraTexture(cmd, _source, _tempTexture, _material, 0);
        Blitter.BlitCameraTexture(cmd, _tempTexture, _source);
        context.ExecuteCommandBuffer(cmd);
        CommandBufferPool.Release(cmd);
    }
}
```

### ⚡ 实战经验

1. **Bloom 是移动端性能杀手**：在低端机上关闭 Bloom 或降低下采样级数（从6级降到3级），帧率可能直接翻倍。建议根据设备分级设置不同的后处理 Profile
2. **Volume 的 weight 混合不是无开销的**：多个 Volume 同时高权重会导致大量参数插值计算。合理设置 Volume 的范围和优先级，避免大面积重叠
3. **URP 中 Depth Texture 默认可能没开**：DoF、SSAO、Motion Blur 都需要 Depth Texture，如果后处理效果不生效，先检查 URP Asset 里的 Depth Texture 开关
4. **后处理和 MSAA 冲突**：MSAA 开启时部分后处理效果（如 DoF）需要额外的 Resolve Pass。移动端通常选择 FXAA 而非 MSAA + 后处理 AA

### 🔗 相关问题

- URP 的 Render Feature 是什么？如何用它实现自定义渲染效果？
- Color Grading 的 LUT（Look-Up Table）原理是什么？如何制作自定义 LUT？
- 如何在 URP 和 Built-in 管线之间迁移后处理配置？
