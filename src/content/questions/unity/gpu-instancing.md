---
title: "Unity GPU Instancing 的原理是什么？如何正确使用？"
category: "unity"
level: 2
tags: ["性能优化", "渲染", "GPU Instancing"]
related: ["unity/drawcall-batching", "unity/urp-render-pipeline"]
hint: "相同 Mesh + 相同 Material = 一次 DrawCall 画无数个，关键在 Shader 支持和变量处理"
---

## 参考答案

### ✅ 核心要点

1. **核心原理**：一次 DrawCall 将相同 Mesh + 相同 Material 的多个实例提交给 GPU，GPU 在着色器阶段通过实例 ID 采样不同的变换矩阵和属性
2. **与 SRP Batcher / Dynamic Batching 的区别**：GPU Instancing 在 GPU 端完成实例复制，CPU 仅提交一次，不需要 CPU端合并顶点
3. **开启方式**：Material 面板勾选 "Enable GPU Instancing"，且 Shader 必须支持 `#pragma multi_compile_instancing`
4. **不支持的情况**：不同 Mesh、不同 Shader、Material Property Block 的非实例化属性、蒙皮网格（需特殊处理）
5. **性能边界**：实例数越多收益越大；少量物体反而有额外 buffer 开销

### 📖 深度展开

#### GPU Instancing 工作流程

```
CPU 端                          GPU 端
───────                         ───────
1. 收集所有使用相同              1. 顶点着色器接收
   Mesh+Material 的渲染器          instanceID
        ↓                       2. 通过 instanceID 索引
2. 构建 Instance Data Buffer       UNITY_MATRIX_M 等数组
   （每实例：变换矩阵、             获取该实例的世界矩阵
    颜色等属性）                  3. 执行一次顶点/片元
3. 调用一次                       着色器逻辑
   DrawIndexedInstanced()      4. 输出该实例的
4. 完成多个实例的渲染              最终像素颜色
```

#### 三种合批方式对比

| 维度 | Static Batching | Dynamic Batching | GPU Instancing |
|------|----------------|------------------|----------------|
| 合批位置 | CPU（构建时） | CPU（运行时） | GPU（运行时） |
| CPU 开销 | 极低 | 高（每帧合并顶点） | 极低 |
| 内存开销 | 高（复制顶点数据） | 低 | 低（Instance Buffer） |
| 网格要求 | 静态物体 | < 300 顶点 | 相同 Mesh |
| 材质要求 | 相同 | 相同 | 相同（可变属性用 MaterialPropertyBlock） |
| 位移/变形 | 物体不可移动 | 可移动 | 可移动（每实例独立矩阵） |
| 蒙皮网格 | ❌ | ❌ | 需 Graphics.DrawMeshInstanced 手动处理 |

#### Shader 支持 GPU Instancing 的关键写法

```hlsl
// 1. 必须声明 instancing 编译指令
#pragma multi_compile_instancing

// 2. 在顶点着色器输入结构中添加 instanceID
struct appdata
{
    float4 vertex : POSITION;
    UNITY_VERTEX_INPUT_INSTANCE_ID // 自动注入 instanceID
};

// 3. 在 v2f（顶点到片元）结构中也添加
struct v2f
{
    float4 pos : SV_POSITION;
    UNITY_VERTEX_INPUT_INSTANCE_ID
};

// 4. 顶点着色器中使用宏获取实例数据
v2f vert(appdata v)
{
    v2f o;
    UNITY_SETUP_INSTANCE_ID(v);      // 设置 instanceID
    UNITY_TRANSFER_INSTANCE_ID(v, o); // 传递给片元

    // 宏自动使用正确的实例变换矩阵
    o.pos = UnityObjectToClipPos(v.vertex);
    return o;
}

// 5. 如需每实例不同颜色，使用实例属性
UNITY_INSTANCING_BUFFER_START(Props)
    UNITY_DEFINE_INSTANCED_PROP(float4, _Color)
UNITY_INSTANCING_BUFFER_END(Props)

// 在片元着色器中读取
fixed4 frag(v2f i) : SV_Target
{
    UNITY_SETUP_INSTANCE_ID(i);
    return UNITY_ACCESS_INSTANCED_PROP(Props, _Color);
}
```

