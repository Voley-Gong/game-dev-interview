---
title: "Cocos Creator 3.x 地形系统与高度图原理是什么？"
category: "cocos"
level: 3
tags: ["地形系统", "高度图", "LOD", "引擎原理"]
related: ["cocos/model-loading-lod-strategy", "cocos/lighting-pbr-system"]
hint: "从高度图到 Mesh 生成，地形系统如何实现大规模地表渲染？"
---

## 参考答案

### ✅ 核心要点

1. **地形数据来源** → 灰度高度图（Heightmap）转换为顶点高度
2. **Mesh 生成** → 根据 Heightmap 采样生成网格，配合 SplatMap 控制材质混合
3. **LOD 策略** → 远距离地形分块简化，减少三角形数量
4. **多层纹理混合** → SplatMap（RGBA 4 通道）控制 4 种地表材质权重
5. **Cocos 3.x 现状** → 引擎内置地形编辑器，支持 Brush 绘制与高度雕刻

### 📖 深度展开

#### 高度图 → Mesh 的转换过程

地形系统的基础是 **Heightmap**：一张灰度图片，每个像素的亮度值代表该位置的高度。

```
Heightmap (灰度图)          Mesh (3D 网格)
┌─────────────┐            ┌──────────────┐
│ ░░▒▒▓▓██   │  采样转换   │ /\  /\    /\ │
│ ░░▒▒▓▓██   │ ─────────→ │ /  \/  \/  \ │
│ ░░▒▒▓▓██   │            │              │
└─────────────┘            └──────────────┘
  像素 = 高度                顶点 Y = 像素亮度 × heightScale
```

**核心转换代码：**

```typescript
// 从 Heightmap 生成地形顶点数据
function generateTerrainMesh(
    heightmap: ImageData,
    width: number,
    height: number,
    heightScale: number,
    segment: number
): { positions: number[]; indices: number[]; uvs: number[] } {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const stepX = width / segment;
    const stepZ = height / segment;

    // 1. 生成顶点
    for (let z = 0; z <= segment; z++) {
        for (let x = 0; x <= segment; x++) {
            const px = x * stepX;
            const pz = z * stepZ;

            // 采样高度图（双线性插值）
            const h = sampleHeightmapBilinear(
                heightmap,
                x / segment,
                z / segment
            );

            positions.push(px, h * heightScale, pz);
            uvs.push(x / segment, z / segment);
        }
    }

    // 2. 生成索引（三角形）
    for (let z = 0; z < segment; z++) {
        for (let x = 0; x < segment; x++) {
            const idx = z * (segment + 1) + x;
            // 两个三角形组成一个方格
            indices.push(idx, idx + segment + 1, idx + 1);
            indices.push(idx + 1, idx + segment + 1, idx + segment + 2);
        }
    }

    return { positions, indices, uvs };
}

// 双线性插值采样
function sampleHeightmapBilinear(
    heightmap: ImageData,
    u: number,
    v: number
): number {
    const w = heightmap.width;
    const h = heightmap.height;
    const fx = u * (w - 1);
    const fy = v * (h - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const tx = fx - x0;
    const ty = fy - y0;

    const data = heightmap.data;
    const h00 = data[(y0 * w + x0) * 4] / 255;
    const h10 = data[(y0 * w + x1) * 4] / 255;
    const h01 = data[(y1 * w + x0) * 4] / 255;
    const h11 = data[(y1 * w + x1) * 4] / 255;

    return (
        h00 * (1 - tx) * (1 - ty) +
        h10 * tx * (1 - ty) +
        h01 * (1 - tx) * ty +
        h11 * tx * ty
    );
}
```

#### SplatMap 多层材质混合

地形不是单一纹理——草地、泥土、岩石、雪地需要根据位置自动混合：

```
SplatMap (RGBA)
┌──────────────┐
│ R=草地权重    │
│ G=泥土权重    │ → Shader 中按权重混合 4 张贴图
│ B=岩石权重    │
│ A=雪地权重    │
└──────────────┘
```

**地形混合 Shader 片段：**

```glsl
// Cocos Effect 地形混合片段
vec4 splatWeight = texture(splatMap, v_uv);

// 归一化权重（确保总和为 1）
float weightSum = splatWeight.r + splatWeight.g + splatWeight.b + splatWeight.a;
splatWeight /= max(weightSum, 0.001);

// 4 层纹理混合
vec4 layer0 = texture2D(grassTex, v_uv * tileScale);   // 草地
vec4 layer1 = texture2D(dirtTex, v_uv * tileScale);     // 泥土
vec4 layer2 = texture2D(rockTex, v_uv * tileScale);     // 岩石
vec4 layer3 = texture2D(snowTex, v_uv * tileScale);     // 雪地

vec4 finalColor = layer0 * splatWeight.r
                + layer1 * splatWeight.g
                + layer2 * splatWeight.b
                + layer3 * splatWeight.a;
```

#### LOD 分块策略

大地形需要分块（Chunk）+ LOD 管理：

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| 固定分块 | 将地形切成 N×N 的 Chunk，每块独立 LOD | 中小型地形 |
| Clipmap | 环形 LOD 层级，跟随相机动态更新 | 超大地形 |
| QuadTree LOD | 四叉树递归细分，按距离决定细节 | 通用方案 |

```
QuadTree LOD 示意：
              ┌────────────┐
    远 →      │  Level 0   │  1 个大块
              ├──────┬─────┤
    中 →      │ L1  │ L1  │  4 块
              ├────┼────┼──┤
    近 →      │L2  │L2  │   │  16 块（玩家附近最高细节）
              └────┴────┴───┘
```

#### Cocos 内置地形 vs 自定义地形

| 维度 | Cocos 内置 Terrain | 自定义 Mesh 地形 |
|------|-------------------|-----------------|
| 编辑器支持 | 有 Brush 工具 | 需自己写编辑器 |
| 高度雕刻 | 支持 | 需手动实现 |
| SplatMap | 支持 4 层 | 可自由扩展 |
| LOD | 内置简化 | 需自行实现 |
| 灵活性 | 受限 | 完全可控 |
| 适用场景 | 一般项目 | 特殊渲染需求 |

### ⚡ 实战经验

1. **高度图精度问题**：8-bit 高度图只有 256 级，地形会出现阶梯感。生产环境建议用 16-bit RAW 格式高度图，Cocos Terrain 组件原生支持导入
2. **SplatMap 边界硬边**：权重图的分辨率太低会导致材质过渡生硬。解决：在 Shader 中对 SplatMap 做一次高斯模糊采样，或在绘制工具中开启权重平滑
3. **性能陷阱**：一个 1024×1024 的地形如果全用最高 LOD，三角形数量会超过 200 万。务必启用分块 LOD 或相机距离剔除
4. **移动端兼容**：地形 SplatMap 需要 4 张纹理采样 + 1 张权重图 = 5 次 texture fetch，中低端机 GPU 压力大。移动端建议减少到 2 层纹理 + 1 张权重图

### 🔗 相关问题

- Cocos Creator 的 LOD 系统如何配置？（`model-loading-lod-strategy`）
- 大规模开放世界场景的分块加载策略是什么？
- 地形上的物理碰撞如何处理？（MeshCollider vs HeightFieldCollider）
