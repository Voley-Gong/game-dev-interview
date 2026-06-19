---
title: "Unity Shadow Map 原理是什么？Shadow Acne、Peter Panning 等常见问题如何解决？"
category: "unity"
level: 3
tags: ["渲染", "Shadow Map", "URP", "阴影优化", "图形学"]
related: ["unity/lighting-system", "unity/urp-render-pipeline", "unity/shader-material-system"]
hint: "阴影本质是两次渲染：先从光源视角画深度图，再在主渲染中比较深度。理解这一步，所有问题都迎刃而解。"
---

## 参考答案

### ✅ 核心要点

1. **Shadow Map = 光源视角的深度纹理**：先 Render Pass 从光源位置渲染深度图，再在主 Pass 中比较片段深度
2. **Directional Light 用级联阴影（CSM）**：近处高分辨率、远处低分辨率，平衡质量和性能
3. **Shadow Acne**：因深度图分辨率不足导致的自遮挡条纹，用 Depth Bias + Normal Bias 解决
4. **Peter Panning**：Bias 调太大导致阴影「悬空」与物体分离，需要 Bias 适中
5. **移动端阴影是性能杀手**：URP 中 `Main Light Cast Shadows` + `Additional Light Shadows` 每增加一级开销翻倍

### 📖 深度展开

#### Shadow Map 工作流程

```
Step 1: Shadow Pass（阴影渲染Pass）
  ┌─────────────────────────┐
  │  光源视角 Render         │
  │  → 输出: _ShadowMapTexture│
  │     (R32 / R16Float 深度) │
  └─────────────────────────┘
           ↓
Step 2: 主渲染 Pass（Forward / Deferred）
  ┌─────────────────────────────────────┐
  │  对每个片段:                         │
  │  1. 将世界坐标变换到光源空间          │
  │  2. 采样 Shadow Map 获取最近深度 D_s │
  │  3. 当前片段深度 D_f                 │
  │  4. if (D_f - bias > D_s) → 在阴影中 │
  │     else → 被照亮                    │
  └─────────────────────────────────────┘
           ↓
Step 3: 阴影过滤（PCF / PCSS）
  → 对阴影边缘做柔化（软阴影）
```

#### 级联阴影（CSM — Cascaded Shadow Map）

Directional Light 专属方案，将视锥分割成若干级，每级独立渲染一张 Shadow Map：

```
Camera Frustum 视锥分割:

┌────┬────────┬──────────────┬────────────────────┐
│ C0 │   C1   │     C2       │        C3          │
│近  │  中近   │    中远      │       远           │
│高精度│ 中精度  │   低精度     │     最低精度        │
│1024│  1024  │   1024       │      1024          │
└────┴────────┴──────────────┴────────────────────┘
Near →────────── Far

分割策略:
  - Two Cascades:  简单场景 / 低端移动端
  - Four Cascades: 标准方案（默认推荐）
  - Split < 0.5 的第一级覆盖近处关键区域
```

| 配置项 | 作用 | 推荐值（移动端） | 推荐值（PC/主机） |
|--------|------|-------------------|-------------------|
| Cascade Count | 级联数量 | 2 | 4 |
| Shadow Distance | 阴影渲染距离 | 50~80m | 150~300m |
| Shadow Map Size | 深度纹理分辨率 | 1024 | 2048~4096 |
| Cascade Split | 各级比例 | 0.15, 0.5, 1.0 | 0.067, 0.2, 0.5, 1.0 |
| Depth Bias | 深度偏移 | 1.0 | 1.0~3.0 |
| Normal Bias | 法线偏移 | 0.5~1.0 | 0.5~2.0 |

#### 常见阴影问题与解决

