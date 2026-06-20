---
title: "Unity Frame Debugger 怎么用？如何分析和优化 DrawCall？"
category: "unity"
level: 2
tags: ["Frame Debugger", "DrawCall", "性能优化", "调试工具"]
related: ["unity/drawcall-batching", "unity/profiler-deep-dive"]
hint: "Frame Debugger 是 Unity 渲染调试的第一利器——你能看到每一帧的每一个 DrawCall"
---

## 参考答案

### ✅ 核心要点

1. **Frame Debugger 位置**：Window → Analysis → Frame Debugger（快捷键无默认绑定，建议自定义）
2. **逐 DrawCall 回放**：可以一步步查看 GPU 渲染命令的执行顺序、使用的 Shader、材质、纹理
3. **合批验证**：直接看到哪些被合批了（Batch）、哪些没有（Reason for no batch）
4. **Show Mesh Stats**：显示每个 DrawCall 的顶点数、三角形数、纹理大小
5. **结合 Profiler**：Frame Debugger 看"做了什么"，Profiler 看"花了多久"，两者配合定位性能瓶颈

### 📖 深度展开

#### Frame Debugger 界面解读

```
Frame Debugger
┌───────────────────────────────────────────────┐
│ [Enable]  ← 点击开始抓帧                       │
├───────────────────────────────────────────────┤
│ ▼ Render Loop                                  │
│   ▼ URP Forward                               │
│     ▼ Opaque Objects                          │
│       ✅ Batch (SRP Batcher)    ← 合批成功     │
│       ✅ Batch (Static Batching)               │
│       ❌ Draw Mesh (Dynamic)    ← 未合批       │
│           Reason: Different Materials          │
│       ❌ Draw Mesh (Dynamic)                   │
│           Reason: Multi-pass Shader            │
│     ▼ Transparent Objects                      │
│       ❌ Draw Mesh             ← 透明物体不合批 │
│           Reason: Objects in Transparent Queue │
│     ▼ Post Processing                          │
│       Draw Fullscreen Triangle                 │
└───────────────────────────────────────────────┤
│ Mesh: Sphere | Verts: 515 | Tris: 768         │
│ Shader: Universal Render Pipeline/Lit          │
│ Material: Mat_Hero                             │
│ Texture: hero_diffuse (1024x1024 BC7)         │
└───────────────────────────────────────────────┘
```

#### 常见 "Reason for no batch" 原因及对策

| 原因 | 说明 | 解决方案 |
|------|------|----------|
| **Different Materials** | 材质实例不同 | 确保共用同一个材质 Asset（不是实例化的副本） |
| **Different Lighting** | 受不同光照影响 | 减少实时光源数量，使用烘焙光照 |
| **Multi-pass Shader** | Shader 有多个 Pass | 改为单 Pass Shader |
| **Shadow Casting** | 阴影投射打断合批 | 合并阴影投射者，或关闭小物体的阴影 |
| **Different Textures** | 主纹理不同 | 使用图集（Sprite Atlas / Texture Array） |
| **Sorting Layer / Render Queue** | 渲染队列不同 | 统一 Queue 值 |
| **Instancing Disabled** | GPU Instancing 未开启 | 材质面板勾选 Enable GPU Instancing |
| **Non-static Dynamic Object** | 动态物体不满足动态批处理条件 | 减少顶点数（<300）或改用 GPU Instancing |
| **Real-time Light in Forward** | 前向渲染逐像素光源 | 使用附加光源（Additional Lights）逐顶点模式 |

#### 分析流程：从 Frame Debugger 到优化

```
Step 1: 抓一帧，记录总 DrawCall 数和 Batch 数
  ↓
Step 2: 逐层级展开，找 ❌ 标记的未合批项
  ↓
Step 3: 阅读 "Reason for no batch"
  ↓
Step 4: 分类问题：
  ├── 材质问题 → 合并材质 / 使用 Material Property Block
  ├── 纹理问题 → 打图集
  ├── 光照问题 → 烘焙 / 减少光源
  ├── Shader 问题 → 简化 Pass / 使用 SRP Batcher 兼容
  └── 拓扑问题 → 合并 Mesh / 减少顶点数
  ↓
Step 5: 修改后重新抓帧对比
```

