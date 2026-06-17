---
title: "Unity 中 Draw Call 优化有哪些手段？SRP Batcher、Dynamic Batching、GPU Instancing 的区别是什么？"
category: "unity"
level: 2
tags: ["性能优化", "DrawCall", "Batching", "GPU Instancing", "SRP Batcher"]
related: ["unity/urp-render-pipeline"]
hint: "从合批条件、适用场景、性能瓶颈三个层面分析每种优化手段的差异。"
---

## 参考答案

### ✅ 核心要点

1. **Draw Call 是 CPU 向 GPU 提交绘制命令的过程**，频繁的状态切换（材质、Shader、纹理）是主要瓶颈，而非 GPU 绘制本身
2. **SRP Batcher**：同 Shader 的材质不需要合批即可减少 GPU 状态切换，是 URP/HDRP 下最通用的优化（不改变 Mesh 和材质结构）
3. **Dynamic Batching**：CPU 端将小网格顶点变换后合并，适合少量小物体（<300 顶点），有 CPU 开销
4. **Static Batching**：编译时合并静态网格，零运行时开销，但会增加内存（合并后的 Mesh 副本）
5. **GPU Instancing**：相同 Mesh + 相同 Material 的多个对象通过一次 Draw Call 绘制，适合大量重复物体（树木、草地、子弹）

### 📖 深度展开

#### 四种合批技术对比

| 特性 | SRP Batcher | Dynamic Batching | Static Batching | GPU Instancing |
|------|-------------|------------------|-----------------|----------------|
| 合并层级 | GPU 状态合并 | CPU 顶点合并 | CPU Mesh 合并 | GPU 实例化 |
| Mesh 要求 | 任意 | <300 顶点 | 静态标记 | 必须相同 Mesh |
| Material 要求 | 相同 Shader | 相同 Material | 可不同 Material | 相同 Material |
| 运行时开销 | 极低 | CPU 变换计算 | 无（预合并） | 低（传实例数据） |
| 内存开销 | 无 | 无 | 高（Mesh 副本） | 低 |
| 可变换位置 | ✅ | ✅ | ❌（静态） | ✅ |
| URP 必须 | ✅（需 SRP） | ❌ | ❌ | ❌ |

#### Draw Call 产生流程

```
CPU 端                               GPU 端
┌─────────────────────┐            ┌─────────────────┐
│ 遍历可见渲染器        │            │                 │
│  ├─ 设置 Shader      │ ────────→ │  设置管线状态     │
│  ├─ 设置 Material    │ ────────→ │  (SetPassCall)   │
│  ├─ 设置 Texture     │ ────────→ │                 │
│  ├─ 设置 Transform   │            │                 │
│  └─ 提交 Draw Call   │ ────────→ │  执行绘制         │
└─────────────────────┘            └─────────────────┘
```

**性能瓶颈在 CPU 侧**：每次状态切换（SetPassCall）都涉及大量驱动层指令，所以优化核心是减少状态切换次数，而非减少三角形数。

#### GPU Instancing 实现示例

```csharp
// 直接绘制大量相同网格 —— 不需要 GameObject
public class GrassRenderer : MonoBehaviour
{
    public Mesh grassMesh;
    public Material grassMaterial;
    public int instanceCount = 10000;
    public Vector3 areaSize = new Vector3(100, 0, 100);

    private GraphicsBuffer positionBuffer;

    void Start()
    {
        // 准备所有实例的位置数据
        Vector3[] positions = new Vector3[instanceCount];
        for (int i = 0; i < instanceCount; i++)
        {
            positions[i] = new Vector3(
                Random.Range(-areaSize.x / 2, areaSize.x / 2),
                0,
                Random.Range(-areaSize.z / 2, areaSize.z / 2)
            );
        }
        positionBuffer = new GraphicsBuffer(
            GraphicsBuffer.Target.Structured,
            instanceCount, sizeof(float) * 3);
        positionBuffer.SetData(positions);
    }

    void Update()
    {
        // 一次 Draw Call 绘制全部草
        Graphics.DrawMeshInstancedIndirect(
            grassMesh, 0, grassMaterial,
            new Bounds(Vector3.zero, areaSize),
            positionBuffer);
    }

    void OnDestroy()
    {
        positionBuffer?.Release();
    }
}
```

对应的 Shader 需要启用 Instancing：

```hlsl
#pragma multi_compile_instancing

struct Attributes
{
    float4 positionOS : POSITION;
    UNITY_VERTEX_INPUT_INSTANCE_ID // 必须添加
};

struct Varyings
{
    float4 positionCS : SV_POSITION;
    UNITY_VERTEX_INPUT_INSTANCE_ID
};

Varyings vert(Attributes input, uint instanceID : SV_InstanceID)
{
    Varyings output = (Varyings)0;
    UNITY_SETUP_INSTANCE_ID(input);
    // 从 StructuredBuffer 读取该实例的位置偏移
    float3 instancePos = _PositionBuffer[instanceID];
    float3 worldPos = input.positionOS.xyz + instancePos;
    output.positionCS = TransformWorldToHClip(worldPos);
    return output;
}
```

#### 合批断裂的常见原因

```
✅ 可以合批                    ❌ 打断合批
─────────────────────────────────────────────
相同 Shader                   不同 Shader（SRP Batcher 也失效）
相同 Material（实例化除外）     引用了不同纹理（未使用图集）
相同 Light Map                不同 Light Map Index
相同 Shadow Pass 设置          开启了额外的 Light / 阴影
```

### ⚡ 实战经验

- **用 Frame Debugger 诊断**：遇到 Draw Call 异常偏高，第一步永远是用 Frame Debugger 逐帧查看，它会明确告诉你为什么某个批次没有合并（"Node A and B use different materials"）
- **图集是大前提**：UGUI 中不同图片会使用不同 Material（因为纹理不同），必须打图集（Sprite Atlas）让多个 UI 元素共享同一个 Material 才能合批
- **GPU Instancing 与 SRP Batcher 互斥**：同一个对象只能二选一。大量重复简单网格优先用 GPU Instancing；普通场景的多样化对象靠 SRP Batcher
- **移动端 Static Batching 的内存陷阱**：Static Batching 会生成合并后的完整 Mesh 数据，大场景下内存可能翻倍，移动端需要权衡内存与 Draw Call

### 🔗 相关问题

- 如何使用 Unity Frame Debugger 分析 Draw Call 链路？
- UGUI 的 Canvas 拆分策略对 Draw Call 有什么影响？
- 大场景（开放世界）中如何平衡 LOD、合批和内存？
