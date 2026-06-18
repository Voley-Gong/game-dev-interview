---
title: "Unity Shader 变体（Shader Variant）为什么会爆炸？如何收集和裁剪？"
category: "unity"
level: 3
tags: ["Shader", "Shader Variant", "构建优化", "性能优化"]
related: ["unity/shader-material-system", "unity/urp-render-pipeline"]
hint: "multi_compile 和 shader_feature 的组合爆炸是包体膨胀和编译缓慢的元凶。"
---

## 参考答案

### ✅ 核心要点

1. **Shader 变体 = 同一 Shader 的不同编译版本**：每条 `#pragma multi_compile` / `#pragma shader_feature` 关键字组合都会生成一个独立变体
2. **组合爆炸问题**：N 个独立关键字的变体数为 2^N；互相组合时数量指数膨胀，导致构建时间暴增、包体虚胖
3. **收集方法**：`ShaderVariantCollection` 运行时记录实际使用的变体；IPreprocessShaders 接口在构建阶段拦截和分析
4. **裁剪策略**：精确声明关键字（`shader_feature` 替代 `multi_compile`）、使用 `multi_compile_local`/`shader_feature_local`（限制全局变体数）、编辑器脚本剥离未使用变体
5. **实战效果**：合理的变体裁剪可将包体减少数百 MB，构建时间从小时级降到分钟级

### 📖 深度展开

#### 变体是怎么产生的

```hlsl
// 每一行 #pragma 都会产生变体分支
#pragma multi_compile _ _MAIN_LIGHT_SHADOWS
#pragma multi_compile _ _ADDITIONAL_LIGHTS
#pragma multi_compile _ _SHADOWS_SOFT
#pragma shader_feature _ _ALPHATEST_ON
#pragma shader_feature _ _EMISSION
```

上面的 5 行声明会生成多少变体？

```
multi_compile 产生的变体是全排列组合：
  _MAIN_LIGHT_SHADOWS:  2 个选项
  _ADDITIONAL_LIGHTS:   2 个选项
  _SHADOWS_SOFT:        2 个选项
  _ALPHATEST_ON:        2 个选项
  _EMISSION:            2 个选项

总变体数 = 2 × 2 × 2 × 2 × 2 = 32 个变体
```

如果再来 5 行类似的声明，变体数就会变成 32 × 32 = **1024 个**。一个中等复杂度的 URP Shader 很容易产生上千个变体。

#### `multi_compile` vs `shader_feature` 对比

| 特性 | `multi_compile` | `shader_feature` |
|------|-----------------|-------------------|
| 变体生成 | 所有组合全部编译 | 仅编译被材质引用的变体 |
| 全局性 | 全局变体（所有 Shader 共享关键字空间） | 局限于当前 Shader |
| 适用场景 | 光照、雾效等引擎级全局开关 | 材质级开关（如 Alpha Test、Emission） |
| 构建裁剪 | 不会被自动裁剪（除非 IPrebuiltShader） | 未被材质引用的变体会被裁剪 |
| 关键字上限 | 全局 256 个（URP 已用 ~60+） | 独立计算 |

**`_local` 后缀变体：**

```hlsl
// 全局变体（占用全局关键字配额 256 个）
#pragma multi_compile _ _FOG_ON

// 局部变体（不占用全局配额，每个 Shader 独立 64 个）
#pragma multi_compile_local _ _CUSTOM_FOG
#pragma shader_feature_local _ _DISSOLVE_ON
```

> **最佳实践**：优先使用 `_local` 版本，避免耗尽全局关键字配额（超过上限会导致编译错误）。

#### 变体收集：ShaderVariantCollection

在运行时记录实际使用到的变体，用于后续构建时只保留这些变体：

```csharp
using UnityEngine;
using UnityEditor;
using System.Collections.Generic;

public class ShaderVariantCollector : MonoBehaviour
{
    public Shader targetShader;
    public string savePath = "Assets/ShaderVariants/Collected.shadervariants";

    private HashSet<ShaderVariantCollection.ShaderVariant> _collected = new();

    // 项目运行期间调用此方法记录变体
    public void RecordVariant(
        PassType passType, string[] keywords)
    {
        var variant = new ShaderVariantCollection.ShaderVariant(
            targetShader, passType, keywords);

        if (_collected.Add(variant))
        {
            Debug.Log($"[VariantCollector] 新变体: " +
                $"{string.Join("+", keywords)} ({passType})");
        }
    }

    // 在编辑器中将收集到的变体保存为 .shadervariants 文件
#if UNITY_EDITOR
    [ContextMenu("Save Collected Variants")]
    void SaveCollected()
    {
        var collection = new ShaderVariantCollection();
        int count = 0;

        foreach (var variant in _collected)
        {
            if (collection.Add(varvariant))
                count++;
        }

        AssetDatabase.CreateAsset(collection, savePath);
        AssetDatabase.SaveAssets();
        Debug.Log($"[VariantCollector] 保存 {count} 个变体到 {savePath}");
    }
#endif
}
```

