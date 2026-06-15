---
title: "Cocos Creator 3.x GPU Instancing 实例化渲染原理与使用场景是什么？"
category: "cocos"
level: 3
tags: ["GPU Instancing", "渲染优化", "引擎原理", "DrawCall"]
related: ["cocos/drawcall-optimization", "cocos/render-pipeline"]
hint: "当成百上千个相同网格需要渲染时，如何让 GPU 一次性处理？"
---

## 参考答案

### ✅ 核心要点

1. **GPU Instancing 本质** → 一次 DrawCall 绘制多个相同网格的不同实例
2. **实例属性传递** → 每个实例的 Transform、颜色等通过 Instance Attribute 传入 Shader
3. **合批前提严格** → 相同材质 + 相同网格 + 相同 Shader 变体
4. **Cocos 3.x 支持** → 通过 `MeshRenderer.useInstancing` 或材质开启
5. **适用与不适用场景** → 草地、树木、粒子替代品适合；骨骼动画、不同材质不适合

### 📖 深度展开

#### 传统渲染 vs GPU Instancing

```
传统方式（N 个对象 = N 次 DrawCall）：
CPU → DrawCall(Mesh_A, Mat_1, Transform_1)
CPU → DrawCall(Mesh_A, Mat_1, Transform_2)
CPU → DrawCall(Mesh_A, Mat_1, Transform_3)
...
CPU → DrawCall(Mesh_A, Mat_1, Transform_N)

GPU Instancing（N 个对象 = 1 次 DrawCall）：
CPU → DrawCallInstanced(Mesh_A, Mat_1, [Transform_1..N])
GPU 内部循环 N 次执行顶点着色器
```

#### Cocos Creator 3.x 中开启 Instancing

**方式一：代码动态开启**

```typescript
import { MeshRenderer, Mesh, Material } from 'cc';

@ccclass('InstancingExample')
export class InstancingExample extends Component {
    start() {
        const renderer = this.getComponent(MeshRenderer);
        // 开启 GPU Instancing
        renderer.useInstancing = true;
    }
}
```

**方式二：材质属性中开启**

在 Material 的 Effect 文件中声明 `instanced` 属性：

```yaml
# 在 effect 的 technique 中
techniques:
  - name: opaque
    passes:
      - program: colormap|vert-vs|frag-fs
        properties:
          mainTexture: { value: white }
        # 开启 instancing
        instanceCount: -1   # -1 表示由引擎动态决定
```

**方式三：通过 InstancedBuffer 批量提交**

```typescript
import { InstancedBuffer, Vec3, Mat4 } from 'cc';

// 创建 InstancedBuffer
const buffer = new InstancedBuffer();
buffer.set('a_instance_matrix', [
    Mat4.fromRotationTranslation(new Mat4(), Quat.IDENTITY, new Vec3(0, 0, 0)),
    Mat4.fromRotationTranslation(new Mat4(), Quat.IDENTITY, new Vec3(1, 0, 0)),
    Mat4.fromRotationTranslation(new Mat4(), Quat.IDENTITY, new Vec3(2, 0, 0)),
    // ... 更多实例
]);
```

#### Shader 中接收 Instance 属性

```glsl
// 顶点着色器
attributes:
  - name: a_position
    type: vec3
  - name: a_instance_matrix   // 实例矩阵（引擎自动注入）
    type: mat4
    instanced: true            // 关键：标记为实例属性

vert-vs:
  uniform mat4 u_viewProj;

  void main() {
    vec4 worldPos = a_instance_matrix * vec4(a_position, 1.0);
    gl_Position = u_viewProj * worldPos;
  }
```

#### 合批策略对比

| 策略 | 合批对象 | DrawCall 减少 | CPU 开销 | 适用场景 |
|------|----------|--------------|----------|----------|
| 静态合批 | 不同网格 | ✅ 大幅 | 高（合并网格） | 静态场景 |
| 动态合批 | 小网格自动 | ✅ 中等 | 中等 | 2D Sprite |
| GPU Instancing | 相同网格 | ✅ 极大 | 极低 | 草地、树木、石头 |
| SRP Batcher | 相同 Shader | ❌ 不减 DrawCall | 降低 | （Unity 概念，Cocos 无直接对应） |

#### 适用场景分析

```
✅ 适合 GPU Instancing 的场景：
   ├── 大量相同模型重复渲染（草地、树木、石头）
   ├── 弹幕游戏中的子弹
   ├── RTS 游戏中的兵种
   └── 粒子系统的替代方案（低面片）

❌ 不适合的场景：
   ├── 骨骼动画角色（每帧骨骼矩阵不同）
   ├── 不同材质/纹理的对象
   ├── 需要 Lighting Map 的静态物体（UV 不同）
   └── 数量极少（<10 个，Instancing 开销 > 收益）
```

### ⚡ 实战经验

1. **Instancing 不是万能的** — 如果实例数量少于 ~50 个，CPU 提交 Instance Buffer 的开销可能大于节省的 DrawCall 开销，反而更慢
2. **移动端兼容性** — OpenGL ES 3.0+ 才支持 Instancing，低版本设备会 fallback 为普通渲染，需测试目标设备
3. **与阴影的冲突** — Instancing 渲染的对象投射阴影需要额外的 Shadow Pass Instancing，Cocos 3.x 对此支持有限，需手动验证
4. **LOD + Instancing 组合** — 远处用低模 Instancing、近处切换为正常渲染，可以实现大批量植被的流畅渲染

### 🔗 相关问题

- Cocos Creator 中 DrawCall 优化有哪些策略？
- 静态合批、动态合批和 GPU Instancing 有什么区别？
- 如何自定义 Effect 文件支持 Instancing 属性？
