---
title: "Cocos Creator 骨骼动画蒙皮原理与 GPU Skinning 实现？"
category: "cocos"
level: 3
tags: ["骨骼动画", "GPU Skinning", "蒙皮", "性能优化"]
related: ["cocos/spine-skeletal-animation", "cocos/shader-fundamentals"]
hint: "从骨骼层级、蒙皮权重矩阵到 GPU 顶点着色器实现逐层展开"
---

## 参考答案

### ✅ 核心要点

1. **骨骼层级（Skeleton Hierarchy）**：骨骼由关节节点组成父子链，动画驱动各关节变换
2. **蒙皮权重（Skinning Weights）**：每个顶点绑定到最多 4 根骨骼，附带权重值
3. **最终位置矩阵计算**：顶点最终位置 = Σ(骨骼变换矩阵 × 权重) × 原始位置
4. **CPU Skinning vs GPU Skinning**：CPU 蒙皮逐顶点计算，GPU 蒙皮在顶点着色器中并行计算
5. **性能差异巨大**：GPU Skinning 可将数千角色同屏从卡死变为流畅

### 📖 深度展开

#### 蒙皮数学原理

```
骨骼动画计算流程：

1. 网格原始顶点位置（绑定姿势 Bind Pose）
        ↓
2. 每根骨骼的最终世界变换矩阵 = Animation × BindPoseInverse
   ┌─────────────────────────────────────┐
   │ FinalMatrix[i] = WorldMatrix[i]     │
   │                  × InverseBindMatrix │
   └─────────────────────────────────────┘
        ↓
3. 顶点蒙皮变换（Skinned Position）
   V_skinned = Σᵢ (FinalMatrixᵢ × V_original) × Weightᵢ
   
   通常每顶点最多 4 根骨骼影响：
   V_skinned = M₀·V·w₀ + M₁·V·w₁ + M₂·V·w₂ + M₃·V·w₃
        ↓
4. 传入顶点着色器 → 正常渲染管线
```

#### GPU Skinning Shader 实现

```glsl
// Cocos Creator 3.x GPU Skinning 顶点着色器

uniform CCGlobal {
  mat4 cc_matView;
  mat4 cc_matViewProj;
};

// 骨骼矩阵数组（每帧从 CPU 上传）
uniform CCSkinning {
  mat4 u_boneMatrices[128]; // 最多 128 根骨骼
};

// 顶点属性扩展
attributes {
  vec3 a_position;       // 原始顶点位置
  vec3 a_normal;         // 法线
  vec2 a_texCoord;       // UV
  vec4 a_joints;         // 骨骼索引（最多4根）
  vec4 a_weights;        // 对应权重
};

vert shader:
  void main() {
    // 蒙皮矩阵计算：4根骨骼加权混合
    mat4 skinMatrix =
      u_boneMatrices[int(a_joints.x)] * a_weights.x +
      u_boneMatrices[int(a_joints.y)] * a_weights.y +
      u_boneMatrices[int(a_joints.z)] * a_weights.z +
      u_boneMatrices[int(a_joints.w)] * a_weights.w;

    // 蒙皮变换
    vec4 skinnedPos = skinMatrix * vec4(a_position, 1.0);
    
    // 法线也需要蒙皮变换（取上3x3部分）
    mat3 normalMatrix = mat3(skinMatrix);
    vec3 skinnedNormal = normalize(normalMatrix * a_normal);

    // 正常 MVP 变换
    gl_Position = cc_matViewProj * skinnedPos;
    
    v_texCoord = a_texCoord;
    v_normal = skinnedNormal;
  }
```

#### Cocos Creator 中的使用