#### Material Property Block 技巧（不创建材质副本）

```csharp
// ❌ 错误做法：每个实例创建材质副本（无法合批）
renderer.material.SetColor("_BaseColor", color); // material 属性会自动创建副本

// ✅ 正确做法：使用 MaterialPropertyBlock（不破坏合批）
var block = new MaterialPropertyBlock();
renderer.GetPropertyBlock(block);
block.SetColor("_BaseColor", color);
renderer.SetPropertyBlock(block);

// ⚠️ 注意：SRP Batcher 对 MaterialPropertyBlock 的支持有限
// URP/HDRP 下使用 MPB 可能会打断 SRP Batcher
// 如果大量同材质不同颜色的物体，GPU Instancing + MPB 是最佳方案
```

#### SRP Batcher 兼容性检查

```csharp
// SRP Batcher 要求 Shader 中所有 CBUFFER 常量在同一个 CBUFFER_START 中
// 不兼容的 Shader 会在 Frame Debugger 中显示：
// "SRP Batcher: Batcher Not Compatible: Material XYZ"

// ✅ 兼容 SRP Batcher 的 Shader 结构
CBUFFER_START(UnityPerMaterial)
    float4 _BaseColor;
    float4 _MainTex_ST;
    float _Smoothness;
CBUFFER_END

// ❌ 不兼容 —— 使用了不在 CBUFFER 中的变量
// float4 _CustomColor; // 在 CBUFFER 外部声明
```

#### 与 Profiler 配合使用

| 工具 | 回答的问题 | 适用场景 |
|------|-----------|----------|
| **Frame Debugger** | 渲染命令"做了什么" | DrawCall 数量、合批状态、Shader 执行 |
| **Profiler (CPU)** | 渲染"花了多少 CPU 时间" | 渲染循环耗时、Batch 构建、Culling |
| **Profiler (GPU)** | 渲染"花了多少 GPU 时间" | Shader 复杂度、Overdraw、带宽 |
| **Rendering Statistics** | 实时全局统计面板 | 快速查看 Batch/DrawCall/SetPass 变化 |

#### Rendering Statistics 窗口关键字段

```
Rendering Statistics
 Batches: 47          ← 合批后的提交批次
 Saved by batching: 231 ← 被合批省掉的 DrawCall 数
 Tris: 158K           ← 三角形总数
 Verts: 94K           ← 顶点总数
 SetPass: 12          ← Shader Pass 切换次数（越少越好）
 Screen: 1080 × 1920
 Used Textures: 67 × VRAM: 245MB
```

### ⚡ 实战经验

1. **先看 SetPass 再看 DrawCall**——很多时候 DrawCall 数不高但帧率低，原因是 SetPass（Shader Pass 切换）过多。每次切换 Shader Pass 都会触发 GPU 管线重置，代价比多几个 DrawCall 还大。优化优先级：减少 Shader 变体 > 减少 SetPass > 减少 DrawCall。
2. **Frame Debugger 在真机上也能用**——通过连接 Android/iOS 设备运行 Development Build，Frame Debugger 可以抓到真机渲染数据。真机的合批行为可能和 Editor 不同（尤其是 GPU 驱动差异），一定要在真机上验证。
3. **UI 是隐藏的 DrawCall 杀手**——Frame Debugger 里 UI 渲染经常占了一半以上的 DrawCall。常见问题：不同 Atlas 的 UI 元素互相穿插（按层级交错）、Text 组件使用不同字体、多余的 Canvas 分割。用 Frame Debugger 定位 UI 的 DrawCall 断点非常直观。
4. **动态批处理有 300 顶点上限**——超过 300 顶点的 Mesh 不会动态合批。一个简单的 Quad（4顶点）可以，但稍复杂的模型就不行。这时候应该转用 GPU Instancing 或 Static Batching。

### 🔗 相关问题

- SRP Batcher、Static Batching、Dynamic Batching、GPU Instancing 四者有什么区别和适用场景？
- 如何减少 UI 系统的 DrawCall？
- Unity Profiler 的渲染模块各项指标如何解读？
