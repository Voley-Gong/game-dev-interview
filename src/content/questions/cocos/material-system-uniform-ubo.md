---
title: "Cocos Creator 材质系统：Uniform、UBO 与渲染排序是怎样的机制？"
category: "cocos"
level: 3
tags: ["材质系统", "Uniform", "UBO", "渲染排序", "Shader"]
related: ["cocos/render-pipeline", "cocos/shader-fundamentals", "cocos/drawcall-optimization"]
hint: "从 Uniform 变量的绑定到 UBO 内存布局，再到材质实例的排序合批，串起整个材质管线。"
---

## 参考答案

### ✅ 核心要点

1. **材质（Material）** = Shader（EffectAsset）+ 参数集（Uniforms），是渲染对象的外观描述
2. **Uniform** 是 Shader 中"全局常量"的声明方式，运行时由引擎绑定实际值
3. **UBO（Uniform Buffer Object）** 是 GPU 端的内存块，用于批量传递 Uniform 数据，减少 CPU→GPU 通信开销
4. **Pass 概念**：一个材质可包含多个 Pass（如 Shadow Pass + Opaque Pass + Outline Pass），每个 Pass 对应一次绘制
5. **渲染排序**：引擎按 Pass 的 `priority` → 材质 → 深度 → 合批可能性 等维度排序，决定绘制顺序

### 📖 深度展开

#### 材质的数据结构

```typescript
// Cocos Creator 3.x 材质系统核心关系
Material {
  effectAsset: EffectAsset;     // 引用的 Shader 资源
  techniques: number;           // 使用第几个 Technique
  passes: Pass[];               // 渲染通道数组
  defines: { [key: string]: string };  // 宏定义
  states: {                     // 渲染状态覆盖
    rasterizerState?: ...;
    blendState?: ...;
    depthStencilState?: ...;
  };
}

Pass {
  program: string;              // Shader 程序名
  properties: {                 // Uniform 默认值
    mainColor: { value: [1,1,1,1] },
    mainTexture: { value: null },
  };
  priority: number;             // Pass 优先级（影响排序）
  stage: number;                // 渲染阶段标记
}
```

#### Uniform 与 UBO 的关系

```glsl
// GLSL 中的 Uniform 声明（传统方式）
uniform vec3 u_cameraPos;
uniform float u_time;
uniform vec4 u_mainColor;

// UBO 方式（Cocos 3.x 内部使用）
layout(std140) uniform CommonUniforms {
  vec4 u_cameraPos;    // 注意：std140 布局有对齐规则
  vec4 u_mainColor;    // vec4 占 16 字节
  mat4 u_viewProj;     // mat4 占 64 字节
};
```

**std140 内存对齐规则（关键考点）：**

| 类型 | 大小 | 对齐 |
|------|------|------|
| `float` / `int` | 4B | 4B |
| `vec2` | 8B | 8B |
| `vec3` | 12B | **16B** ⚠️ |
| `vec4` | 16B | 16B |
| `mat4` | 64B | 16B |
| `struct` | 成员总和 | 最大成员对齐 |

> ⚠️ `vec3` 实际占 16 字节（末尾 4B 填充），这是最常见的 UBO 布局陷阱。

#### 引擎 Uniform 自动绑定

Cocos 引擎内置了若干系统级 Uniform，开发者无需手动设值：

```glsl
// Cocos 3.x 自动注入的内置 Uniform（部分）
uniform mat4 cc_matView;        // 视图矩阵
uniform mat4 cc_matViewProj;    // 视图投影矩阵
uniform mat4 cc_matWorld;       // 世界矩阵
uniform vec4 cc_time;           // 运行时间 (t, sin(t), cos(t), dt)
uniform vec4 cc_screenSize;     // 屏幕尺寸
uniform vec4 cc_cameraPos;      // 摄像机位置
```

在 TS 侧通过 `material.setProperty()` 设置自定义 Uniform：

```typescript
// 设置材质参数
const mat = renderableNode.getComponent(MeshRenderer).material;
mat.setProperty('mainColor', new Color(255, 0, 0, 255));
mat.setProperty('mainTexture', texture);
mat.setProperty('speed', 1.5);

// 通过宏定义切换 Shader 分支
mat.recompileShaders({ USE_TEXTURE: true, ENABLE_FOG: true });
```

#### 材质实例（Material Instance）与合批

```
同一 Material Asset
  ├── 实例 A（material.setProperty 修改了 mainColor）
  ├── 实例 B（未修改，使用默认值）
  └── 实例 C（修改了 mainTexture）

→ 实例 B 和 C 如果其他条件满足可以合批
→ 实例 A 因为 Uniform 不同，需要单独 DrawCall
```

**合批条件链：**

```
相同 Shader Program
  + 相同 Technique/Pass
  + 相同宏定义（Defines）
  + 相同渲染状态（Blend/Depth/Cull）
  + Uniform 参数一致（或使用 UBO 动态偏移）
  → 可以合批
```

#### 渲染排序流程

```
1. 收集所有可见渲染对象
2. 按 Pass.priority 分桶（不透明 / 透明 / 后处理）
3. 不透明队列：按 Shader → 材质 → 深度（前→后）排序
4. 透明队列：按深度（后→前）排序，不换材质
5. 遍历队列，尽量合批相邻同材质对象
6. 提交 DrawCall
```

### ⚡ 实战经验

1. **材质属性修改导致 DrawCall 暴涨**：每个 `setProperty` 都可能创建新的材质实例，导致合批失败。解决方案是用共享材质 + UBO 动态索引，或使用 `GPU Instancing`。
2. **vec3 对齐陷阱**：自定义 Shader 中 `vec3` 类型的 Uniform 在 UBO 中占 16 字节。如果服务端按 12 字节打包数据会导致数据错乱，务必用 `vec4` 或手动填充。
3. **宏定义触发重编译**：`recompileShaders` 会生成新的 Shader 变体，频繁切换宏会导致 Shader 编译卡顿。应在初始化时预编译好所有变体。
4. **Pass 的 priority 调控渲染顺序**：需要绘制描边（Outline）时，将 Outline Pass 的 priority 设为大于主 Pass，确保描边在后绘制。但注意深度测试配置，避免描边被遮挡。

### 🔗 相关问题

- Cocos Creator 渲染管线中，DrawCall 是如何被合并的？
- 如何编写自定义 Effect（.effect 文件）实现卡通渲染？
- GPU Instancing 与传统合批有什么区别？什么场景下选哪个？