#### 构建时自动裁剪：IPreprocessShaders

在构建阶段拦截 Shader 编译，根据白名单/规则跳过不需要的变体：

```csharp
#if UNITY_EDITOR
using UnityEngine;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using System.Collections.Generic;

public class ShaderVariantStripper : IPreprocessShaders
{
    // 需要保留的关键字组合白名单
    private static readonly HashSet<string> _allowedKeywords = new()
    {
        "_MAIN_LIGHT_SHADOWS",
        "_SHADOWS_SOFT",
        "_ADDITIONAL_LIGHT_SHADOWS",
        // ... 只保留实际需要的
    };

    public int callbackOrder => 0;

    public void OnPreprocessShader(
        Shader shader, ShaderSnippetData snippet, IList<ShaderCompilerData> data)
    {
        // 跳过 URP 标准 Shader（保留全部变体）
        if (shader.name.Contains("Universal Render Pipeline/"))
            return;

        int originalCount = data.Count;

        for (int i = data.Count - 1; i >= 0; i--)
        {
            var keywordSet = data[i].ShaderKeywordSet;
            var keywords = keywordSet.GetShaderKeywords();

            bool shouldStrip = false;
            foreach (var kw in keywords)
            {
                string kwName = kw.ToString().Replace("KEYWORD_", "");
                if (!_allowedKeywords.Contains(kwName))
                {
                    shouldStrip = true;
                    break;
                }
            }

            if (shouldStrip)
                data.RemoveAt(i);
        }

        if (data.Count != originalCount)
        {
            Debug.Log($"[VariantStripper] {shader.name} ({snippet.PassType}): " +
                $"{originalCount} → {data.Count} 个变体 " +
                $"(裁剪 {originalCount - data.Count} 个)");
        }
    }
}
#endif
```

#### 变体数量分析流程

```
Step 1: 统计当前项目的 Shader 变体总数
  ├── 使用 Editor 工具遍历所有 Shader
  ├── 调用 ShaderUtil.GetShaderVariantCount() 获取精确数量
  └── 输出报告：Shader 名 → 变体数

Step 2: 识别变体大户
  ├── 排序找出变体最多的 Shader
  └── 目标：单个 Shader 变体数 < 200

Step 3: 精确收集
  ├── 在目标设备上跑完所有关卡/场景
  ├── ShaderVariantCollection 记录实际使用变体
  └── 通常实际使用量仅为总变体的 10%~30%

Step 4: 配置裁剪规则
  ├── 将 shader_feature 替代 multi_compile
  ├── 使用 _local 版本限制全局配额
  ├── IPreprocessShaders 构建时裁剪
  └── Shader Variant Collection 作为白名单
```

### ⚡ 实战经验

1. **URP 默认 Shader 的变体是最大的「隐形胖子」**：URP/Lit Shader 在启用所有特性后可产生 1000+ 变体。一个空 URP 项目的 Shader 变体可能就有 5000-8000 个，占据 50-100MB 包体。用 `ShaderUtil.GetShaderVariantCount` 做一次全面审计
2. **`shader_feature` 的坑**：`shader_feature` 只编译材质引用的变体——但如果某个变体从未被任何材质引用，运行时动态启用该关键字会直接变成粉色材质（编译缺失）。确保所有需要运行时切换的特性用 `multi_compile` 或确保材质预设覆盖
3. **使用 Shader Variant Collection 预热**：即便裁剪了变体，首次渲染使用新变体时仍会卡顿（JIT 编译）。在 Loading 场景中用 `ShaderVariantCollection.WarmUp()` 预编译所有变体，避免游戏中突然卡帧
4. **IPreprocessShaders 的执行顺序**：`callbackOrder` 值越小越先执行。如果有多个 Shader 处理器，注意顺序冲突。建议将自定义的裁剪器设为较高优先级（值较小），在引擎内置裁剪之前拦截

### 🔗 相关问题

- 如何统计项目中所有 Shader 的变体总数并输出报告？
- URP 的 Shader 关键字（Keyword）系统有哪些最佳实践？
- Shader 变体预热（Warm-up）在移动端如何做才能不卡 Loading？
