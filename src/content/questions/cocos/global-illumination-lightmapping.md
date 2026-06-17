---
title: "Cocos Creator 3.x 全局光照（GI）与光照烘焙原理是什么？"
category: "cocos"
level: 3
tags: ["全局光照", "光照烘焙", "Lightmap", "PBR", "引擎原理"]
related: ["cocos/lighting-pbr-system", "cocos/shadow-map-pcf-soft"]
hint: "实时 GI 太贵？光照烘焙如何用离线计算换取运行时性能？"
---

## 参考答案

### ✅ 核心要点

1. **全局光照（GI）** = 直接光照 + 间接光照（反射光、环境光）
2. **光照烘焙（Lightmapping）** → 预计算静态光照到贴图，运行时零计算成本
3. **Lightmap UV** → 物体第二套 UV，将光照结果映射到模型表面
4. **Cocos 3.x 支持** → 内置 Lightmap 烘焙器，支持 Progressive Baking
5. **实时 GI vs 烘焙 GI** → 根据场景静态/动态特性选择方案

### 📖 深度展开

#### 为什么需要全局光照？

```
仅有直接光照                    有全局光照（GI）
  ☀ 太阳                        ☀ 太阳
  ↓                              ↓
  ┌────────┐                    ┌────────┐
  │ 桌子    │ ← 只有被直射的面亮  │ 桌子    │ ← 阴影面也有环境反射光
  │        │                    │        │    （更真实）
  └────────┘                    └────────┘
  阴影面纯黑                     阴影面有间接照明
```

**GI 的组成部分：**

| 光照类型 | 说明 | 实现方式 |
|----------|------|----------|
| 直接光 | 光源直接照射 | 实时阴影/光照 |
| 漫反射间接光 | 物体表面反射的 diffuse 光 | Lightmap / SH 探针 |
| 镜面反射间接光 | 物体表面反射的 specular 光 | 反射探针 / SSR |
| 环境光 | 天光、大气散射 | IBL / 环境贴图 |

#### 光照烘焙流程

```
准备阶段                          烘焙阶段
┌─────────────────┐              ┌─────────────────┐
│ 1. 标记静态物体  │              │ 5. 光线追踪/路径追踪│
│    (Static=true) │              │    从光源发射射线   │
│ 2. 配置光源参数  │ ─────────→   │ 6. 计算每个 texel  │
│ 3. 设置烘焙精度  │              │    的光照值         │
│    (Resolution)  │              │ 7. 生成 Lightmap   │
│ 4. 生成 Lightmap │              │    贴图 + UV 映射   │
│    UV (Atlas)    │              └─────────────────┘
└─────────────────┘                       ↓
                                    运行时：Shader 采样 Lightmap
```

**Cocos 中使用 Lightmap：**

```typescript
// 1. 标记物体为静态（不可移动）
//    在编辑器属性面板勾选 "Static" 或代码设置：
node.layer = Layers.Enum.DEFAULT;
const model = node.getComponent(Model);
if (model) {
    // 静态物体参与烘焙
    model.isStatic = true;
}

// 2. 配置场景烘焙设置（编辑器 → Scene → Lighting → Bake）
//   - Lightmap Resolution: 烘焙贴图分辨率（512/1024/2048）
//   - Lightmap Size: 单张 Lightmap Atlas 大小
//   - Bounces: 光线弹射次数（1~5，越高越真实但越慢）
//   - Compression: 是否压缩 Lightmap

// 3. 运行时自动应用（Cocos 内部处理）
//    静态物体使用烘焙光照，动态物体使用实时光照 + 球谐光照探针
```

#### Lightmap UV 与 Atlas 打包

```
模型原始 UV（Tile 重复）        Lightmap UV（不重复，独立 Atlas）
┌───────┐  ┌───────┐           ┌──────────────────┐
│       │  │       │           │ ┌─┐ ┌──┐ ┌───┐  │
│  UV1  │  │  UV1  │           │ │A│ │B │ │ C │  │
│       │  │       │    →      │ └─┘ └──┘ └───┘  │
└───────┘  └───────┘           │      ┌────┐     │
  重复铺设（纹理可 Tile）        │      │ D  │     │
                                │      └────┘     │
                                └──────────────────┘
                                  Lightmap Atlas
                                  （每个物体占独立区域）
```

