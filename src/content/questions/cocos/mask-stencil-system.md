---
title: "Cocos Creator 中 Mask 遮罩与 Stencil 裁剪的原理是什么？"
category: "cocos"
level: 3
tags: ["Mask", "Stencil", "裁剪", "UI系统", "渲染原理"]
related: ["cocos/ui-system", "cocos/render-pipeline", "cocos/drawcall-optimization"]
hint: "Mask 不仅裁剪像素，它还会打断 DrawCall 合批——理解 Stencil 缓冲区是关键。"
---

## 参考答案

### ✅ 核心要点

1. **Mask 本质** → 利用 GPU 的 Stencil Buffer（模板缓冲区）实现像素级裁剪
2. **渲染流程** → 先绘制遮罩区域写入 Stencil → 再绘制子节点时检查 Stencil 决定是否渲染
3. **合批打断** → Mask 节点会强制中断 DrawCall 合批，因为需要不同的 Stencil 状态
4. **三种 Mask 类型** → GRAPHICS_RECT（矩形）、GRAPHICS_ELLIPSE（椭圆）、GRAPHICS_STENCIL（自定义图形）
5. **性能影响** → 嵌套 Mask 会导致 Stencil 值叠加，增加 GPU 渲染开销

### 📖 深度展开

#### Stencil Buffer 工作原理

GPU 渲染时除了颜色缓冲和深度缓冲外，还有一个 **Stencil Buffer（模板缓冲区）**，通常每个像素 8-bit：

```
渲染阶段 1：绘制 Mask 区域
  → 在 Mask 形状覆盖的像素上，Stencil Buffer 写入值（如 1）
  → 不覆盖的像素保持默认值（0）

渲染阶段 2：绘制子节点（被 Mask 裁剪的内容）
  → GPU 对每个片元检查 Stencil 值
  → Stencil == 1？渲染该像素
  → Stencil == 0？丢弃该像素（discard）

渲染阶段 3：恢复 Stencil
  → Mask 区域外重新清零 Stencil Buffer
  → 后续渲染恢复正常状态
```

#### Mask 对 DrawCall 的影响

```
UI 节点树：
├── Node_A (Sprite, atlas1)      ← DrawCall 1
├── Mask_Node
│    ├── Sprite_B (atlas1)       ← DrawCall 2（Mask 开始，强制新批次）
│    ├── Sprite_C (atlas1)       ← 合批到 DrawCall 2（同 Stencil 状态）
│    └── Sprite_D (atlas1)       ← 合批到 DrawCall 2
├── Node_E (Sprite, atlas1)      ← DrawCall 3（Mask 结束，Stencil 恢复，新批次）

即使所有 Sprite 使用同一图集，Mask 仍会导致 3 个 DrawCall
```

#### 三种 Mask 类型对比

| 类型 | 说明 | 性能 | 适用场景 |
|------|------|------|---------|
| RECT (矩形) | 矩形区域裁剪 | 最优（GPU 可做 Scissor Test） | 滚动列表、背包格子 |
| ELLIPSE (椭圆) | 椭圆区域裁剪 | 中等（需 Stencil） | 头像圆形裁剪 |
| GRAPHICS_STENCIL | 自定义图形裁剪 | 最差（复杂 Stencil 写入） | 不规则形状遮罩 |

> 💡 矩形 Mask 在 Cocos 3.x 中可能被优化为 GPU Scissor Test，跳过 Stencil 流程，性能显著优于其他两种。

#### 代码：ScrollView 中的 Mask 应用

```typescript
import { ScrollView, Mask, UITransform, view } from 'cc';

// 程序化创建带 Mask 的滚动视图
function createScrollView(parent: Node) {
    // 1. 容器节点
    const container = new Node('ScrollView');
    const transform = container.addComponent(UITransform);
    transform.setContentSize(300, 400);
    container.parent = parent;

    // 2. 添加 Mask 组件（矩形裁剪）
    const mask = container.addComponent(Mask);
    mask.type = Mask.Type.GRAPHICS_RECT;

    // 3. 内容节点（实际滚动内容）
    const content = new Node('Content');
    const contentTransform = content.addComponent(UITransform);
    contentTransform.setAnchorPoint(0.5, 1);
    contentTransform.setContentSize(300, 800);
    content.parent = container;

    // 4. ScrollView 组件
    const scrollView = container.addComponent(ScrollView);
    scrollView.content = content;
}
```

#### 嵌套 Mask 的 Stencil 值叠加

```
外层 Mask（Stencil 值 = 1）
  └── 内层 Mask（Stencil 值 = 2）
       └── 子节点需要 Stencil == 2 才渲染

每多一层嵌套，GPU 需要做一次额外的 Stencil 比较，
且每次 Mask 边界切换都会打断合批。

建议：
- 避免超过 2 层嵌套 Mask
- 如果只需要矩形裁剪，用 RECT 类型而非自定义图形
```

#### Mask vs 自定义 Shader 裁剪

| 维度 | Mask (Stencil) | Shader 裁剪 (discard/clip) |
|------|----------------|---------------------------|
| 实现方式 | GPU 管线固定功能 | Fragment Shader 中 discard |
| 灵活性 | 固定形状 | 任意裁剪逻辑 |
| 性能 | 移动端友好（硬件加速） | 取决于 Shader 复杂度 |
| 合批影响 | 强制打断合批 | 不打断合批（同一材质内） |
| 适用场景 | UI 裁剪 | 特殊效果（溶解、遮罩动画） |

### ⚡ 实战经验

- **列表项的 Mask 是性能杀手**：背包 50 个格子，每格用独立 Mask → 50+ DrawCall。解决方案：整个列表用一个外层 Mask，内部格子不用 Mask
- **圆形头像不要用 ELLIPSE Mask**：更优的方案是用一张圆形透明遮罩图 + Sprite 的 `SpriteFrame` 做混合，或者直接用自定义 Shader 在 Fragment 阶段 discard，避免 Stencil 开销
- **Mask 的反向裁剪**：3.x 中可以通过设置 `inverted` 属性实现"只显示遮罩区域外"的效果，但这会增加 GPU 开销
- **调试 Mask 不生效**：检查 `Mask` 组件是否和 `UITransform` 共存，且节点的 Layer 是否在相机的可见层内

### 🔗 相关问题

- ScrollView 的性能优化有哪些策略？（虚拟列表、分帧创建）
- 如何用自定义 Shader 实现高级遮罩效果（渐变遮罩、动态遮罩）？
- Stencil Buffer 在 WebGL 和原生渲染（Metal/Vulkan）下的实现差异？
