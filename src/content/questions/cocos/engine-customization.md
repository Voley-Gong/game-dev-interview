---
title: "Cocos Creator 3.x 如何定制引擎源码与参与引擎贡献？"
category: "cocos"
level: 3
tags: ["引擎定制", "源码", "引擎原理", "架构设计"]
related: ["cocos/render-pipeline", "cocos/native-build-jsb"]
hint: "当引擎原生功能不满足需求时，如何安全地修改引擎而不影响升级？"
---

## 参考答案

### ✅ 核心要点

1. **引擎源码结构**：`engine/` 目录是 Cocos 引擎核心（C++ + TS），`cocos/` 是 TS 层 API
2. **定制方式**：自定义模块 → 引擎覆写 → Fork 引擎源码（从轻到重）
3. **编译引擎**：通过 `gulp build` 或 CMake 构建定制版引擎
4. **版本对齐**：定制引擎必须与 Creator 编辑器版本严格匹配
5. **升级策略**：保持改动最小化、模块化，定期 rebase 上游

### 📖 深度展开

#### 引擎源码结构

```
cocos-engine/
├── cocos/                    # TS 层 API（游戏开发者直接使用）
│   ├── core/                 # 核心模块（Vec3, Mat4, Quat, EventTarget...）
│   ├── 2d/                   # 2D 渲染（Sprite, Label, Mask...）
│   ├── 3d/                   # 3D 渲染（MeshRenderer, Camera, Light...）
│   ├── physics/              # 物理系统接口
│   ├── ui/                   # UI 组件
│   └── asset/                # 资源管理
├── engine/                   # C++ 引擎核心
│   ├── cocos/                # C++ 引擎实现
│   │   ├── renderer/         # 渲染器
│   │   ├── scene/            # 场景管理
│   │   ├── physics/          # 物理后端
│   │   └── platform/         # 平台抽象层
│   └── bindings/             # JSB 自动绑定脚本
├── tools/                    # 构建工具
│   ├── gulp/                 #gulp 任务
│   └── gen-bindings/         # JSB 绑定生成器
└── templates/                # 项目模板
```

#### 三层定制策略

| 层级 | 方式 | 适用场景 | 升级成本 |
|------|------|---------|---------|
| L1 | 自定义模块/组件 | 需要新功能，不修改引擎 | 无 |
| L2 | 引擎覆写（Monkey Patch） | 修改引擎行为，需快速验证 | 低-中 |
| L3 | Fork 引擎源码 | 深度修改渲染/物理等底层 | 高 |

#### L1：自定义渲染管线（最常见的定制）

```typescript
// 自定义 RenderPipeline — 实现简单后处理效果
import { RenderPipeline, RenderFlow, RenderPass } from 'cc';

class CustomPipeline extends RenderPipeline {
    protected onCreateFlows(): RenderFlow[] {
        return [
            // 自定义 Flow 定义渲染顺序
            new RenderFlow({
                name: 'CustomFlow',
                passes: [
                    this.createMainPass(),
                    this.createOutlinePass(),   // 自定义描边 Pass
                    this.createBloomPass(),      // 自定义 Bloom
                ],
            }),
        ];
    }

    private createOutlinePass(): RenderPass {
        return new RenderPass({
            name: 'Outline',
            material: this.outlineMaterial,
            // 在主渲染后执行描边检测
            dependencies: ['MainPass'],
        });
    }
}
```

#### L2：引擎覆写（Monkey Patch）

当需要修改引擎方法但不改源码时：

```typescript
/**
 * 覆写 Sprite 的顶点生成逻辑
 * 注意：需在引擎初始化后、使用前执行
 */
import { Sprite, SpriteFrame } from 'cc';

const originalUpdateGeometry = (Sprite as any).prototype.updateGeometry;

(Sprite as any).prototype.updateGeometry = function () {
    originalUpdateGeometry.call(this);
    // 在原始顶点数据基础上做自定义修改
    const renderData = this.renderData;
    if (renderData) {
        // 例：给每个顶点添加自定义属性
        for (let i = 0; i < renderData.vertexCount; i++) {
            const v = renderData.vertices[i];
            v.customUV = calculateCustomUV(v.x, v.y);
        }
    }
};
```

#### L3：修改引擎源码 + 编译

```bash
# 1. 克隆引擎源码（选择对应版本分支）
git clone https://github.com/cocos/cocos-engine.git
cd cocos-engine
git checkout 3.8.5  # 与 Creator 编辑器版本一致

# 2. 修改引擎代码（如修改 renderer 的合批逻辑）
vim engine/cocos/renderer/MeshBatcher.cpp

# 3. 编译 TS 层
npm install
npm run build

# 4. 编译 C++ 原生引擎（Android 为例）
cd engine
./tools/build-android.sh -a arm64

# 5. 在 Creator 中切换到自定义引擎
# Project Settings → Engine → 自定义引擎路径 → 指向你的 fork
```

#### 版本对齐矩阵

| Creator 版本 | 引擎分支 | Node.js | TypeScript |
|-------------|---------|---------|-----------|
| 3.8.x | 3.8.x | 18+ | 5.x |
| 3.7.x | 3.7.x | 16+ | 4.x |
| 3.6.x | 3.6.x | 14+ | 4.x |

### ⚡ 实战经验

1. **优先用 L1，谨慎用 L3**：90% 的定制需求可以通过自定义组件 + 自定义渲染管线实现。真正需要改 C++ 引擎源码的场景非常少（通常是深度渲染优化或自定义物理后端）
2. **Fork 引擎的维护噩梦**：每次 Cocos 版本升级，你的 Fork 都需要 rebase 合并冲突。建议将改动集中在独立模块/文件中，减少冲突面积。维护一个 `patches/` 目录记录所有改动
3. **JSB 绑定新增 C++ API**：如果在 C++ 层新增了方法，需要重新生成 JSB 绑定代码。使用 `tools/gen-bindings/gen-bindings.py`，注意生成的 `.cpp` 文件需要手动检查
4. **提交 PR 回馈社区**：如果是 Bug 修复或通用功能增强，提 PR 到 `cocos/cocos-engine` 仓库。Cocos 团队审核速度较快，合并后你的改动就能进入主线，免去维护 Fork 的负担

### 🔗 相关问题

- Cocos Creator 自定义渲染管线如何实现后处理效果（Bloom、描边）？
- 如何为引擎贡献代码并提交 PR？
- Cocos Creator 的 JSB 绑定代码是如何自动生成的？
