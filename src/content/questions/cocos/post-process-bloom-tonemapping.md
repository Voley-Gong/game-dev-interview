---
title: "Cocos Creator 后处理栈：Bloom、Blur 与色调映射如何实现？"
category: "cocos"
level: 3
tags: ["后处理", "Bloom", "Gaussian Blur", "色调映射", "HDR"]
related: ["cocos/custom-render-pipeline", "cocos/render-pipeline", "cocos/shadow-map-pcf-soft"]
hint: "从亮度提取→高斯模糊→合成，再到 HDR→LDR 的色调映射，后处理是画面品质的最后一公里。"
---

## 参考答案

### ✅ 核心要点

1. **后处理（Post-Processing）** 在场景渲染完成后、上屏前对最终画面进行全屏图像处理
2. **Bloom（泛光）** 流程：亮度提取 → 多级高斯模糊 → 与原图叠加，让明亮区域产生发光效果
3. **高斯模糊（Gaussian Blur）** 利用二维高斯核做卷积，常用优化是**两次一维模糊**（分离卷积）降复杂度从 O(n²) 到 O(2n)
4. **色调映射（Tone Mapping）** 将 HDR（>1.0）的颜色值压缩到 LDR（0~1），保留亮部/暗部细节
5. Cocos Creator 3.x 通过 **Custom Render Pipeline** 的 **PostProcess Pass** 实现后处理链

### 📖 深度展开

#### 后处理在渲染管线中的位置

```
完整渲染流程（简化）：
  ShadowPass → MainPass → [PostProcess] → 上屏

PostProcess 内部链：
  原始帧缓冲（HDR）
    ↓ Bright Pass（提取亮度 > 阈值的部分）
    ↓ Blur Pass × N（多级降采样模糊）
    ↓ Combine Pass（原 图 + 泛光 叠加）
    ↓ Tone Mapping（HDR → LDR）
    ↓ 颜色校正 / LUT（可选）
    ↓ Gamma 校正 / 输出
  最终画面（LDR, 0~1）
```

#### Bloom 实现详解

```glsl
// Step 1: Bright Pass — 提取高亮区域
// 输入: HDR 场景纹理
// 输出: 仅包含亮度 > threshold 的像素
uniform float u_bloomThreshold; // 通常 0.8~1.2

vec4 brightPass(sampler2D sceneTex, vec2 uv) {
    vec3 color = texture(sceneTex, uv).rgb;
    float brightness = dot(color, vec3(0.2126, 0.7152, 0.0722)); // Rec.709 亮度
    vec3 contribution = smoothstep(u_bloomThreshold, u_bloomThreshold + 0.4, brightness) * color;
    return vec4(contribution, 1.0);
}

// Step 2: Gaussian Blur — 多级降采样模糊
// 关键：先横后纵（两步分离卷积）
uniform vec2 u_texelSize; // 1.0 / textureSize

vec3 gaussianBlurHorizontal(sampler2D tex, vec2 uv) {
    float weights[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
    vec3 result = texture(tex, uv).rgb * weights[0];
    for (int i = 1; i < 5; i++) {
        result += texture(tex, uv + vec2(u_texelSize.x * i, 0.0)).rgb * weights[i];
        result += texture(tex, uv - vec2(u_texelSize.x * i, 0.0)).rgb * weights[i];
    }
    return result;
}
// 纵向同理，只需将 u_texelSize.x 换为 u_texelSize.y

// Step 3: Combine — 叠加回原图
vec3 bloomCombine(vec3 original, vec3 bloom, float intensity) {
    return original + bloom * intensity; // 加法混合（更亮）
    // return original * (1.0 - bloom) + bloom; // 屏幕混合（柔和）
}
```

**多级降采样（Mipmap Chain）策略：**

```
原始分辨率 1024×768
  ↓ 降采样 ×2 → 512×384（Blur Pass 1）
  ↓ 降采样 ×4 → 256×192（Blur Pass 2）
  ↓ 降采样 ×8 → 128×96 （Blur Pass 3）
  ↓ 上采样 + 模糊回到原始分辨率
  → 合成

每一级模糊半径更大，但像素更少
→ 用极低开销获得大范围柔光效果
```

#### 色调映射（Tone Mapping）

HDR 颜色值可能远超 1.0（如太阳处可能是 10.0+），直接截断到 1.0 会丢失亮部细节：

