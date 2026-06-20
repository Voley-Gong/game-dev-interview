---
title: "Unity 的 QualitySettings 与图形质量管理体系如何运作？移动端如何做分级？"
category: "unity"
level: 2
tags: ["QualitySettings", "图形质量", "移动端", "性能分级", "构建配置"]
related: ["unity/mobile-optimization", "unity/urp-render-pipeline", "unity/texture-compression-platform"]
hint: "同样的游戏，低端机发热卡顿、高端机画面不够好——QualitySettings 怎么做分级？"
---

## 参考答案

### ✅ 核心要点

1. **QualitySettings 是引擎级图形质量管理体系**：通过预设 Quality Level 控制渲染精度、阴影、LOD、抗锯齿、纹理压缩等几十项参数
2. **移动端分级的核心指标**：GPU 填充率（像素带宽）、内存占用、发热量；常见分三档 Low / Medium / High
3. **URP Asset 是现代质量分级的载体**：每个 Quality Level 绑定一个 URP Asset，内含渲染精度、阴影级联、MSAA、渲染缩放等配置
4. **运行时可动态切换 Quality Level**：`QualitySettings.SetQualityLevel(index, applyExpensiveChanges)`，但某些变更（如纹理压缩格式）需要重新加载场景
5. **设备检测 + 自动适配**：通过 `SystemInfo` 获取 GPU 型号、内存大小、填充率，启动时自动选择合适档位

### 📖 深度展开

#### QualitySettings 配置结构

```
Project Settings → Quality
├── Quality Level 0: Very Low   ← 低端 Android (Ram < 3GB)
│   ├── URP_Low.asset
│   ├── Pixel Light Count: 0
│   ├── Shadow Cascades: 0
│   └── Texture Size: 512
├── Quality Level 1: Low        ← 中低端设备
│   ├── URP_Medium.asset
│   ├── Pixel Light Count: 1
│   └── Texture Size: 1024
├── Quality Level 2: Medium     ← 中高端设备
│   ├── URP_High.asset
│   ├── Shadow Cascades: 2
│   └── MSAA: 2x
├── Quality Level 3: High       ← 旗舰设备
│   ├── URP_Ultra.asset
│   ├── Shadow Cascades: 4
│   ├── MSAA: 4x
│   └── Render Scale: 1.0
└── Quality Level 4: Ultra      ← PC / Console
```

#### URP Asset 中影响性能的关键参数

| 参数 | Low | Medium | High | 性能影响 |
|------|-----|--------|------|---------|
| Render Scale | 0.75x | 0.9x | 1.0x | GPU 填充率 ×（平方关系） |
| HDR | Off | Off | On | 带宽 +30% |
| MSAA | Disabled | 2x | 4x | GPU 填充率 |
| Shadow Distance | 15m | 30m | 50m | DrawCall + GPU |
| Shadow Cascades | 0 | 2 | 4 | DrawCall |
| Main Light Shadows | Disabled | Soft | Soft | GPU 纹理采样 |
| Additional Lights | Off | Per-Pixel (limit 2) | Per-Pixel (limit 4) | Fragment 开销 |
| Post Processing | Minimal | Standard | Full | 全屏 Pass 数 |

#### 设备自动适配实现

