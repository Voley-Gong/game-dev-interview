---
title: "Unity Compute Shader 的原理与实战应用？"
category: "unity"
level: 3
tags: ["Compute Shader", "GPU编程", "性能优化", "渲染"]
related: ["unity/gpu-instancing", "unity/shader-material-system"]
hint: "什么时候应该把计算从 CPU 搬到 GPU？Compute Buffer 如何与渲染管线衔接？"
---

## 参考答案

### ✅ 核心要点

1. **GPU 通用计算（GPGPU）**：Compute Shader 利用 GPU 大规模并行计算能力，处理数值密集型任务
2. **线程与线程组**：GPU 以 Thread Group（线程组）为单位调度，每个线程组包含若干 Wavefront/Warp
3. **ComputeBuffer / StructuredBuffer**：CPU 与 GPU 之间的数据传输通道，需手动管理生命周期
4. **与渲染管线衔接**：Compute Shader 计算结果可直接作为 Vertex/Fragment 数据，无需 GPU Readback
5. **适用场景**：大规模粒子、流体模拟、视锥裁剪、GPU Skinning、Hair Simulation

### 📖 深度展开

#### Compute Shader 基础架构

```
CPU 端
  ├── 设置 ComputeBuffer (数据上传 GPU)
  ├── SetBuffer → ComputeShader
  ├── Dispatch(threadGroupsX, threadGroupsY, threadGroupsZ)
  ↓
GPU 端
  ├── Thread Group (线程组)
  │    ├── Wavefront (AMD) / Warp (NVIDIA) — 硬件调度单元
  │    │    ├── Thread 0 ... Thread 63
  │    │    └── SV_GroupIndex / SV_DispatchThreadID
  │    └── 共享组内存 (GroupShared Memory)
  └── 计算结果写入 UAV (Unordered Access View)
       → ComputeBuffer / RWTexture2D
```

#### 关键概念对比

| 概念 | CPU 端 | GPU 端 |
|------|--------|--------|
| 数据容器 | ComputeBuffer | RWStructuredBuffer / RWByteAddressBuffer |
| 纹理 | RenderTexture | RWTexture2D<float4> |
| 分发 | `Dispatch(x, y, z)` | `numthreads(x, y, z)` |
| 同步 | — | `GroupMemoryBarrier()` / `AllMemoryBarrier()` |
| 线程标识 | — | `SV_DispatchThreadID`, `SV_GroupID`, `SV_GroupThreadID` |

#### 完整示例：GPU 粒子系统

**Compute Shader (Particle.compute):**

```hlsl
#pragma kernel CSMain

struct Particle
{
    float3 position;
    float3 velocity;
    float life;
};

RWStructuredBuffer<Particle> _Particles;
float _DeltaTime;
float3 _Gravity;
int _ParticleCount;

[numthreads(64, 1, 1)]
void CSMain(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= _ParticleCount)
        return;

    Particle p = _Particles[id.x];

    // 更新速度和位置
    p.velocity += _Gravity * _DeltaTime;
    p.position += p.velocity * _DeltaTime;
    p.life -= _DeltaTime;

    // 简单边界反弹
    if (p.position.y < 0.0)
    {
        p.position.y = 0.0;
        p.velocity.y *= -0.5; // 阻尼反弹
    }

    _Particles[id.x] = p;
}
```

**C# 调度端:**

