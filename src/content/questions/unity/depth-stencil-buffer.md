---
title: "Unity 深度缓冲与模板缓冲的原理是什么？ZTest、ZWrite、Stencil 指令如何使用？"
category: "unity"
level: 3
tags: ["渲染管线", "深度缓冲", "模板缓冲", "Shader", "URP"]
related: ["unity/shader-material-system", "unity/urp-render-pipeline", "unity/shaderlab-handwritten-shader"]
hint: "ZTest 和 ZWrite 各自控制什么？Stencil 指令能实现哪些渲染效果？"
---

## 参考答案

### ✅ 核心要点

1. **深度缓冲（Z-Buffer / Depth Buffer）**：存储每个像素的深度值（Z值），用于解决遮挡问题——离摄像机近的像素覆盖远的像素
2. **ZWrite 控制写入**：`ZWrite On` 将当前片元的深度写入缓冲；`ZWrite Off` 则不写入（透明物体通常关闭）
3. **ZTest 控制比较**：默认 `ZTest LEqual`（小于等于才通过），决定了当前片元是否覆盖已有的像素
4. **模板缓冲（Stencil Buffer）**：一个额外的整数缓冲区（通常 8-bit），可通过 Shader 指令读写，用于实现轮廓描边、传送门、溶解遮罩等高级效果
5. **渲染顺序至关重要**：不透明物体由引擎自动按 Front-to-Back 排序（利用 Early-Z 剔除优化），透明物体按 Back-to-Front 排序（必须关闭 ZWrite）

### 📖 深度展开

#### 深度缓冲工作原理

GPU 在执行片元着色器之前（Pre-Fragment 阶段），会先做深度测试：

```
片元进入深度测试
  ↓
读取 Depth Buffer 中当前位置的 Z 值（Zbuffer）
  ↓
比较：当前片元 Z 值 (Zfragment) vs Zbuffer
  ↓ 取决于 ZTest 操作符
  ├── 通过 → 执行片元着色器 → 写入颜色缓冲
  │                    ↓ (如果 ZWrite On)
  │                    更新 Depth Buffer
  └── 失败 → 丢弃片元（跳过着色器）
```

**Early-Z（提前深度测试）优化**：当 Shader 未修改深度（未使用 `clip()` 或 `discard`），GPU 可以在片元着色器之前做深度测试，直接剔除被遮挡片元，大幅减少 Overdraw。

#### ShaderLab 中的深度指令

```shaderlab
// URP Shader 中的深度配置
Shader "Custom/DepthDemo"
{
    SubShader
    {
        // Queue 决定渲染顺序
        Tags { "Queue" = "Geometry" }  // 不透明队列 (2000)

        Pass
        {
            // 深度写入：开（不透明物体默认）
            ZWrite On
            
            // 深度比较：小于等于（默认）
            ZTest LEqual
            
            // 深度偏移（解决 Z-Fighting）
            Offset 1, 1
            
            HLSLPROGRAM
            // ...
            ENDHLSL
        }
    }
}
```

**ZTest 全部操作符对比：**

| 操作符 | 含义 | 通过条件 | 典型场景 |
|--------|------|----------|----------|
| `Less` | 小于 | Z_fragment < Z_buffer | 罕见，自定义深度 |
| `LEqual` | 小于等于（默认） | Z_fragment ≤ Z_buffer | 不透明物体渲染 |
| `Equal` | 等于 | Z_fragment = Z_buffer | 已渲染区域高亮 |
| `GEqual` | 大于等于 | Z_fragment ≥ Z_buffer | X-Ray 透视效果 |
| `Greater` | 大于 | Z_fragment > Z_buffer | 被遮挡物体描边 |
| `NotEqual` | 不等于 | Z_fragment ≠ Z_buffer | 选中轮廓特效 |
| `Always` | 总是通过 | 不比较 | UI、后处理 |

#### 模板缓冲（Stencil Buffer）

模板缓冲是一个独立的整数缓冲区，每个像素位置存储一个 0-255 的值。Shader 可以通过 Stencil 指令在渲染时读写它：

```shaderlab
// 第一个 Pass：写入模板（标记区域）
Pass
{
    Stencil
    {
        Ref 1                    // 参考值
        Comp Always              // 总是通过比较
        Pass Replace             // 通过时写入 Ref 值
    }
    
    ColorMask 0                  // 不写颜色（只写模板）
}

// 第二个 Pass：读取模板（只在标记区域渲染）
Pass
{
    Stencil
    {
        Ref 1
        Comp Equal               // 模板值等于 1 才渲染
        Pass Keep                // 保持模板值不变
    }
}
```

**经典应用场景：**

| 场景 | 写入 Pass | 读取 Pass | 效果 |
|------|-----------|-----------|------|
| 角色描边 | 写角色轮廓为 1 | 描边 Pass 只在模板=1处渲染 | 描边不超出角色 |
| 传送门效果 | 传送门区域写 1 | 场景内容只在模板=1处渲染 | 内容只出现在传送门内 |
| 范围伤害指示器 | 圆形区域写 1 | 特效只在模板=1处渲染 | 技能特效不溢出范围 |
| 多重叠物体选中 | 已选中物体写 1 | 选中描边读取模板 | 只描边选中物体 |

#### Z-Fighting（深度冲突）

当两个面的深度值非常接近时，GPU 无法区分先后，导致闪烁/交替显示：

```
原因：float 精度不足（近距离精度高，远距离精度低）
解决方案：
1. 调整 Camera 的 Near Clip Plane（不要设太小，如 0.01 → 0.1）
2. 使用 Polygon Offset（ShaderLab Offset 指令）
3. 稍微移动物体的 Z 位置（偏移 0.001~0.01）
4. 将共面物体合并为一个 Mesh
```

#### 深度纹理（Depth Texture）在 URP 中的使用

URP 默认可以生成 `_CameraDepthTexture`，用于后处理、屏幕空间特效：

```csharp
// URP Asset 中开启 Depth Texture
// 或在 Camera 上勾选 "Depth Texture"

// Shader 中采样深度纹理
TEXTURE2D_X_FLOAT(_CameraDepthTexture);
SAMPLER(sampler_CameraDepthTexture);

float rawDepth = SAMPLE_TEXTURE2D_X(_CameraDepthTexture, sampler_CameraDepthTexture, uv).r;
// rawDepth 是 [0, 1] 的非线性深度，需要转线性
float linearDepth = LinearEyeDepth(rawDepth, _ZBufferParams);
```

### ⚡ 实战经验

1. **透明物体必须 ZWrite Off**：半透明 Alpha 混合时如果写入深度，后面的透明片元会被错误剔除，导致渲染顺序异常。但 Alpha Test（cutout）物体应保持 `ZWrite On`，因为它本质是"要么完全不透明、要么完全透明"
2. **Near Plane 不要设太小**：Near=0.01 会导致远距离深度精度急剧下降，引发 Z-Fighting。移动端建议 Near ≥ 0.1，Far 可根据需要设置
3. **URP 中使用模板缓冲需要自定义 Renderer Feature**：URP 默认不暴露模板缓冲的全局配置，需要通过 `ScriptableRendererFeature` 自定义 Pass 来写入/读取模板
4. **性能注意：Stencil 操作几乎不影响性能**：Stencil 测试在 GPU 硬件中非常高效，可以放心使用来替代一些复杂的 Shader 逻辑（如用模板遮罩替代 `discard` 判断）

### 🔗 相关问题

- Unity URP 的 Render Feature 如何实现自定义渲染 Pass？
- 什么是 Early-Z 剔除？什么情况下会失效？
- 如何解决移动端大面积 Z-Fighting 问题？