```typescript
import { _decorator, Component, SkeletalAnimation, SkinnedMeshRenderer } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('CharacterSkinningDemo')
export class CharacterSkinningDemo extends Component {
  @property(SkeletalAnimation)
  skeletonAnim: SkeletalAnimation = null;

  @property(SkinnedMeshRenderer)
  skinnedMesh: SkinnedMeshRenderer = null;

  start() {
    // Cocos 3.x 默认使用 CPU Skinning
    // 开启 GPU Skinning（需引擎支持）
    this.enableGPUSkinning();
    
    // 播放动画
    const state = this.skeletonAnim.play('run');
    state.repeatMode = RepeatMode.Loop;
  }

  private enableGPUSkinning() {
    // 方式1：材质中使用 GPU Skinning Shader（需自定义 Pass）
    const mat = this.skinnedMesh.material;
    mat.recompileShaders({ USE_GPU_SKINNING: true });

    // 方式2：引擎全局开启（3.6+ 支持）
    // 在项目设置 → 引擎模块裁剪中勾选 GPU Skinning
  }

  // 批量同屏角色管理
  update(dt: number) {
    // CPU Skinning：每个角色独立计算蒙皮 → 无法合批 → 每角色1个DrawCall
    // GPU Skinning：骨骼矩阵通过 Uniform 上传 → 可 Instancing 合批
    // 100个同模型角色可用 GPU Instancing 合为 1 个 DrawCall
  }
}
```

#### CPU vs GPU Skinning 性能对比

| 维度 | CPU Skinning | GPU Skinning |
|------|-------------|--------------|
| 计算位置 | CPU 逐顶点循环 | GPU 顶点着色器并行 |
| 单角色开销 | 中等（~0.1ms） | 极低（GPU 并行） |
| 多角色合批 | ❌ 不可能 | ✅ 可 Instancing 合批 |
| 内存占用 | 低（CPU 算完即丢） | 中等（需上传骨骼矩阵 UBO） |
| 实现复杂度 | 引擎内置 | 需自定义 Shader |
| 兼容性 | 全平台 | 需 Uniform 数组支持 |
| 100 角色同屏 | 卡死（~50ms） | 流畅（~3ms） |
| 适用场景 | 少量角色/低频更新 | RPG 小怪海、群体战斗 |

```
同屏角色数量性能曲线（近似值）：

帧时间(ms)
  50 ┤                          ╱── CPU Skinning
     │                       ╱╱
  30 ┤                    ╱╱╱
     │                 ╱╱╱
  16 ┤──────────────╱╱╱─────────── 60fps 线
     │          ╱╱╱
   8 ┤──────╱╱╱──────────────────── GPU Skinning
     │  ╱╱╱╱
   3 ┤╱╱╱╱─────────────────────────
     └──┬──┬──┬──┬──┬──┬──┬──┬──→ 角色数
        10 20 30 50 80 100 150 200
```

### ⚡ 实战经验

1. **GPU Skinning 的骨骼数量受 Uniform 限制**：不同平台 Uniform 数组上限不同（OpenGL ES 2.0 仅 128 vec4），骨骼矩阵 4×4 占用空间大。128 根骨骼需要 128×4=512 个 vec4，需确认目标平台上限
2. **动画烘焙 vs 实时计算**：对于固定循环动画（如小怪跑、待机），可以将每帧蒙皮结果预烘焙为顶点动画纹理（VAT），完全跳过蒙皮计算，性能极致但灵活性为零
3. **LOD 配合 Skinning**：远处角色可以用更简单的骨骼（去掉手指关节），减少蒙皮计算量和动画数据体积。Cocos 的 SkeletalAnimation 可以通过 AnimationClip 的采样精度控制
4. **Instancing + GPU Skinning 是最强组合但坑多**：需要所有角色共享同一个网格和材质，动画状态需要通过 Instance Attribute 传入（不能只靠 Uniform），部分低端机不支持 Instance Attribute

### 🔗 相关问题

- Spine 动画与骨骼蒙皮动画（SkeletalAnimation）在 Cocos 中有什么区别？
- 如何实现顶点动画纹理（VAT）来替代 GPU Skinning？
- Cocos Creator 3.x 的 Instancing 系统如何传递每实例数据？
