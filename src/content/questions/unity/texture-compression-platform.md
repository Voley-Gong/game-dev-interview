---
title: "Unity 纹理压缩格式如何选择？不同平台的压缩方案和内存占用怎样？"
category: "unity"
level: 2
tags: ["纹理压缩", "资源管理", "移动端", "性能优化", "内存管理"]
related: ["unity/memory-management-leak", "unity/mobile-optimization"]
hint: "ASTC、ETC2、BC7、PVRTC 各自适用什么平台？一张 2048x2048 的 RGBA 纹理在不同格式下占用多少内存？"
---

## 参考答案

### ✅ 核心要点

1. **纹理是内存大户**：未压缩的 2048×2048 RGBA = 16MB，ASTC 4×4 压缩后仅 4MB，压缩比 4:1
2. **平台不可通用**：ASTC（移动端全能）、ETC2（Android）、PVRTC（旧 iOS）、BC7（PC/主机），必须按目标平台配置
3. **质量与大小权衡**：ASTC block size 越小块质量越好但内存越大（2×2 最高质量 → 12×12 最低质量）
4. **Mipmap 策略**：UI 纹理通常关闭 Mipmap，3D 场景纹理必须开启，但内存增加 33%
5. **Platform Override**：在纹理导入设置中为每个平台指定压缩格式，Unity 构建时自动转换

### 📖 深度展开

#### 内存占用速查表

| 纹理格式 | 2048² RGBA 原始 | 压缩后 | 压缩比 | 适用平台 |
|----------|-----------------|--------|--------|----------|
| 未压缩 RGBA32 | 16 MB | — | 1:1 | 仅开发期 |
| ASTC 4×4 | 16 MB | 4 MB | 4:1 | 移动端主流 |
| ASTC 6×6 | 16 MB | 1.8 MB | ~9:1 | 移动端（低精度） |
| ETC2 (RGB) | 16 MB | 2 MB | 8:1 | Android |
| PVRTC 4bpp | 16 MB | 2 MB | 8:1 | 旧 iOS |
| BC7 | 16 MB | 4 MB | 4:1 | PC / 主机 |
| BC1 (DXT1) | 16 MB | 2 MB | 8:1 | PC（无 Alpha） |

#### ASTC：现代移动端首选

ASTC（Adaptive Scalable Texture Compression）由 ARM 开发，已取代 PVRTC 和 ETC2 成为移动端标准：

```
ASTC Block Size 选择指南：

高质量（UI、法线贴图）   →  4×4  (8 bpp → 0.25 bytes/pixel)  2048² = 4 MB
均衡（漫反射贴图）       →  6×6  (3.56 bpp)                    2048² = 1.78 MB
省内存（远景、天空盒）    →  8×8  (2 bpp)                       2048² = 1 MB
极省内存（遮罩图）       →  10×10 / 12×12                       2048² = 0.64 MB / 0.44 MB
```

ASTC 核心优势：
- **统一格式**：iOS + Android 通吃，不需要平台分别打包
- **质量优秀**：同码率下质量优于 PVRTC/ETC2
- **灵活压缩比**：block size 2×2 ~ 12×12 可选
- **支持 HDR**：ASTC 可压缩 HDR 纹理（RGB9E5 等）

#### Platform Override 配置

```
纹理导入设置 → Platform Override：

┌─────────────────────────────────────────────────┐
│  Platform        Format        Max Size         │
├─────────────────────────────────────────────────┤
│  Android    →   ASTC 6×6       2048            │
│  iOS       →   ASTC 6×6       2048            │
│  PC        →   BC7             2048            │
│  WebGL     →   ASTC 4×4       1024            │
└─────────────────────────────────────────────────┘

  ✓ Override for Android: [✓]
  Format: ASTC 6x6
  Max Size: 2048
  Compression: Normal Quality

  ✓ Override for iOS: [✓]
  Format: ASTC 6x6
  Max Size: 2048
```

#### 法线贴图压缩的特殊处理

法线贴图对压缩格式敏感度更高，需要特殊注意：

```csharp
// TextureImporter 法线贴图推荐配置
[CreateAssetMenu]
class NormalTexturePreset : TextureImporterPreset
{
    // Android: ASTC 4x4（法线需要更高精度）
    // iOS:    ASTC 4x4
    // PC:     BC7（法线通道分布最优）
    
    // 关键：必须勾选 "Create from Grayscale: No"
    // 并设置 Texture Type: Normal map
}
```

| 法线贴图格式 | 质量评估 | 备注 |
|-------------|---------|------|
| ASTC 4×4 | ⭐⭐⭐⭐ | 移动端首选 |
| BC7 | ⭐⭐⭐⭐⭐ | PC/主机首选 |
| DXT5nm (BC3) | ⭐⭐⭐ | 旧版 PC 方案 |
| ETC2 | ⭐⭐ | 不推荐法线使用 |

#### 内存计算公式

```
纹理内存 = Width × Height × BitsPerPixel / 8

常用 BitsPerPixel：
  RGBA32 未压缩:    32 bpp
  ASTC 4×4:        8.00 bpp
  ASTC 6×6:        3.56 bpp
  ETC2 RGB:        4.00 bpp
  ETC2 RGBA:       8.00 bpp
  PVRTC 4bpp:      4.00 bpp
  BC7:             8.00 bpp
  BC1 (DXT1):      4.00 bpp

含 Mipmap：× 1.333（多级渐远纹理额外 33%）
```

### ⚡ 实战经验

1. **内存预算先行**：项目初期制定纹理预算（如移动端单个场景纹理总量 < 100MB），在 Unity 的 Memory Profiler 中定期检查纹理占用，超预算立即预警。一张未压缩的 4096² RGBA 纹理 = 64MB，移动端能直接 OOM
2. **UI 图集压缩策略**：UGUI Sprite Atlas 使用 ASTC 6×6（色彩要求不高的背景图）或 4×4（精细 UI 元素），同时开启 `Include in Build` 并设置 `Atlas Region` 优化碎片。注意 UI 文字图集不要压缩过度，否则会出现文字锯齿
3. **Android 兼容性排查**：ASTC 需要 OpenGL ES 3.0+ / Vulkan 支持。2013 年之前的旧设备不支持 ASTC，需通过 `SystemInfo.SupportsTextureFormat(TextureFormat.ASTC_RGBA_6x6)` 运行时检测并回退到 ETC2
4. **Build 后验证**：Editor 中看到的纹理是未压缩的，必须在 Build 后用 Memory Profiler 或 `Texture2D.format` 运行时检查实际压缩格式。曾遇到 Platform Override 未勾选导致线上包纹理未压缩，包体从 200MB 暴增到 2GB

### 🔗 相关问题

- [Unity 内存管理与泄漏排查有哪些要点？](unity/memory-management-leak)
- [移动端游戏如何做发热控制和性能调优？](unity/mobile-optimization)
- Sprite Atlas 的打包策略和内存加载机制是怎样的？
