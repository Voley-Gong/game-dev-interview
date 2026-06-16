---
title: "Cocos Creator 3.x 光照系统与 PBR 渲染：光源、BRDF 与性能平衡"
category: "cocos"
level: 3
tags: ["光照", "PBR", "渲染", "性能优化"]
related: ["cocos/render-pipeline", "cocos/shadow-map-pcf-soft", "cocos/material-system-uniform-ubo"]
hint: "为什么移动端光照往往只有一盏主光？PBR 的 BRDF 是怎么算的？"
---

## 参考答案

### ✅ 核心要点

1. **光源类型**：方向光（Directional）、点光源（Point）、聚光灯（Spot）、环境光（Ambient/Hemisphere）
2. **PBR 流程**：基于物理的渲染 = 菲涅尔反射 + 微表面法线分布 + 几何遮蔽
3. **前向渲染（Forward）**：逐像素遍历光源，移动端默认策略，光源数量直接影响性能
4. **光照贴图（Lightmap）**：静态光照烘焙到纹理，运行时零开销近似全局光照
5. **移动端策略**：限制实时光源数量、使用 Lightmap、简化 BRDF 模型

### 📖 深度展开

#### 光源参数与着色器uniform

```glsl
// Cocos Creator 3.x PBR Shader 中的核心光照计算（简化版）
uniform vec3 cc_mainLitColor;       // 主光源颜色
uniform vec3 cc_mainLitDir;         // 主光源方向
uniform vec3 cc_ambientSky;         // 环境光-天空
uniform vec3 cc_ambientGround;      // 环境光-地面

// BRDF 微表面模型核心项
float D = GGX_D(N, H, roughness);     // 法线分布函数
float G = Smith_G(N, V, L, roughness); // 几何遮蔽函数
vec3  F = Fresnel_Schlick(V, H, F0);   // 菲涅尔反射

vec3 specular = (D * G * F) / (4 * NoV * NoL);
vec3 diffuse = (1.0 - F) * baseColor / PI;
vec3 Lo = (diffuse + specular) * radiance * NoL;
```

#### 各光源类型对比

| 光源类型 | 计算复杂度 | 典型用途 | 移动端建议 |
|----------|-----------|---------|-----------|
| 方向光 | O(1) 跟着色器走 | 太阳光、全局主光 | ✅ 最多1盏 |
| 点光源 | 需计算距离衰减 | 火把、灯泡 | ⚠️ 尽量烘焙 |
| 聚光灯 | 聚光衰减+距离衰减 | 手电筒、舞台灯 | ⚠️ 尽量烘焙 |
| 环境光 |半球采样 | 整体氛围填充 | ✅ 必备 |

#### Forward vs Deferred 渲染路径对光照的影响

```
Forward Rendering（Cocos 默认）:
  每个片元 → 遍历所有光源 → 逐光源计算 BRDF
  光源数 × 场景物元数 = DrawCall 计算量
  ✅ 兼容性好    ❌ 多光源时性能下降明显

Deferred Rendering（需要自定义管线）:
  Geometry Pass → G-Buffer（位置/法线/反照率）
  Lighting Pass → 逐屏幕像素计算所有光源
  ✅ 光源数与场景复杂度解耦
  ❌ 需要 MRT 支持，移动端兼容性差，透明物体需单独处理
```

#### Lightmap 烘焙流程

```
编辑器操作:
  1. 标记静态物体（Static = true）
  2. 配置烘焙参数（分辨率、光照弹射次数）
  3. Bake → 生成 LightmapTexture + UV2

运行时:
  Shader 采样 lightmap：
  vec3 lightmapColor = texture2D(cc_lightmapTex, lightmapUV).rgb;
  finalColor = directLighting + lightmapColor * albedo;
```

### ⚡ 实战经验

1. **移动端务必只保留一盏实时光源**：多盏点光源在 Forward 渲染下会导致 Shader 循环次数翻倍，中低端机帧率直接腰斩
2. **Lightmap 是性能救星但要注意内存**：一张 1024×1024 的 Lightmap 纹理约 4MB，大场景需要分区域烘焙并按 Asset Bundle 拆分加载
3. **PBR 材质参数不要全用默认值**：roughness 和 metallic 使用默认 0.5 会导致场景"塑料感"很重，应该按真实材质参考值调整
4. **自定义管线中可以实现 Light Probe（光照探针）**：对动态物体提供近似间接光照，弥补 Lightmap 只能用于静态物体的缺陷

### 🔗 相关问题

- 如何在自定义渲染管线中实现延迟渲染？
- IBL（基于图像的光照）与环境贴图如何结合？
- 如何调试场景中光源贡献过大的问题？
