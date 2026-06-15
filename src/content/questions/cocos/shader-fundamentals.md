---
title: "Cocos Creator Shader 入门：材质、Pass 与自定义着色器怎么写？"
category: "cocos"
level: 3
tags: ["Shader", "材质系统", "渲染", "GLSL"]
related: ["cocos/render-pipeline", "cocos/drawcall-optimization"]
hint: "从 Effect 文件结构到 Uniform 传参，理清 Cocos Creator 3.x 的 Shader 编写流程。"
---

## 参考答案

### ✅ 核心要点

1. **Effect 文件（.effect）** → Cocos Creator 的 Shader 根格式，用 YAML 描述材质参数，用 GLSL 描述顶点/片元着色器
2. **Material（材质）** → Effect 的实例，绑定具体的纹理、颜色等参数；一个 Effect 可被多个 Material 引用
3. **Pass** → 一个 Effect 可包含多个 Pass（如先渲染 Shadow Pass，再渲染 Main Pass），每个 Pass 对应一次 GPU 绘制
4. **Uniform 与 UBO** → Shader 参数通过 Uniform 传递，Cocos 自动将 `properties` 中声明的参数映射到 Shader Uniform
5. **内置变量** → Cocos 提供大量内置 Uniform（`cc_matViewProj`、`cc_cameraPos` 等），通过 `CCProgram` 引入

### 📖 深度展开

#### Effect 文件结构总览

```yaml
# my-effect.effect
CCEffect %{
  techniques:
    - name: opaque
      passes:
        - program: legacy/main-pass    # 对应下方 CCProgram 名
          props:                        # 默认参数值
            mainTexture:  { value: white }
            mainColor:    { value: [1,1,1,1], editor: { type: color } }
          rasterizerState:              # 渲染状态
            cullMode: back
          blendState:
            targets:
              - blend: false
          depthStencilState:
            depthTest: true
            depthWrite: true
}%

CCProgram legacy-vs %{           # 顶点着色器
  precision highp float;
  #include <legacy/input>
  #include <legacy/output>
  #include <legacy/decode>

  uniform MatConstants {
    mat4 cc_matViewProj;         // 内置：视图投影矩阵
  };

  out vec2 v_uv;

  void main() {
    v_uv = a_uv;
    gl_Position = cc_matViewProj * vec4(a_position, 1.0);
  }
}%

CCProgram legacy-fs %{           # 片元着色器
  precision highp float;

  in vec2 v_uv;

  // 自动绑定的 Uniform（来自 props 声明）
  uniform sampler2D mainTexture;
  uniform Constant {
    vec4 mainColor;
  };

  #include <legacy/output>

  void main() {
    vec4 texColor = texture(mainTexture, v_uv);
    gl_FragColor = texColor * mainColor;
  }
}%
```

#### 材质创建与使用

```typescript
import { Material, Sprite, MeshRenderer, Color } from 'cc';

// 方式1：代码动态创建材质（基于已有 Effect）
const mat = new Material();
mat.initialize({
  effectName: 'builtin-unlit',     // 使用引擎内置 Effect
  defines: { USE_TEXTURE: true },  // 宏定义
  states: { rasterizerState: { cullMode: 'none' } },
});

// 设置 Uniform 参数
mat.setProperty('mainColor', new Color(255, 128, 0, 255));
mat.setProperty('mainTexture', myTexture);

// 绑定到渲染组件
const renderer = node.getComponent(MeshRenderer);
renderer.setMaterial(mat, 0);       // index 0 对应第 0 个 Pass
```

```typescript
// 方式2：在编辑器中创建 .mat 资源，拖拽到组件
// 代码中动态修改参数
const mat = renderer.getMaterial(0);
mat.setProperty('mainColor', new Color(255, 0, 0, 255));
```

#### 常见内置 Uniform 速查

| Uniform 名 | 类型 | 说明 |
|------------|------|------|
| `cc_matViewProj` | mat4 | 视图投影矩阵 |
| `cc_matModel` | mat4 | 模型矩阵 |
| `cc_matView` | mat4 | 视图矩阵 |
| `cc_matProj` | mat4 | 投影矩阵 |
| `cc_cameraPos` | vec4 | 相机世界坐标 |
| `cc_screenScale` | vec4 | 屏幕缩放信息 |
| `cc_time` | vec4 | 时间信息（x=秒数） |

#### 自定义 Shader 实战：流光特效

```glsl
// 流光特效：在 UV 上叠加一条移动的高光带
CCProgram stream-fs %{
  precision highp float;

  in vec2 v_uv;
  uniform sampler2D mainTexture;
  uniform Params {
    vec4 mainColor;
    float streamWidth;    // 流光宽度
    float streamSpeed;    // 流光速度
    float streamIntensity; // 流光强度
  };

  void main() {
    vec4 baseColor = texture(mainTexture, v_uv);

    // 计算流光位置（从左到右循环移动）
    float streamPos = mod(cc_time.x * streamSpeed, 1.5) - 0.25;
    float dist = abs(v_uv.x - streamPos);
    float stream = smoothstep(streamWidth, 0.0, dist) * streamIntensity;

    gl_FragColor = baseColor + vec4(stream, stream, stream, 0.0);
  }
}%
```

```typescript
// TypeScript 侧控制
const mat = spriteNode.getComponent(Sprite).customMaterial;
mat.setProperty('streamWidth', 0.15);
mat.setProperty('streamSpeed', 0.8);
mat.setProperty('streamIntensity', 0.6);
```

#### 渲染状态控制

```yaml
# 常见的 Pass 状态配置
passes:
  - program: my-shader
    rasterizerState:
      cullMode: back           # back | front | none
    blendState:
      targets:
        - blend: true
          blendSrc: src_alpha        # SRC_ALPHA
          blendDst: one_minus_src_alpha  # ONE_MINUS_SRC_ALPHA
    depthStencilState:
      depthTest: true
      depthWrite: false             # 透明物体不写深度
      stencilTest: true
      stencilRef: 1
      stencilCompare: equal          # 只在模板值为1处渲染
```

### ⚡ 实战经验

- **Effect 修改后必须重启预览**：编辑器中修改 .effect 文件后，有时材质不会自动刷新，需要手动关闭再打开场景预览。上线前务必在真机上验证效果。
- **Uniform 数量有限制**：移动端 OpenGL ES 3.0 保证至少 256 个 vec4 Uniform，复杂 Shader 要注意不要超限，否则编译失败。用 Uniform Block（UBO）比分散的 Uniform 更高效。
- **2D 与 3D 的 Shader 不通用**：2D 渲染使用 `builtin-sprite` 等 2D 专属 Effect，3D 使用 PBR 或 Unlit，坐标系和变换矩阵不同，直接混用会出现渲染异常。
- **宏定义（Defines）影响编译缓存**：每新增一个宏定义组合，引擎都会编译一份新的 Shader 变体。避免过多的宏排列组合，否则包体和内存都会膨胀。

### 🔗 相关问题

- 如何实现卡通渲染（Toon Shading）的描边和色阶？
- Cocos Creator 的 PBR 材质有哪些参数？如何调整金属度和粗糙度？
- 多 Pass 渲染时，如何让第一个 Pass 写深度、第二个 Pass 半透明？
