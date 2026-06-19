---
title: "手写 Unity Shader：ShaderLab 语法、Surface Shader 与 Vertex/Fragment Shader 的区别和实现"
category: "unity"
level: 3
tags: ["渲染管线", "Shader", "ShaderLab", "HLSL", "面试高频"]
related: ["unity/shader-material-system", "unity/shader-graph-deep-dive", "unity/urp-render-pipeline"]
hint: "ShaderLab 是 Unity 的 Shader 描述语言包装，内层是 HLSL/CG。面试常要求手写一个简单的漫反射或边缘光 Shader。"
---

## 参考答案

### ✅ 核心要点

1. **ShaderLab** 是 Unity 的 Shader 描述外壳，用 `Shader "Name" { Properties { ... } SubShader { ... } }` 结构组织
2. **Surface Shader** 是 Unity 的语法糖，自动处理光照计算，适合快速实现标准材质效果
3. **Vertex/Fragment Shader** 是最底层的控制，手动处理顶点变换和像素着色，灵活度最高
4. Properties 块定义材质面板上的可调参数，通过 `[Property]` 特性控制显示方式
5. URP/HDRP 时代推荐使用 HLSLPROGRAM 而非 CGPROGRAM，且 Surface Shader 在 URP 中不再支持

### 📖 深度展开

#### ShaderLab 基本结构

```
Shader "Custom/MyShader"
{
    Properties
    {
        _MainTex ("Albedo", 2D) = "white" {}
        _Color ("Tint Color", Color) = (1,1,1,1)
        _Glossiness ("Smoothness", Range(0,1)) = 0.5
        [HideInInspector] _SrcBlend ("Src Blend", Float) = 1
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        LOD 200

        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            // ... HLSL 代码
            ENDHLSL
        }
    }

    FallBack "Diffuse"
}
```

#### 三种 Shader 类型对比

| 维度 | Surface Shader | Vertex/Fragment | Fixed Function |
|------|---------------|-----------------|----------------|
| 抽象层级 | 高（自动光照） | 低（手动控制） | 已废弃 |
| 代码量 | 少 | 中-多 | — |
| 光照支持 | 自动多光源 | 手动实现 | 基本光照 |
| URP 支持 | ❌ 不支持 | ✅ 完全支持 | ❌ |
| 移动端性能 | 偏重 | 最优 | — |
| 适用场景 | Built-in 管线复杂材质 | 所有管线，自定义效果 | — |
| 面试重点 | 理解原理 | 手写代码 | 了解历史 |

#### 手写：Vertex/Fragment 漫反射 Shader（URP 兼容）

```hlsl
Shader "Custom/SimpleDiffuse"
{
    Properties
    {
        _BaseColor ("Base Color", Color) = (1, 1, 1, 1)
        _MainTex ("Texture", 2D) = "white" {}
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "Opaque"
            "RenderPipeline" = "UniversalPipeline"
            "Queue" = "Geometry"
        }

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS_CASCADE

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float2 uv         : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 normalWS   : TEXCOORD1;
                float2 uv         : TEXCOORD0;
            };

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseColor;
                float4 _MainTex_ST;
            CBUFFER_END

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            Varyings vert(Attributes input)
            {
                Varyings output;
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.normalWS   = TransformObjectToWorldNormal(input.normalOS);
                output.uv         = input.uv * _MainTex_ST.xy + _MainTex_ST.zw;
                return output;
            }

            half4 frag(Varyings input) : SV_Target
            {
                // 主光源信息
                Light mainLight = GetMainLight();
                float3 N = normalize(input.normalWS);
                float3 L = mainLight.direction;

                // Lambert 漫反射
                float NdotL = saturate(dot(N, L));
                half3 diffuse = NdotL * mainLight.color;

                // 环境光
                half3 ambient = half3(0.2, 0.2, 0.2);

                // 采样纹理并混合
                half4 texColor = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.uv);
                half3 finalColor = (diffuse + ambient) * texColor.rgb * _BaseColor.rgb;

                return half4(finalColor, 1.0);
            }
            ENDHLSL
        }
    }
}
```

#### 关键概念图解

```
GPU 渲染一个三角形的过程：

顶点数据 (Vertex Buffer)
    ↓
  [Vertex Shader]  ← 对每个顶点执行：坐标变换、法线变换、UV 传递
    ↓
  光栅化 (Rasterizer) ← 三角形 → 像素，插值生成 Varyings
    ↓
  [Fragment Shader] ← 对每个像素执行：纹理采样、光照计算、颜色输出
    ↓
  深度测试 / 混合 → 帧缓冲
```

#### CBUFFER 与 SRP Batcher 兼容

```hlsl
// ✅ URP/HDRP 中必须使用 CBUFFER_START(UnityPerMaterial) 才能兼容 SRP Batcher
CBUFFER_START(UnityPerMaterial)
    float4 _BaseColor;
    float4 _MainTex_ST;
    float  _Smoothness;
CBUFFER_END

// ❌ 错误：直接声明全局变量会破坏 SRP Batcher
// float4 _BaseColor;  // 不在 CBUFFER 内 → SRP Batcher 失效 → DrawCall 无法合批
```

#### 常用 Properties 特性标签

| 特性 | 作用 | 示例 |
|------|------|------|
| `[HDR]` | 允许 >1 的高亮颜色 | `[HDR] _Emission` |
| `[HideInInspector]` | 在 Inspector 中隐藏 | `[HideInInspector] _SrcBlend` |
| `[NoScaleOffset]` | 隐藏 Tiling/Offset | `[NoScaleOffset] _MainTex` |
| `[Normal]` | 标记为法线贴图 | `[Normal] _BumpMap` |
| `[Toggle]` | 显示为开关 | `[Toggle] _UseFog` |
| `[Enum]` | 下拉菜单 | `[Enum(UnityEngine.Rendering.BlendMode)]` |
| `[Header("Group")]` | 分组标题 | `[Header("Lighting")]` |

### ⚡ 实战经验

- **面试手写 Shader 时优先写 Vertex/Fragment**，因为 URP 是主流且 Surface Shader 已不被推荐。面试官更看重你对渲染管线的理解而非语法糖
- **SRP Batcher 兼容是必考项**：所有材质参数必须在 `CBUFFER_START(UnityPerMaterial)` 内，否则无法合批，在移动端可能导致 DrawCall 翻倍
- **变体控制（Shader Variant）**：`#pragma multi_compile` 会生成大量 Shader 变体导致包体膨胀和编译缓慢。用 `#pragma shader_feature` 代替可以只编译用到的变体
- **移动端 Shader 精度**：优先用 `half` 而非 `float`，在移动 GPU 上 `half` 可能使用 16-bit 运算，性能提升显著。位置坐标必须用 `float`，颜色和方向可以用 `half`

### 🔗 相关问题

- URP 中如何使用 Render Feature 实现自定义后处理效果？
- Shader Graph 和手写 Shader 各有什么优劣？什么时候选哪个？
- Shader 变体过多导致包体膨胀怎么解决？（keyword stripping、shader_variant_collection）
