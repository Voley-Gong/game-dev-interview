---
title: "Unity Shader有哪些类型？Shader、Material和Texture的关系是什么？"
category: "unity"
level: 2
tags: ["Shader", "材质", "渲染", "URP"]
related: ["unity/urp-render-pipeline", "unity/drawcall-batching"]
hint: "从Fixed Function到Shader Graph，从Texture到Material Instance——理清渲染资源的层级关系"
---

## 参考答案

### ✅ 核心要点

1. **Shader 类型**：Unlit Shader、Vertex/Fragment Shader、Surface Shader（内置管线）、Shader Graph（URP/HDRP）、Compute Shader
2. **Shader → Material → Renderer 三层关系**：Shader 是"算法模板"，Material 是"参数填入"，Renderer 是"挂到物体上执行"
3. **材质实例化（Material Instance）**：多个物体共享同一 Material 不增加 DrawCall；修改单个物体的材质属性会产生 Material Instance（可能破坏合批）
4. **Shader Graph** 是 URP/HDRP 时代的可视化 Shader 编写工具，降低编写门槛
5. **SRP Batcher**：相同 Shader（即相同 CBUFFER 声明）的材质可以合批，不必同材质实例

### 📖 深度展开

#### Shader 类型对比

| 类型 | 管线支持 | 编写方式 | 适用场景 | 难度 |
|------|---------|----------|----------|------|
| Unlit Shader | 内置/URP/HDRP | HLSL/CG | 不受光照的UI、特效 | ⭐ |
| Vertex/Fragment | 内置/URP/HDRP | HLSL/CG | 完全自定义渲染 | ⭐⭐⭐ |
| Surface Shader | 仅内置管线 | CG | 快速写光照交互 | ⭐⭐ |
| Shader Graph | URP/HDRP | 可视化节点 | 标准 PBR、卡通渲染 | ⭐⭐ |
| Compute Shader | 全部 | HLSL | GPU 通用计算、粒子 | ⭐⭐⭐ |

#### 三层资源关系

```
Shader（算法/模板）
  ↓  选择参数值
Material（参数集：贴图、颜色、数值）
  ↓  挂载到
Renderer（MeshRenderer/SkinnedMeshRenderer）
  ↓  提交到
GPU 渲染管线 → DrawCall
```

**一个直观的类比：**

- **Shader** = Excel 模板（定义了公式和格式）
- **Material** = 填了具体数据的 Excel 文件
- **Renderer** = 打印出来贴在物体表面

#### 核心代码示例

**简单的 Vertex/Fragment Shader（URP 兼容）：**

```hlsl
Shader "Custom/SimpleURP"
{
    Properties
    {
        _BaseMap ("Base Texture", 2D) = "white" {}
        _BaseColor ("Base Color", Color) = (1,1,1,1)
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "RenderPipeline"="UniversalPipeline" }
        LOD 100

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode"="UniversalForward" }

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float2 uv          : TEXCOORD0;
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv          : TEXCOORD0;
            };

            TEXTURE2D(_BaseMap);
            SAMPLER(sampler_BaseMap);

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                half4  _BaseColor;
            CBUFFER_END

            Varyings vert(Attributes IN)
            {
                Varyings OUT;
                OUT.positionCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = TRANSFORM_TEX(IN.uv, _BaseMap);
                return OUT;
            }

            half4 frag(Varyings IN) : SV_Target
            {
                half4 texColor = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv);
                return texColor * _BaseColor;
            }
            ENDHLSL
        }
    }
}
```

> **注意 `CBUFFER_START(UnityPerMaterial)`**：这是 SRP Batcher 兼容的关键。所有材质属性必须声明在这个块内，否则 SRP Batcher 失效。

#### Material 的坑：运行时修改属性

```csharp
// ❌ 危险：获得独立 Material Instance，破坏合批
renderer.material.SetColor("_BaseColor", Color.red);

// ✅ 安全：使用 MaterialPropertyBlock，不产生新材质实例
var block = new MaterialPropertyBlock();
block.SetColor("_BaseColor", Color.red);
renderer.SetPropertyBlock(block);
```

**两者的区别：**

| 操作 | 是否产生 Material Instance | 是否破坏 Static Batching | 是否破坏 SRP Batcher |
|------|---------------------------|------------------------|---------------------|
| `renderer.material.SetX()` | ✅ 是 | ✅ 破坏 | ✅ 破坏 |
| `renderer.sharedMaterial` | ❌ 否 | ❌ 安全 | ❌ 安全 |
| `MaterialPropertyBlock` | ❌ 否 | ❌ 安全 | ⚠️ 首次使用有开销 |

#### Shader Graph 工作流

```
创建 → Shader Graph (URP)
  ├── 定义 Properties（贴图、颜色、浮点数）
  ├── 拖拽 Node 连线（UV操作、数学运算、采样）
  ├── 输出到 Vertex / Fragment
  └── 保存 → 自动编译为 .shader
      ↓
创建 Material → 选择该 Shader Graph → 调参 → 赋给 Renderer
```

### ⚡ 实战经验

- **URP 项目优先用 Shader Graph**：可维护性远高于手写 HLSL，非程序员也能调效果
- **`CBUFFER` 声明务必规范**：SRP Batcher 要求所有 Properties 在 `UnityPerMaterial` 块中，遗漏一个就整个 Shader 不兼容
- **MaterialPropertyBlock 也不是免费的**：高频调用仍有开销，必要时自己做属性缓存批处理
- **Shader 变体（Shader Variant）爆炸**：`#pragma multi_compile` 和 `#pragma shader_feature` 组合过多会导致编译变体指数膨胀，影响构建时间和包体

### 🔗 相关问题

- URP 和内置管线的 Shader 可以互相通用吗？
- SRP Batcher 的原理和兼容条件是什么？
- 如何减少 Shader 变体数量（Shader Variant Stripping）？