```csharp
public class GPUParticleSystem : MonoBehaviour
{
    public ComputeShader computeShader;
    public Material particleMaterial;
    public int particleCount = 100000;

    private ComputeBuffer particleBuffer;
    private ComputeBuffer argsBuffer;
    private int kernelId;

    struct Particle
    {
        public Vector3 position;
        public Vector3 velocity;
        public float life;
    }

    void Start()
    {
        kernelId = computeShader.FindKernel("CSMain");

        // 初始化粒子数据
        Particle[] particles = new Particle[particleCount];
        for (int i = 0; i < particleCount; i++)
        {
            particles[i] = new Particle
            {
                position = Random.insideUnitSphere * 10f,
                velocity = Random.insideUnitSphere * 2f,
                life = Random.Range(1f, 5f)
            };
        }

        // 创建 ComputeBuffer（每个 Particle 占 28 bytes）
        int stride = sizeof(float) * 7; // 3 + 3 + 1
        particleBuffer = new ComputeBuffer(particleCount, stride);
        particleBuffer.SetData(particles);

        // 设置 Compute Shader 参数
        computeShader.SetBuffer(kernelId, "_Particles", particleBuffer);

        // Indirect Draw 的参数 buffer
        // uint: indexCountPerInstance, instanceCount, startIndex, baseVertexIndex, startInstance
        argsBuffer = new ComputeBuffer(1, 5 * sizeof(uint), ComputeBufferType.IndirectArguments);
        uint[] args = new uint[5] { 0, (uint)particleCount, 0, 0, 0 };
        argsBuffer.SetData(args);

        // 生成 Mesh 用于渲染（单个四边形）
        // 实际项目中通常用 Procedural Draw 或 Points
    }

    void Update()
    {
        computeShader.SetFloat("_DeltaTime", Time.deltaTime);
        computeShader.SetVector("_Gravity", Physics.gravity);
        computeShader.SetInt("_ParticleCount", particleCount);
        computeShader.Dispatch(kernelId, Mathf.CeilToInt(particleCount / 64f), 1, 1);
    }

    void OnRenderObject()
    {
        particleMaterial.SetBuffer("_ParticleBuffer", particleBuffer);
        particleMaterial.SetPass(0);
        Graphics.DrawProceduralNow(MeshTopology.Points, particleCount);
    }

    void OnDestroy()
    {
        particleBuffer?.Release();
        argsBuffer?.Release();
    }
}
```

**渲染 Shader（将 Compute 结果渲染到屏幕）:**

```hlsl
Shader "Custom/GPUParticles"
{
    SubShader
    {
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment vert
            #include "UnityCG.cginc"

            struct Particle
            {
                float3 position;
                float3 velocity;
                float life;
            };

            StructuredBuffer<Particle> _ParticleBuffer;

            struct v2f
            {
                float4 pos : SV_POSITION;
                float life : TEXCOORD0;
            };

            v2f vert(uint id : SV_VertexID)
            {
                Particle p = _ParticleBuffer[id];
                v2f o;
                o.pos = UnityObjectToClipPos(float4(p.position, 1.0));
                o.life = p.life;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                return fixed4(1.0, 0.5, 0.2, saturate(i.life));
            }
            ENDCG
        }
    }
}
```

#### CPU vs GPU 计算对比

| 维度 | CPU 计算 | Compute Shader |
|------|----------|----------------|
| 并行度 | 几十线程 | 数万线程 |
| 延迟 | 低（直接访问） | 高（需数据传输） |
| 分支预测 | 强 | 弱（Warp Divergence） |
| 数据规模 | < 10K 适合 | > 10K 才有优势 |
| Readback | 直接读 | `AsyncGPUReadback`（非阻塞） |

### ⚡ 实战经验

1. **线程组大小选择**：`numthreads` 的 X 维度建议为 64 的倍数（对应 NVIDIA Warp 32 / AMD Wavefront 64），避免硬件资源浪费
2. **ComputeBuffer 是 GC 盲区**：必须手动 `Release()`，否则会造成 GPU 内存泄漏，在场景切换时尤其危险
3. **GPU Readback 性能陷阱**：`GetData()` 会阻塞 CPU 等待 GPU 完成，移动端可造成数毫秒卡顿。使用 `AsyncGPUReadback.Request()` 做异步回读
4. **移动端兼容性**：OpenGL ES 3.1+ 才支持 Compute Shader，部分低端 Android 设备不支持。务必做 `SystemInfo.supportsComputeShaders` 检查并提供 CPU Fallback

### 🔗 相关问题

- Compute Buffer 和 StructuredBuffer 有什么区别？
- 如何在 URP 中使用 Compute Shader 做自定义后处理？