```glsl
// 无色调映射（直接截断）— 不推荐
vec3 finalColor = clamp(hdrColor, 0.0, 1.0); // 亮部全白，丢失细节

// Reinhard 色调映射 — 简单经典
vec3 reinhard(vec3 hdr) {
    return hdr / (hdr + vec3(1.0));
}
// 特点：简单高效，但高亮区域偏灰

// ACES Filmic 色调映射 — 电影级（推荐）
vec3 acesFilmic(vec3 hdr) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((hdr * (a * hdr + b)) / (hdr * (c * hdr + d) + e), 0.0, 1.0);
}
// 特点：对比度高，色彩还原好，电影行业标准

// 对比：
// 输入 HDR 值:  0.2   0.5   1.0   2.0   5.0   10.0
// Reinhard:    0.167 0.333 0.500 0.667 0.833 0.909
// ACES:        0.183 0.353 0.496 0.625 0.776 0.857
```

#### 色调映射曲线对比

| 算法 | 暗部保留 | 亮部保留 | 对比度 | 适用场景 |
|------|----------|----------|--------|----------|
| Reinhard | 好 | 一般（偏灰） | 低 | 风景、概念图 |
| ACES Filmic | 好 | 好（自然） | 高 | 3A 级、写实 |
| Uncharted 2 | 好 | 好 | 中高 | 游戏通用 |
| Linear | 差 | 差 | — | 不推荐 |
| Gamma 2.2 | 差 | 一般 | 中 | 仅 Gamma 校正 |

#### Cocos Creator 中的后处理配置

```typescript
// Cocos Creator 3.8+ 通过 Custom Render Pipeline 添加后处理
import { pipeline } from 'cc';

// 自定义 PostProcess Stage
class BloomPostProcess {
    init(): void {
        // 创建降采样用的 RenderTexture 链
        this.bloomTextures = [];
        const sizes = [
            [width / 2, height / 2],
            [width / 4, height / 4],
            [width / 8, height / 8],
        ];
        for (const [w, h] of sizes) {
            this.bloomTextures.push(new RenderTexture(w, h, TextureFmt.RGBA8));
        }
    }

    render(camera): void {
        // 1. Bright Pass → bloomTextures[0]
        this.blit(sceneTexture, this.bloomTextures[0], this.brightPassMat);
        
        // 2. 多级降采样模糊
        for (let i = 0; i < this.bloomTextures.length - 1; i++) {
            this.blit(this.bloomTextures[i], this.bloomTextures[i + 1], this.blurMatH);
            this.blit(this.bloomTextures[i + 1], this.bloomTextures[i + 1], this.blurMatV);
        }
        
        // 3. 上采样叠加（逐级合并回高分辨率）
        for (let i = this.bloomTextures.length - 2; i >= 0; i--) {
            this.blitUpscale(this.bloomTextures[i + 1], this.bloomTextures[i]);
        }
        
        // 4. 最终合成 + 色调映射
        this.blit(sceneTexture, screenRT, this.combineMat);
    }
}
```

### ⚡ 实战经验

1. **Bloom 阈值设置是画面调色的关键**：阈值太低（< 0.6）会导致整个画面发灰泛白，太高（> 1.5）则只有太阳等极端亮源才有泛光。推荐 0.8~1.0，配合 HDR 管线使用效果最佳。
2. **移动端后处理要极度克制**：一次高斯模糊的降采样链（3级）在移动端 GPU 上可能占用 3~5ms。低端机可以只做 1 级降采样 + 较小模糊核，或直接禁用 Bloom。用设备分级策略控制后处理开关。
3. **色调映射在 Gamma 校正之前**：先 ACES 映射到 [0,1]，再做 sRGB Gamma 校正。顺序反了会导致画面偏暗。Cocos 内置管线会自动处理这个顺序，但自定义管线中容易搞反。
4. **Bloom 的"电焊眼"问题**：纯白色高亮区域经过 Bloom 后会产生大面积刺眼白光。可以在 Bright Pass 后做一次柔和的 knee 衰减（超亮区域压缩），让泛光在极高亮度时收敛而非无限增亮。

### 🔗 相关问题

- 如何实现屏幕空间的环境光遮蔽（SSAO）？
- 景深（Depth of Field）效果的实现原理是什么？
- 自定义 RenderPipeline 中如何管理多个后处理 Pass 的 RenderTexture 复用？