**关键区别**：纹理 UV 可以 wrap/repeat，但 Lightmap UV **不能重复**——每个 texel 对应唯一的光照值。引擎会自动为静态物体生成专用的 Lightmap UV。

#### 实时 GI 方案对比

| 方案 | 原理 | 性能 | 质量 | Cocos 支持 |
|------|------|------|------|-----------|
| Lightmap（烘焙） | 离线预计算到贴图 | ⭐⭐⭐⭐⭐ 零成本 | ⭐⭐⭐⭐ 静态场景好 | ✅ 内置 |
| 球谐光照（SH Probe） | 球面调和函数编码光照 | ⭐⭐⭐⭐ 很低 | ⭐⭐⭐ 低频光照 | ✅ LightProbe |
| 反射探针（Reflection Probe） | 渲染 Cubemap | ⭐⭐⭐ 中等 | ⭐⭐⭐⭐ 镜面反射好 | ✅ 内置 |
| 屏幕空间反射（SSR） | 屏幕空间射线追踪 | ⭐⭐ 较高 | ⭐⭐⭐⭐ 动态 | ⚠️ 需自定义 Pass |
| VXGI（体素 GI） | 场景体素化 + 光线追踪 | ⭐ 很高 | ⭐⭐⭐⭐⭐ 最好 | ❌ 不支持 |

#### Cocos Lightmap Shader 采样原理

```glsl
// Cocos 内置光照 Shader 中 Lightmap 采样片段
// （简化版，展示核心逻辑）

// Lightmap 坐标（模型第二套 UV）
in vec2 v_lightmap_uv;

// Lightmap 纹理（Atlas）
uniform sampler2D lightmapTexture;

// 解码 Lightmap 颜色（烘焙时编码了 HDR 值）
vec3 decodeLightmap(vec4 encoded, float decodeMultiplier) {
    // RGBM 编码格式：RGB 通道 + 倍率 M 通道
    return encoded.rgb * encoded.a * decodeMultiplier;
}

void main() {
    // 直接光照（实时计算）
    vec3 directLight = calculateDirectLighting();

    // 间接光照（从 Lightmap 采样）
    vec3 bakedLight = decodeLightmap(
        texture2D(lightmapTexture, v_lightmap_uv),
        8.0  // HDR 解码倍率
    );

    // 最终颜色 = 直接光 + 烘焙间接光
    vec3 finalColor = directLight + bakedLight;

    gl_FragColor = vec4(finalColor, 1.0);
}
```

### ⚡ 实战经验

1. **Lightmap 渗色/漏光**：烘焙精度太低会导致阴影边缘漏光。解决：增大 Lightmap Resolution（至少 40 texels/unit），或检查模型 UV 接缝是否合理
2. **动态物体与静态环境不匹配**：烘焙场景中移动的角色看起来"飘"——因为没有间接光照。务必在场景中放置 **Light Probe（光照探针）**，为动态物体提供近似间接光
3. **烘焙时间太长**：一个中等复杂场景可能需要 10-30 分钟。建议开发阶段用低分辨率快速烘焙（10 texels/unit），最终出包时再用高分辨率重新烘焙
4. **移动端 Lightmap 内存**：一张 2048×2048 的 Lightmap RGBA 纹理约占 16MB。如果场景需要 8 张 Atlas，就是 128MB——移动端需要用 ETC2/ASTC 压缩，并尽量合并到 1024 分辨率

### 🔗 相关问题

- PBR 材质系统中 IBL（基于图像的光照）是如何工作的？
- 如何在 Cocos 中实现实时反射效果？（反射探针 vs SSR）
- 光照探针（Light Probe）的球谐函数原理是什么？
