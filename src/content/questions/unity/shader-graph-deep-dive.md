---
title: "Unity Shader Graph 的原理、黑板节点与性能考量是什么？"
category: "unity"
level: 2
tags: ["Shader Graph", "URP", "渲染", "可视化编程"]
related: ["unity/urp-render-pipeline", "unity/shader-material-system", "unity/shader-variant-stripping"]
hint: "Shader Graph 生成的到底是什么？它与手写 HLSL 有何优劣？如何避免性能陷阱？"
---

## 参考答案

### ✅ 核心要点

1. **Shader Graph 是可视化节点编辑器**，最终编译生成标准 HLSL Shader 代码，运行时无额外开销
2. 仅支持 **URP 和 HDRP**，不支持内置管线（Built-in RP）
3. 通过 **Blackboard（黑板）** 管理属性（Properties）和关键字（Keywords），生成对应的 Shader Properties
4. 每个 Node 对应一段 HLSL 函数或宏，编译后与手写 Shader 等价
5. 过度使用分支节点（Branch）和关键字（Keyword）会导致 **Shader Variant 爆炸**

### 📖 深度展开

#### Shader Graph 编译流程

```
Shader Graph (.shadergraph JSON)
  ↓ 解析节点拓扑
生成中间 HLSL 代码
  ↓ Shader 编译器 (Shader Compiler)
编译为各平台目标代码
  ├── DX11/DX12 (Windows)
  ├── Metal (macOS/iOS)
  ├── Vulkan (Android)
  ├── GLSL/GLES (WebGL/Fallback)
  └── SPIR-V
  ↓
最终 GPU Shader Program
```

#### 核心概念：Blackboard 属性

| 属性类型 | Shader 中的映射 | 用途 |
|---------|----------------|------|
| Float | `_Float("Name", Float)` | 单值参数 |
| Color | `_Color("Name", Color)` | 颜色 |
| Vector2/3/4 | `_Vector("Name", Vector)` | 向量 |
| Texture2D | `_MainTex("Name", 2D)` | 贴图采样 |
| Texture2D Array | `2DArray` | 序列帧/地形层 |
| Boolean (Keyword) | `#pragma multi_compile` 或 `shader_feature` | 开关分支 |
| Enum (Keyword) | `#pragma multi_compile _ A B C` | 多选枚举 |

#### 关键节点解析

**常用节点及其 HLSL 等价：**

```hlsl
// Sample Texture 2D 节点
float4 color = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv);

// Lerp 节点
float3 result = lerp(valueA, valueB, t);

// Smoothstep 节点
float edge = smoothstep(min, max, x);

// Fresnel Effect 节点
float fresnel = pow(1.0 - saturate(dot(normalWS, viewDir)), power);

// Normal From Texture 节点
float3 normalTS = UnpackNormal(SAMPLE_TEXTURE2D(_NormalMap, sampler_NormalMap, uv));

// Blend 节点（Normal 模式）
float3 blendedNormal = NormalizeBlendNormal(normalA, normalB);
```

#### Shader Graph vs 手写 HLSL

| 维度 | Shader Graph | 手写 HLSL |
|------|-------------|----------|
| 学习曲线 | 低，可视化拖拽 | 高，需理解渲染管线 |
| 迭代速度 | 快，实时预览 | 中，需编译等待 |
| 性能 | 中等，可能产生冗余代码 | 最优，可手动精简 |
| 版本控制 | 差（大段 JSON diff） | 好（文本 diff） |
| 自定义渲染 | 受限于节点库 | 完全自由（Custom Function 节点可嵌入） |
| 团队协作 | 适合美术/TA | 适合图形程序员 |
| 调试难度 | 高（节点图复杂时难以追踪） | 中（可用 RenderDoc / Frame Debugger） |

#### Custom Function 节点：突破节点限制

当节点库不够用时，可以在 Shader Graph 中直接嵌入 HLSL：

```hlsl
// Custom Function 节点 - String 模式
// 输入: UV (Vector2), Time (Float)
// 输出: Color (Vector3)

float2 distortedUV = UV + sin(UV.yx * 10.0 + Time) * 0.02;
float3 col = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, distortedUV).rgb;
Out = col;
```

也可以引用外部 `.hlsl` 文件：

```csharp
// Custom Function 节点 - File 模式
// File: Assets/Shaders/Noise.hlsl
// Function: GradientNoise(float2 uv)
```

#### SubGraph：复用与模块化

```
主 Shader Graph
├── PBR Master (输出节点)
│   ├── Albedo ← [SubGraph: LayeredTexture]
│   │                  ├── Texture A + Mask
│   │                  └── Texture B + Mask
│   ├── Normal ← [SubGraph: BlendNormals]
│   └── Emission ← [SubGraph: PulseGlow]
```

SubGraph 可以定义自己的输入/输出端口，在不同 Shader 中复用，类似函数封装。

#### Shader Variant 爆炸问题

```
1 个 Boolean Keyword → 2 个 Variant
1 个 Enum (4选项) Keyword → 4 个 Variant
组合使用: 2 × 2 × 2 × 4 = 32 个 Variant！

每个 Variant 都需要：
  - 编译时间（构建变慢）
  - 内存（Shader Cache）
  - 磁盘空间（包体变大）
```

优化策略：
- 使用 `shader_feature` 而非 `multi_compile`（只编译用到的关键字组合）
- 使用 `Toggle Off` 让关键字有默认关闭态
- 在 Project Settings → Graphics → Shader Stripping 中配置剥离规则

### ⚡ 实战经验

- **Shader Graph 生成的代码通常比手写 HLSL 冗余 10%-30%**，在对性能极其敏感的移动端，关键 Shader 建议手写 HLSL 并用 RenderDoc 对比生成的指令数
- **节点连线混乱是 Shader Graph 最大的维护噩梦**：养成用 Sticky Note 分组注释的习惯，将 Albedo/Normal/Emission 区域用颜色框分隔
- **Properties 重命名会导致所有引用断开**：Shader Graph 没有"安全重命名"功能，重命名前确认该属性未被 SubGraph 引用；版本升级时尤其要注意
- **使用 Frame Debugger 验证实际渲染效果**：Shader Graph 预览窗口有时与实际渲染有差异（尤其是光照和阴影相关节点），始终在 Game 视图中验证

### 🔗 相关问题

- URP 中如何通过 ScriptableRenderFeature 注入自定义渲染 Pass？
- Shader Keyword 和 Shader Variant 的关系是什么？如何做 Variant Stripping？
- 如何在 Shader Graph 中实现多光源支持？URP 的光照模型是怎样的？