#### 使用 MaterialPropertyBlock 设置每实例属性

```csharp
// C# 端：为每个实例设置不同的颜色（不会打破合批）
MaterialPropertyBlock mpb = new MaterialPropertyBlock();
Renderer renderer = GetComponent<Renderer>();

mpb.SetColor("_Color", new Color(1f, 0f, 0f));
renderer.SetPropertyBlock(mpb);
// ⚠️ 注意：必须对应 Shader 中用 UNITY_DEFINE_INSTANCED_PROP 声明的属性
//         普通着色器属性（非 instanced）通过 MPB 设置会破坏合批！
```

#### Graphics.DrawMeshInstanced（手动 GPU Instancing）

```csharp
// 不需要 GameObject，直接用代码批量绘制
public class GrassRenderer : MonoBehaviour
{
    public Mesh grassMesh;
    public Material grassMaterial;
    private Matrix4x4[] matrices = new Matrix4x4[1023]; // 单次最多 1023

    void Update()
    {
        // 填充每个草实例的世界矩阵
        for (int i = 0; i < matrices.Length; i++)
        {
            matrices[i] = Matrix4x4.TRS(
                new Vector3(i * 0.5f, 0, 0),
                Quaternion.identity,
                Vector3.one
            );
        }

        Graphics.DrawMeshInstanced(grassMesh, 0, grassMaterial, matrices);
    }
}
```

#### URP 中的 GPU Instancing

```csharp
// URP 中通过 Render Object Pass 自动处理 GPU Instancing
// 需要在 URP Asset 中确认：
// 1. "SRP Batcher" 可以与 GPU Instancing 共存
//    （但同一个物体只能命中其中一个）
// 2. 优先级：SRP Batcher > GPU Instancing > Dynamic Batching

// URP Asset 脚本配置
var urpAsset = GraphicsSettings.currentRenderPipeline as UnityEngine.Rendering.Universal.UniversalRenderPipelineAsset;
// 检查是否开启了 GPU Instancing（默认开启）
Debug.Log($"GPU Instancing: {(urpAsset != null ? "Enabled" : "N/A")}");
```

### ⚡ 实战经验

1. **最大坑：Material 使用了非实例化属性**。如果 Shader 里声明了 `float4 _Color` 但没有用 `UNITY_DEFINE_INSTANCED_PROP` 包裹，那么通过 `MaterialPropertyBlock` 设置颜色会破坏合批。排查时用 Frame Debugger 检查是否真正合批
2. **Terrain 树和草是 GPU Instancing 的最佳场景**。成百上千棵树/草共用一个 Mesh 和 Material，开启后 DrawCall 从数千降到个位数。但要确保 Shader 支持风摇动等 per-instance 效果
3. **不要混淆 GPU Instancing 和 SRP Batcher**。SRP Batcher 优化的是"相同 Shader、不同 Material"的 CPU 提交效率，GPU Instancing 优化的是"相同 Mesh+Material"的 GPU 绘制次数。二者可以共存但不能同时命中同一个对象
4. **手机端需验证 GPU 支持**。部分老款 Android 设备的 GPU 对 Instancing 支持不完整（尤其是 Instanced Indirect），上线前务必用 `SystemInfo.supportsInstancing` 做运行时检测并准备降级方案

### 🔗 相关问题

- SRP Batcher 和 GPU Instancing 的优先级关系是什么？能同时生效吗？
- 如何用 ComputeShader + Graphics.DrawMeshInstancedIndirect 渲染百万级物体？
- 为什么开了 GPU Instancing 后 Frame Debugger 里仍然显示多个 DrawCall？