```csharp
public class QualityAutoSelector : MonoBehaviour
{
    [SerializeField] private int lowThreshold = 2500;   // GFLOPS
    [SerializeField] private int highThreshold = 8000;  // GFLOPS

    void Awake()
    {
        int qualityIndex = DetermineQualityLevel();
        QualitySettings.SetQualityLevel(qualityIndex, applyExpensiveChanges: true);
        Debug.Log($"[Quality] 设备: {SystemInfo.graphicsDeviceName}, " +
                  $"GPU: {SystemInfo.graphicsPixelFillrate} fillrate, " +
                  $"选定档位: {QualitySettings.names[qualityIndex]}");
    }

    private int DetermineQualityLevel()
    {
        // 综合判断：GPU 算力 + 内存 + 屏幕分辨率
        int gpuScore = EstimateGpuTier();
        int ramGB = SystemInfo.systemMemorySize / 1024;
        float screenPixels = (float)Screen.width * Screen.height / 1_000_000f;

        // 像素面积惩罚：高分辨率屏幕需要更强的 GPU
        if (screenPixels > 4f && gpuScore < 3) gpuScore--;

        if (gpuScore <= 1 || ramGB < 3) return 0;       // Very Low
        if (gpuScore <= 2 || ramGB < 4) return 1;       // Low
        if (gpuScore <= 3) return 2;                     // Medium
        return 3;                                        // High
    }

    private int EstimateGpuTier()
    {
        // 基于 GPU 名称关键字粗略估算
        string gpu = SystemInfo.graphicsDeviceName.ToLower();
        if (gpu.Contains("adreno")) {
            if (gpu.Contains("740") || gpu.Contains("750")) return 4;  // Adreno 740+
            if (gpu.Contains("730")) return 3;
            if (gpu.Contains("6")) return 2;
            return 1;
        }
        if (gpu.Contains("mali")) {
            if (gpu.Contains("g715") || gpu.Contains("g720")) return 4;
            if (gpu.Contains("g78")) return 3;
            return 2;
        }
        // Apple A-Series / M-Series
        if (gpu.Contains("apple")) {
            if (gpu.Contains("apple6") || gpu.Contains("apple7") ||
                gpu.Contains("apple8") || gpu.Contains("apple9")) return 4;
            return 3;
        }
        return 2; // 默认中等
    }
}
```

#### Render Scale 与动态分辨率

```csharp
// URP 下动态调整 Render Scale 实现自适应画质
// 当帧率低于阈值时降低渲染分辨率，高于阈值时恢复
public class AdaptiveResolution : MonoBehaviour
{
    [SerializeField] private float minScale = 0.6f;
    [SerializeField] private float maxScale = 1.0f;
    [SerializeField] private float targetFrameTime = 1000f / 60f; // 60 FPS

    private UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset urpAsset;

    void Start()
    {
        urpAsset = QualitySettings.GetQualityLevel() switch
        {
            0 => lowQualityURP,
            1 => mediumQualityURP,
            _ => highQualityURP,
        };
    }

    void Update()
    {
        float currentFrameTime = Time.unscaledDeltaTime * 1000f;

        if (currentFrameTime > targetFrameTime * 1.2f)
        {
            // 掉帧了，降低渲染分辨率
            float newScale = Mathf.Max(minScale, urpAsset.renderScale - 0.02f);
            urpAsset.renderScale = newScale;
        }
        else if (currentFrameTime < targetFrameTime * 0.8f)
        {
            // 帧率有余量，提升分辨率
            float newScale = Mathf.Min(maxScale, urpAsset.renderScale + 0.01f);
            urpAsset.renderScale = newScale;
        }
    }
}
```

### ⚡ 实战经验

1. **`applyExpensiveChanges` 参数别乱传 true**：它会导致纹理重新加载、Shader 重新编译，掉帧严重；推荐只在场景切换时传 true，游戏中动态调整只传 false
2. **低端机的瓶颈往往是发热而非帧率**：表面 60 FPS，但设备持续发烫导致 SoC 降频，5 分钟后帧率断崖；需要用 Perfa 可以做 10 分钟以上的持续监控
3. **Render Scale 是最划算的性能开关**：从 1.0 降到 0.75，GPU 填充率负载直接降低 ~44%，画面只是轻微模糊，比关阴影、降纹理的性价比高得多
4. **每个 Quality Level 要配对应的纹理压缩格式**：低端机用 ASTC 6x6、高端机用 ASTC 4x4；不能统一格式——低端机解压慢、内存不够，高端机模糊

### 🔗 相关问题

- URP 的 Render Scale 和 Unity 的 Dynamic Resolution 有什么区别？
- 如何在运行时安全地切换 URP Asset？
- 移动端 GPU 填充率怎么估算和监控？