```
问题1: Shadow Acne (阴影条纹/痤疮)
  原因: Shadow Map 分辨率不足，多个片段映射到同一纹素
  现象:
    ║║║║║║║║║║  ← 表面出现明暗交替条纹
    ║║║║║║║║║║
  解决: 增加 Depth Bias（将深度往前推一点）
        增加 Normal Bias（沿法线方向收缩）
        提高 Shadow Map 分辨率

问题2: Peter Panning (阴影悬空)
  原因: Bias 过大，阴影与物体底部脱离
  现象:
    ████        ← 物体
        ████    ← 阴影悬空，底部有缝隙
  解决: 减小 Bias，或使用正面剔除渲染 Shadow Map
        （Cull Front 方式，代价是精度略降）

问题3: 阴影边缘锯齿（Hard Edge Aliasing）
  原因: Shadow Map 采样无过滤
  解决: 开启 PCF（Percentage Closer Filtering）
        URP: Soft Shadows = Low/Medium/High
        HDRP: Contact Shadows + PCSS

问题4: 远处阴影突然消失
  原因: 超出 Shadow Distance
  解决: 适当增大 Shadow Distance，或用 Fade 渐隐过渡
```

#### URP Shadow Shader 代码片段（自定义阴影偏移）

```csharp
// 在 URP 的 Shader 中手动采样 Cascade Shadow Map
// 适用于自定义 Shader / Shader Graph 扩展

TEXTURE2D_SHADOW(_MainLightShadowmapTexture);
SAMPLER_CMP(sampler_MainLightShadowmapTexture);

// 阴影采样: 返回 [0, 1]，0=全阴影，1=全亮
float SampleMainLightShadow(float3 positionWS, float3 normalWS)
{
    // 1. 转换到光源空间
    float4 shadowCoord = TransformWorldToShadowCoord(positionWS);

    // 2. 自定义 Bias（沿法线方向偏移）
    float bias = 0.001;
    shadowCoord.xyz += normalWS * bias;

    // 3. 采样 Shadow Map（硬件 PCF 2x2）
    float shadowStrength = GetMainLightShadowStrength();
    return SAMPLE_TEXTURE2D_SHADOW(
        _MainLightShadowmapTexture,
        sampler_MainLightShadowmapTexture,
        shadowCoord.xyz
    ) * shadowStrength;
}

// 在片元着色器中使用
half3 ApplyShadow(half3 color, float3 posWS, float3 normalWS)
{
    float shadowAttenuation = SampleMainLightShadow(posWS, normalWS);
    return color * lerp(0.5h, 1.0h, shadowAttenuation); // 阴影最暗到50%
}
```

#### 阴影性能开销对比（移动端实测参考）

| 阴影配置 | 帧时间增量 | DrawCall 增量 | 备注 |
|----------|-----------|---------------|------|
| 无阴影 | 基准 0ms | 0 | 最快，但画面无立体感 |
| 1盏 Directional + 2 CSM | +1.5~2.5ms | +场景DrawCall×2 | 标准移动端方案 |
| 1盏 Directional + 4 CSM | +3~5ms | +场景DrawCall×4 | 高端机型可接受 |
| 附加光源阴影（1盏 Point） | +0.8~1.5ms | +场景DrawCall | Point Light Shadow 用 CubeMap，较贵 |
| Point Light Shadow × 4 | +4~6ms | +场景DrawCall×4 | 移动端不建议 |

### ⚡ 实战经验

1. **移动端只开 1 盏主光源阴影**：URP 的 `Additional Lights Cast Shadows` 在移动端几乎一定掉帧。只让 Directional Light（太阳光）投影，Point/Spot Light 用烘焙阴影或假阴影（Blob Shadow）替代
2. **Shadow Distance 是最强武器**：在 URP Asset 中把 Shadow Distance 调到 50~80m（移动端），超出范围用距离雾遮盖。这比降 Shadow Map 分辨率效果好得多
3. **Bias 调试流程**：先全场景开阴影 → 把 Depth Bias 从 1.0 往上调直到 Acne 消失 → 如果出现 Peter Panning 就回调 Normal Bias 替代 → 最终在极端角度（掠射角）验证
4. **用 Shadowmask 替代实时阴影**：混合光照模式下，静态物体用烘焙的 Shadowmask，只有动态物体走实时阴影。场景中 90% 的物体是静态的，这能砍掉绝大部分 Shadow Pass 开销

### 🔗 相关问题

- URP 的 Forward+ 和 Deferred 渲染路径对阴影处理有什么区别？
- Point Light / Spot Light 的 Shadow Map 为什么比 Directional Light 贵得多？
- 如何实现角色脚下的圆形假阴影（Blob Shadow）？什么场景下用它替代真实阴影？
