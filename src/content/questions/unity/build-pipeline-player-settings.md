---
title: "Unity Build 流程详解：从 BuildPipeline 到 Player Settings，多平台构建配置与自动化打包"
category: "unity"
level: 2
tags: ["构建打包", "CI/CD", "Player Settings", "面试高频"]
related: ["unity/il2cpp-build-optimization", "unity/shader-variant-stripping", "unity/texture-compression-platform"]
hint: "Unity 的 Build 过程不仅仅是点一个按钮——IL2CPP、Stripping Level、Scripting Backend、多平台纹理压缩格式，每个选择都影响包体和性能。"
---

## 参考答案

### ✅ 核心要点

1. **BuildPipeline.BuildPlayer** 是自动化构建的核心 API，可以实现命令行批处理打包
2. **Scripting Backend** 选择（Mono vs IL2CPP）直接影响性能、包体和热更新方案
3. **Managed Stripping Level** 控制 C# 代码裁剪程度，影响包体但可能误删反射调用的代码
4. **Player Settings** 中的平台设置（纹理压缩、架构、API 兼容级别）需要针对 Android/iOS 分别优化
5. CI/CD 通常通过 `-batchmode -nographics -executeMethod` 命令行参数实现无人值守构建

### 📖 深度展开

#### Unity Build 流程全景

```
开发者点击 Build / CI 触发
    ↓
[1] 资源收集与依赖分析
    ├── 场景列表（Scene In Build）
    ├── Resources/ 目录（全量打包）
    ├── StreamingAssets/（原样复制）
    └── Addressables / AssetBundle（按需）
    ↓
[2] 脚本编译
    ├── Scripting Backend: Mono → DLL 直接打包
    ├── Scripting Backend: IL2CPP → C# → C++ → Native 编译
    └── Strip 未引用代码（Managed Stripping）
    ↓
[3] 资源序列化与压缩
    ├── 纹理压缩格式（ETC2/ASTC/BC7）
    ├── 音频压缩（Vorbis/MP3/ADPCM）
    └── Shader 编译与变体裁剪
    ↓
[4] 平台特定处理
    ├── Android: Gradle 构建 → APK/AAB
    ├── iOS: Xcode 工程 → 手动/自动编译 IPA
    └── Windows: 直接生成 exe + Data 文件夹
    ↓
[5] 签名与导出
    ├── Android: Keystore 签名
    └── iOS: Provisioning Profile + 证书签名
    ↓
最终产物（APK / AAB / IPA / exe）
```

#### Scripting Backend 对比

| 维度 | Mono | IL2CPP |
|------|------|--------|
| 编译产物 | .NET DLL | C++ → 原生机器码 |
| 性能 | 较低（JIT/解释执行） | 较高（AOT 编译） |
| 包体 | 小 | 大（含 C++ 中间层） |
| 编译速度 | 快 | 慢（C++ 编译耗时） |
| 热更新 | 支持（反射直接可用） | 需额外方案（HybridCLR） |
| 反调试 | 弱 | 强 |
| iOS 必须 | ❌ | ✅（Apple 不允许 JIT） |
| Android 推荐 | 原型阶段 | ✅ 生产环境 |

#### Managed Stripping Level 详解

```csharp
// ⚠️ High/Medium Stripping 会删除看似"未使用"的代码
// 如果通过反射调用，必须保护：

// 方法1：link.xml 显式保留
// Assets/link.xml
<linker>
  <assembly fullname="MyGameAssembly" preserve="all"/>
  <assembly fullname="System">
    <type fullname="System.Reflection.Assembly" preserve="all"/>
  </assembly>
</linker>

// 方法2：[Preserve] 特性（IL2CPP 专用）
using UnityEngine.Scripting;

[Preserve]
public class ConfigManager
{
    [Preserve]
    public void LoadFromReflection() { ... }
}

// 方法3：SuppressUnusedWarning（不推荐，治标不治本）
```

| Stripping Level | 效果 | 风险 | 适用场景 |
|----------------|------|------|----------|
| Disabled | 不裁剪 | 包体最大 | 开发阶段 |
| Minimal | 裁剪明显未引用的 | 低 | 快速测试 |
| Low | 裁剪未引用 + 部分 | 中 | 谨慎生产 |
| Medium | 积极裁剪 | 中高 | 包体敏感项目 |
| High | 最大程度裁剪 | 高（可能误删） | 仅在充分测试时 |

