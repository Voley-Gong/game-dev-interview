---
title: "Cocos Creator 3.x 渲染管线流程是怎样的？"
category: "cocos"
level: 2
tags: ["渲染管线", "引擎原理"]
related: ["cocos/drawcall-optimization"]
hint: "从场景树遍历到最终上屏，中间经历了哪些阶段？"
---

## 参考答案

### ✅ 核心要点

1. **场景树遍历** → 收集可见渲染组件
2. **裁剪与排序** → 视锥裁剪 + 透明度排序
3. **合批处理** → 同材质/同纹理合并 DrawCall
4. **绘制提交** → 通过 GPU 执行渲染命令
5. **后处理** → 后效和上屏

### 📖 深度展开

Cocos Creator 3.x 采用自定义渲染管线（Render Pipeline）架构：

```
Scene (场景树)
  ↓ 遍历 (Traverse)
Render Scene (渲染场景)
  ↓ 收集可渲染对象
Render Flow (渲染流程)
  ↓ 多个 Render Pass
  ├── ShadowPass (阴影)
  ├── ReflectPass (反射)
  ├── MainPass (主渲染)
  │    ├── Cull (裁剪)
  │    ├── Sort (排序)
  │    ├── Batch (合批)
  │    └── Draw (绘制)
  └── PostProcess (后处理)
  ↓
Frame Buffer → 屏幕
```

**关键概念：**

- **RenderPipeline**：可自定义的渲染管线，控制整个渲染流程
- **RenderFlow**：管线中的一个阶段（如 Shadow、Forward）
- **RenderPass**：Flow 中的具体 Pass
- **Batch2D / Batcher2D**：2D 渲染的专用合批器

**3.x vs 2.x 的区别：**

| 维度 | 2.x | 3.x |
|------|-----|-----|
| 渲染架构 | 固定管线 | 可定制 Render Pipeline |
| 材质系统 | 简单 | 基于 Material Instance |
| 3D 渲染 | 有限 | 完整 PBR 支持 |
| 合批策略 | 内置自动 | 更灵活的合批控制 |

### ⚡ 实战经验

- 理解渲染管线是性能优化的基础，遇到渲染问题先看是哪个阶段瓶颈
- 使用 DevTools 的 Render 面板可以看到 DrawCall 数和批次信息
- 自定义 RenderPipeline 可以实现特殊渲染效果（如卡通渲染）

### 🔗 相关问题

- DrawCall 优化有哪些策略？
- 如何实现自定义 Shader？
