---
title: "Unity VFX Graph 与 Particle System 有何区别？如何选择？"
category: "unity"
level: 2
tags: ["VFX Graph", "粒子系统", "渲染", "GPU"]
related: ["unity/shader-graph-deep-dive", "unity/urp-render-pipeline"]
hint: "一个跑在 CPU，一个跑在 GPU——想想百万粒子场景该选谁？"
---

## 参考答案

### ✅ 核心要点

1. **Particle System（Shuriken）**：CPU 驱动的传统粒子系统，灵活易用，适合中小规模（< 10万粒子）
2. **VFX Graph**：GPU 驱动的节点式特效工具，支持百万级粒子，需配合 SRP（URP/HDRP）
3. **核心差异**：计算位置——CPU 逐粒子更新 vs GPU 批量并行计算
4. **VFX Graph 依赖 Compute Shader**：不支持 OpenGL ES 2.0 / 部分低端 Android 设备
5. **选择策略**：移动端中小特效用 Particle System，主机/PC 大规模特效用 VFX Graph

### 📖 深度展开

#### 架构对比

```
Particle System (Shuriken)
┌─────────────────────────┐
│  CPU 主线程               │
│  ├── Emitter (发射器)     │
│  ├── Simulator (模拟器)   │ ← 逐粒子计算
│  ├── Renderer (渲染器)    │
│  └── → 提交 DrawCall     │
└─────────────────────────┘
  瓶颈：CPU 计算量 ∝ 粒子数

VFX Graph
┌─────────────────────────┐
│  GPU (Compute Shader)    │
│  ├── Spawn (GPU 发射)    │
│  ├── Initialize (初始化)  │ ← 并行计算
│  ├── Update (更新)       │ ← 全部在 GPU
│  ├── Output (输出渲染)    │
│  └── → 直接渲染          │
└─────────────────────────┘
  瓶颈：GPU 显存 & 带宽
```

#### 详细对比表

| 维度 | Particle System (Shuriken) | VFX Graph |
|------|--------------------------|-----------|
| 计算位置 | CPU | GPU (Compute Shader) |
| 最大粒子数 | ~1-5万（实际可用） | 百万级 |
| 编辑方式 | Inspector 参数面板 | 节点编辑器 |
| SRP 依赖 | 无（Built-in 支持） | 必须 URP/HDRP |
| 平台兼容 | 全平台 | 不支持 GLES 2.0，移动端需验证 |
| 模块化复用 | ParticleSystem 模块 | VFX Template / Subgraph |
| 与 Shader 交互 | Material 属性 | 直接对接 Shader Graph |
| 物理交互 | Collision Module（CPU） | GPU Collision（有限） |
| 学习曲线 | 低 | 中高（节点式思维） |

#### VFX Graph 的 Context 架构

```
Spawn (持续/脉冲发射)
  ↓
Initialize (粒子初始化: 位置/速度/大小/颜色)
  ↓
Update (每帧更新: 力场/碰撞/生命周期)
  ↓
Output (Quad/Mesh/Line 输出到屏幕)
```

**每个 Block 都是 GPU Compute Kernel 的一部分**，节点图最终编译为 Compute Shader。

#### 代码控制 VFX Graph

```csharp
using UnityEngine.VFX;

public class VFXController : MonoBehaviour
{
    [SerializeField] private VisualEffect _vfx;

    void Start()
    {
        // 设置属性（直接传 GPU）
        _vfx.SetFloat("SpawnRate", 500f);
        _vfx.SetVector3("Origin", transform.position);
        _vfx.SetGradient("ColorOverLife",
            new Gradient
            {
                colorKeys = new GradientColorKey[]
                {
                    new(Color.white, 0f),
                    new(Color.red, 1f)
                }
            });
    }

    // GPU Event: 从一个 VFX 触发另一个
    public void OnDeathEffect()
    {
        // SendEvent 触发 Burst Spawn
        _vfx.SendEvent("OnDeath");
    }
}
```

#### GPU Event 链式特效

VFX Graph 独有的 **GPU Event** 可以实现粒子级联：

```
主粒子 (火花)
  ↓ GPU Event (OnCollide)
次级粒子 (碰撞烟雾)
  ↓ GPU Event (OnDie)
三级粒子 (余烬飘散)
```

整个过程在 GPU 内完成，零 CPU 开销。这在 Particle System 中需要 `Sub Emitters` + CPU 计算。

#### 移动端适配策略

```csharp
// 运行时检测 VFX Graph 支持
public static bool IsVFXGraphSupported()
{
    // VFX Graph 需要 Compute Shader 支持
    return SystemInfo.supportsComputeShaders &&
           SystemInfo.graphicsDeviceType != GraphicsDeviceType.OpenGLES2;
}

// 降级策略：低端设备用 Particle System
void Awake()
{
    if (IsVFXGraphSupported())
        _vfxVFX.gameObject.SetActive(true);
    else
        _fallbackParticleSystem.gameObject.SetActive(true);
}
```

### ⚡ 实战经验

- **不要在移动端滥用 VFX Graph**：虽然计算在 GPU，但百万粒子的渲染（Overdraw）会迅速填满移动端 GPU 的像素带宽，导致严重发热和掉帧
- **Particle System 的 Sub Emitters 仍然好用**：对于碰撞溅射、死亡爆炸等次级特效，Shuriken 的 Sub Emitters 足够，不必为了"技术先进"上 VFX Graph
- **VFX Graph 调试困难**：节点编辑器无法像 C# 一样断点调试，建议在 Output 节点前加 Debug 节点查看粒子数据
- **混合使用是最佳实践**：环境氛围雾/大面积火焰用 VFX Graph，武器刀光/UI 特效用 Particle System

### 🔗 相关问题

- VFX Graph 的 Output Mesh 粒子和 Quad 粒子在性能上有什么区别？
- 如何在 VFX Graph 中实现与场景物体的碰撞检测？
- Compute Shader 在不同 GPU 架构上的兼容性如何处理？