#### 命令行自动化构建

```csharp
using UnityEditor;
using UnityEngine;

public static class BuildScript
{
    public static void BuildAndroid()
    {
        string[] scenes = new[]
        {
            "Assets/Scenes/Main.unity",
            "Assets/Scenes/Battle.unity",
        };

        var buildOptions = BuildOptions.None;
        // buildOptions |= BuildOptions.Development;  // Development Build
        // buildOptions |= BuildOptions.ConnectWithProfiler; // 自动连接 Profiler

        string outputPath = "Builds/Android/MyGame.aab";

        var report = BuildPipeline.BuildPlayer(
            scenes,
            outputPath,
            BuildTarget.Android,
            buildOptions
        );

        if (report.summary.result == BuildResult.Succeeded)
        {
            Debug.Log($"Build 成功: {outputPath}, 大小: {report.summary.totalSize / 1024 / 1024}MB");
        }
        else
        {
            Debug.LogError($"Build 失败: {report.summary.result}");
            EditorApplication.Exit(1); // CI 中返回非零退出码
        }
    }

    public static void BuildiOS()
    {
        // iOS 特有设置
        PlayerSettings.iOS.targetDevice = iOSTargetDevice.iPhoneAndiPad;
        PlayerSettings.iOS.cameraUsageDescription = "用于AR功能";
        PlayerSettings.SetArchitecture(BuildTargetGroup.iOS, 1); // ARM64 only

        string outputPath = "Builds/iOS/XcodeProject";

        BuildPipeline.BuildPlayer(
            EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray(),
            outputPath,
            BuildTarget.iOS,
            BuildOptions.None
        );
    }
}
```

```bash
# CI/CD 中调用（Jenkins / GitHub Actions / GitLab CI）
Unity.exe \
  -batchmode \
  -nographics \
  -projectPath . \
  -executeMethod BuildScript.BuildAndroid \
  -logFile build.log \
  -quit

echo "Exit code: $?"
```

#### Android 构建架构选择

```
ARMv7 (32-bit)   → 兼容性最广，但逐步被淘汰
ARM64 (64-bit)   → ✅ 必须支持，Google Play 强制要求
x86 / x86_64     → 模拟器用，正式包一般不包含

推荐：Build Settings → Architecture → "ARM64" only
Google Play 自 2019 年起强制要求 64-bit APK
```

#### 纹理压缩格式策略

| 平台 | 推荐格式 | 备注 |
|------|---------|------|
| Android | ETC2 (默认) / ASTC (推荐) | ASTC 质量更好但需设备支持 |
| iOS | ASTC | Apple 全系支持 ASTC |
| WebGL | DXT5 / ASTC | 取决于浏览器 GPU |
| Windows | BC7 / DXT5 | 桌面 GPU 通用支持 |

```
# Asset PostProcessor 自动设置纹理压缩格式
public class TextureImportSettings : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (EditorUserBuildSettings.activeBuildTarget == BuildTarget.Android)
        {
            TextureImporterPlatformSettings android = new()
            {
                name = "Android",
                androidFormat = TextureImporterFormat.ASTC_6x6,
                maxTextureSize = 2048,
                compressionQuality = TextureCompressionQuality.Normal
            };
            AssetImporter.GetAtPath(assetPath).SetPlatformTextureSettings(android);
        }
    }
}
```

### ⚡ 实战经验

- **IL2CPP + High Stripping 是包体优化的黄金组合**，但一定要在 CI 中加入自动化反射测试，防止裁剪误删运行时代码导致线上崩溃
- **Build 的 Development 版本和 Release 版本性能差异可达 30-50%**：Development Build 会保留 symbol 和 Profiler hook，测试性能数据一定要用 Release Build
- **Shader Variant 是包体杀手**：一个简单的 Standard Shader 在多灯光/多平台下可能产生数千个变体，占数百 MB。使用 `ShaderVariantCollection` 手动管理 + `IPreprocessShaders` 接口做变体裁剪
- **CI 缓存 Library 目录**：Unity 首次导入资源可能需要 10-30 分钟，CI 中缓存 `Library/` 目录可以将后续构建时间缩短到 2-5 分钟

### 🔗 相关问题

- IL2CPP 的转换原理是什么？它如何影响性能和安全性？
- 如何减小 APK/AAB 包体？（纹理压缩、代码裁剪、AssetBundle 按需下载）
- Unity Cloud Build 和自建 CI 各有什么优劣？
