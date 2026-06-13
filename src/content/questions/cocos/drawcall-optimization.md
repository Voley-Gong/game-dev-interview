---
title: "Cocos Creator 中 DrawCall 优化有哪些策略？"
category: "cocos"
level: 2
tags: ["性能优化", "渲染", "DrawCall"]
related: ["cocos/render-pipeline"]
hint: "思考 Cocos 渲染流程中哪些环节会影响 DrawCall 数量。"
---

## 参考答案

### ✅ 核心要点

1. **合批（Batch）** — 减少材质和纹理切换次数
2. **动态合图（Dynamic Atlas）** — 自动合并小图到同一张纹理
3. **减少节点层级** — 过深的节点树增加遍历和合批复杂度
4. **合理使用图集（Atlas）** — 将相关 Sprite 打包到同一图集

### 📖 深度展开

Cocos Creator 的渲染流程中，每次 DrawCall 意味着一次 CPU 向 GPU 提交绘制命令。DrawCall 越多，CPU 开销越大。

**影响 DrawCall 的主要因素：**

1. **材质切换**：不同材质无法合批
2. **纹理切换**：不同纹理无法合批（动态合图可缓解）
3. **渲染状态变化**：Blend 模式、Depth Test 等状态变化打断合批
4. **渲染组件间断**：UI 和 2D/Sprite 交叉排列会打断合批

**常用优化策略：**

```typescript
// 1. 开启动态合图（默认开启，确认未被关闭）
dynamicAtlasManager.enabled = true;

// 2. 使用图集
// 将相关 Sprite 放入同一 Atlas，减少纹理切换

// 3. 同类组件排列在一起
// 把所有 Sprite 排在一起，Label 排在一起
// 避免 Sprite → Label → Sprite 交叉排列

// 4. 设置静态合批标记（Cocos 3.x）
// 对不移动的节点设置 static 属性
```

### ⚡ 实战经验

- **中文字体是 DrawCall 大户**：每个 Label 使用不同文本内容可能打断合批，考虑位图字体（BMFont）方案
- **合图不是万能的**：过大图集浪费显存，需要平衡
- **Profile 先行**：先用 DevTools Profiler 定位瓶颈，别盲目优化
- **合批组件中断**：注意 UI 组件（Mask、Graphics）会打断合批

### 🔗 相关问题

- Cocos Creator 渲染管线流程是怎样的？
- 如何分析和定位性能瓶颈？
