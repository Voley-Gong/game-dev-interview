---
title: "Cocos Creator 3.x 如何实现自定义渲染管线（Custom Render Pipeline）？"
category: "cocos"
level: 3
tags: ["渲染管线", "Shader", "后处理", "引擎进阶"]
related: ["cocos/render-pipeline", "cocos/shader-fundamentals"]
hint: "想在 Cocos 里实现卡通渲染、后处理描边、多 Pass 渲染，需要改什么？"
---

## 参考答案

### ✅ 核心要点

1. **RenderPipeline 资源**：在 3.x 中通过自定义 `RenderPipeline` 资源替换默认管线
2. **RenderFlow 与 RenderPass**：管线由多个 Flow 组成，每个 Flow 包含若干 Pass
3. **Stage 插入点**：可在 Shadow、Forward、Transparent 等 Stage 前后插入自定义 Pass
4. **Material 与 Effect**：自定义 Pass 使用专门的 Material，通过 Effect（`.effect` 文件）编写 Shader
5. **后处理框架**：3.8+ 提供了 `PostProcess` 组件，可链式叠加后效

### 📖 深度展开

#### 自定义管线架构总览

```
CustomRenderPipeline (自定义管线资源)
  ├── CustomFlow: ShadowFlow (阴影阶段)
  │    └── ShadowPass
  ├── CustomFlow: MainFlow (主渲染)
  │    ├── OpaquePass (不透明物体)
  │    ├── CustomPass: OutlinePass (描边) ← 自定义插入
  │    └── TransparentPass (透明物体)
  └── CustomFlow: PostProcessFlow (后处理)
       ├── BloomPass
       ├── ColorGradingPass
       └── FXAAPass
```

#### 创建自定义 RenderPipeline（3.8+ API）

```typescript
import { pipeline, Renderer } from 'cc';

// 1. 继承自定义 Pipeline
class CartoonPipeline extends pipeline.ForwardPipeline {
    public outlinePass: pipeline.RenderPass;

    setup(): void {
        // 创建自定义 Pass
        this.outlinePass = new pipeline.RenderPass(
            'OutlinePass',
            0  // priority, 在不透明之后、透明之前
        );

        // 设置 Pass 的 RenderTarget
        this.outlinePass.setRenderTarget(
            this.outlineTexture,
            pipeline.LoadOp.CLEAR,
            pipeline.StoreOp.STORE
        );

        // 添加到 Flow 中
        const mainFlow = this.getFlow('ForwardFlow');
        mainFlow.insertPass(this.outlinePass, 1); // 插入到 OpaquePass 之后
    }
}

// 2. 注册自定义管线
Renderer.registerCustomPipeline('cartoon', () => new CartoonPipeline());
```

#### 描边效果 Effect 文件（简化版）

```glsl
// outline.effect (片段着色器核心逻辑)
CCProgram outline-fs %{
    void main() {
        // 1. 采样深度图，做边缘检测
        vec4 depth = CCGetDepth(uv);
        float edge = SobelEdge(depth.rgb);

        // 2. 采样法线图，检测法线突变
        vec3 normal = CCGetNormal(uv);
        float normalEdge = SobelEdge(normal);

        // 3. 合并边缘
        float outline = max(edge, normalEdge) * uOutlineWidth;
        gl_FragColor = vec4(uOutlineColor.rgb * outline, outline);
    }
}%
```

#### Post Process 链式后效（3.8+）

```typescript
import { PostProcess, Bloom, ColorGrading } from 'cc';

// 在场景中添加 PostProcess 组件
const postProcess = node.addComponent(PostProcess);

// 添加 Bloom 效果
const bloom = postProcess.addEffect(Bloom);
bloom.threshold = 0.8;
bloom.intensity = 1.5;
bloom.radius = 0.6;

// 添加色彩校正
const colorGrading = postProcess.addEffect(ColorGrading);
colorGrading.temperature = 0.1;   // 暖色调
colorGrading.contrast = 1.2;
```

#### 自定义管线 vs 内置管线对比

| 维度 | 内置 Forward 管线 | 自定义管线 |
|------|------------------|-----------|
| 渲染效果 | 标准 PBR | 可实现卡通/水墨/像素等风格 |
| 性能开销 | 经过优化 | 额外 Pass 有开销，需权衡 |
| 开发成本 | 零配置 | 需要编写 Effect + Pass 逻辑 |
| 适用场景 | 大多数 3D 项目 | 风格化渲染、需要后处理的项目 |
| 多 Pass 支持 | 有限 | 完全可控 |

#### RenderPass 的核心配置项

```typescript
interface PassConfig {
    phase: string;              // 渲染阶段：shadow / forward / transparent
    priority: number;           // Pass 排序优先级
    renderTarget?: RenderTarget; // 输出目标（屏幕 / RT）
    clearColor?: Color;          // 清屏颜色
    clearFlags: ClearFlags;      // 清除标记（颜色/深度/模板）
    viewport?: Rect;             // 视口区域
    materials: Material[];       // 该 Pass 使用的材质
}
```

### ⚡ 实战经验

1. **RenderTarget 复用**：自定义 Pass 中间结果如果不需要保留，务必复用同一个 RenderTarget 轮替使用（ping-pong），否则 VRAM 占用会翻倍。尤其在移动端，多开一个全屏 RT 就是多几 MB 显存。
2. **Pass 排序陷阱**：`priority` 值越小越先渲染。描边 Pass 必须放在 Opaque 之后（才能读到深度缓冲），但要在 Transparent 之前（避免半透明物体被描边干扰）。
3. **移动端性能红线**：每增加一个全屏后处理 Pass，移动端 GPU 负载增加约 15-25%。Bloom + FXAA + ColorGrading 三件套在中低端 Android 上可能直接掉到 30fps。建议根据设备分级动态开关后效。
4. **调试自定义 Pass**：在 Cocos DevTools 的 Render 面板中可以单独查看每个 Pass 的输出结果。先确认中间 RT 的内容正确，再串联后续 Pass。

### 🔗 相关问题

- 如何在 Cocos 中实现水彩/水墨风格化渲染？
- 多 Pass 渲染的 GPU 性能开销如何评估？
- Cocos 的后处理和 Unity Post Processing Stack 有何异同？
