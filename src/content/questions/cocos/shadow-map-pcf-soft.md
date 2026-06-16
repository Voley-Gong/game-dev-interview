---
title: "Cocos Creator 阴影系统：ShadowMap 原理与 PCF 软阴影如何实现？"
category: "cocos"
level: 3
tags: ["阴影", "ShadowMap", "PCF", "渲染", "3D"]
related: ["cocos/render-pipeline", "cocos/custom-render-pipeline", "cocos/material-system-uniform-ubo"]
hint: "从光源视角渲染深度图，到屏幕空间对比深度，再到 PCF 采样柔化边缘。"
---

## 参考答案

### ✅ 核心要点

1. **ShadowMap** 核心思想：从光源视角渲染一张深度图，再在主渲染阶段对比片元深度与深度图判断是否被遮挡
2. **方向光阴影**使用正交投影（Orthographic），**点光源阴影**使用 6 面立方体投影（CubeMap）
3. **PCF（Percentage-Closer Filtering）**：在阴影边缘做多次采样并平均，实现软阴影过渡
4. **Shadow Acne 与 Peter-Panning** 是两大经典瑕疵，分别通过 Bias 偏移和正面剔除解决
5. Cocos Creator 3.x 内置阴影流程通过 **ShadowPass** 实现，可通过 RenderPipeline 自定义

### 📖 深度展开

#### ShadowMap 基本原理

```
步骤 1：Light Space 渲染（Shadow Pass）
  ┌─────────────┐
  │  从光源视角  │ → 只写深度，不写颜色
  │  渲染场景    │ → 输出到 ShadowMap (RenderTexture)
  └─────────────┘
  
步骤 2：主渲染阶段（Main Pass）
  对每个片元：
    1. 变换到光源空间 (lightViewProj * worldPos)
    2. 采样 ShadowMap 获取最近深度
    3. 比较当前片元深度 vs ShadowMap 深度
    4. 若当前深度 > ShadowMap 深度 → 在阴影中（返回 0）
       否则 → 不在阴影中（返回 1）
```

#### GLSL 实现核心

```glsl
// 顶点着色器：传递光源空间坐标
#pragma builtin(global)
uniform mat4 cc_matLightViewProj;  // 光源 VP 矩阵

vs_out {
  vec4 shadowCoord = cc_matLightViewProj * worldPos;
  shadowCoord.xyz /= shadowCoord.w;  // 透视除法
  shadowCoord.xyz = shadowCoord.xyz * 0.5 + 0.5;  // NDC → [0,1]
  v_shadowCoord = shadowCoord.xyz;
}

// 片元着色器：基础阴影判断
float shadowCalculation(vec3 shadowCoord, sampler2D shadowMap) {
    float closestDepth = texture(shadowMap, shadowCoord.xy).r;
    float currentDepth = shadowCoord.z;
    
    // Bias 防止 Shadow Acne
    float bias = 0.005;
    
    return currentDepth - bias > closestDepth ? 0.0 : 1.0;
}
```

#### PCF 软阴影（Percentage-Closer Filtering）

```glsl
// 3x3 PCF：采样 9 个点并平均
float pcfShadow(vec3 shadowCoord, sampler2D shadowMap, vec2 texelSize) {
    float shadow = 0.0;
    vec2 texelSize = 1.0 / textureSize(shadowMap, 0);
    
    // poisson disk 采样（比均匀网格效果更好）
    vec2 sampleOffset[9] = vec2[9](
        vec2(-1,-1), vec2(0,-1), vec2(1,-1),
        vec2(-1, 0), vec2(0, 0), vec2(1, 0),
        vec2(-1, 1), vec2(0, 1), vec2(1, 1)
    );
    
    for (int i = 0; i < 9; i++) {
        vec2 offset = sampleOffset[i] * texelSize * 2.0;  // 采样半径
        float depth = texture(shadowMap, shadowCoord.xy + offset).r;
        shadow += (shadowCoord.z - 0.005 > depth) ? 0.0 : 1.0;
    }
    return shadow / 9.0;
}
```

#### PCF 采样质量对比

| 方法 | 采样数 | 效果 | 性能开销 |
|------|--------|------|----------|
| 硬阴影（无 PCF） | 1 | 锯齿明显 | 最低 |
| 3×3 PCF | 9 | 边缘柔化 | 中等 |
| 5×5 PCF | 25 | 较柔和 | 较高 |
| Poisson Disk（16 点） | 16 | 接近 5×5 | 中等 |
| PCSS（可变半径） | 16~64 | 真实柔和（PBR） | 最高 |

#### 两大经典阴影瑕疵

```
瑕疵 1：Shadow Acne（阴影条纹）
  原因：深度精度不够，表面自遮挡
  解决：添加 Bias 偏移（但太大会导致 Peter Pan）

瑕疵 2：Peter Pan（物体悬浮）
  原因：Bias 过大，阴影与物体脱离
  解决：调整 Bias / 使用 Front-Face Culling 渲染 ShadowMap

瑕疵 3：边缘锯齿（硬阴影）
  原因：ShadowMap 分辨率不够
  解决：PCF 采样 / 提高 ShadowMap 分辨率
```

#### Cocos Creator 3.x 阴影配置

```typescript
// 通过 Light 组件启用阴影
const dirLight = node.getComponent(DirectionalLight);
dirLight.shadowEnabled = true;
dirLight.shadowPcf = 3;        // PCF 采样等级 (1=硬, 2=低, 3=高)
dirLight.shadowBias = 0.00001; // 深度偏移
dirLight.shadowNormalBias = 0.5; // 法线偏移
dirLight.shadowDistance = 50;  // 阴影有效距离
dirLight.shadowMatrices;       // 光源 VP 矩阵（引擎自动计算）

// 阴影分辨率（通过 RenderTexture 配置）
// 常用值：1024 / 2048 / 4096
// 移动端建议 ≤ 1024，PC 端可用 2048+
```

#### CSM（级联阴影）原理

```
大型场景中单一 ShadowMap 精度不够：
  Near ──────── Mid ──────── Far
  Cascade 0    Cascade 1    Cascade 2
  高精度       中精度        低精度
  近处清晰     远处模糊      最远处无阴影

  → 根据片元距离相机远近，选择对应级联的 ShadowMap
  → Cocos Creator 3.8+ 支持 CSM
```

### ⚡ 实战经验

1. **移动端 ShadowMap 分辨率不要超过 1024**：2048 的 ShadowMap 在中低端 Android 上会占用大量显存带宽，导致渲染帧率下降。1024 + PCF 2 级通常够用。
2. **Shadow Acne 和 Peter Pan 要反复调参**：`shadowBias` 和 `shadowNormalBias` 的合理值取决于场景尺度。大场景需要更大的 Bias，但可能导致物体脚部阴影脱离地面。推荐先调 NormalBias 再调 Bias。
3. **角色投影的"抠脚"问题**：小物体在低分辨率 ShadowMap 上投影会丢失细节。解决方案是为角色单独渲染一张高精度 ShadowMap（多 Shadow Pass），或使用胶囊体投影近似。
4. **CSM 级联切换的闪烁**：级联边界处阴影精度突变会产生明显闪烁。可以在级联交界处做一段平滑混合（Blend Zone），通常取级联范围的 10%~20%。

### 🔗 相关问题

- 如何在 Cocos Creator 中实现实时点光源阴影（CubeMap ShadowMap）？
- 自定义 RenderPipeline 中如何添加 Shadow Pass？
- PCSS（Percentage-Closer Soft Shadows）相比 PCF 有什么优势？
