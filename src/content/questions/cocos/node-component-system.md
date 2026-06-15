---
title: "Cocos Creator 3.x 的节点系统（Node vs Node3D）和组件模型是怎样的？"
category: "cocos"
level: 1
tags: ["节点系统", "组件模型", "引擎原理"]
related: ["cocos/render-pipeline", "cocos/drawcall-optimization"]
hint: "从 Node 的继承体系出发，理解 3.x 统一节点架构与组件生命周期的关系。"
---

## 参考答案

### ✅ 核心要点

1. **Node 统一基类** → 3.x 中 Node 是所有节点的统一基类，Node3D / Node2D / UINode 都继承自 Node
2. **组件挂载模型** → 每个 Node 是一个容器，通过 addComponent 挂载功能组件（Sprite、Camera、Collider 等）
3. **变换层级** → Node 维护 position / rotation / scale，通过父子关系构成变换树
4. **生命周期回调** → onLoad → onEnable → start → update → lateUpdate → onDisable → onDestroy
5. **3.x 架构升级** → 废弃了 2.x 的 CCNode + cc.Node 双轨制，统一为 Node + 组件体系

### 📖 深度展开

#### 节点继承体系（3.x）

```
BaseNode (内部基类)
  └── Node (公开统一基类)
        ├── Node3D (3D 变换：position + rotation + scale)
        ├── 没有独立 Node2D 类（2D 节点直接用 Node）
        └── UINode（UI 专用，继承自 Node，拥有 UITransform 组件）
```

> **关键理解**：3.x 不再有独立的 `cc.Node`（2.x 的万能节点）。所有节点都是 `Node`，3D 场景中的节点通过挂载 `MeshRenderer` / `Camera3D` 等组件获得 3D 能力。

#### 组件模型核心

```typescript
// 自定义组件示例
import { _decorator, Component, Node3D, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('PlayerController')
export class PlayerController extends Component {
    // 属性面板序列化
    @property({ type: Node3D })
    public target: Node3D | null = null;

    @property({ range: [0, 100] })
    public moveSpeed: number = 10;

    onLoad() {
        // 组件加载时调用，此时节点已就绪
        this.node.layer = 1 << 2; // 设置层级
    }

    start() {
        // 第一次 update 之前调用
        if (this.target) {
            this.node.lookAt(this.target.worldPosition);
        }
    }

    update(deltaTime: number) {
        // 每帧调用
        const pos = this.node.position;
        this.node.setPosition(
            pos.x + this.moveSpeed * deltaTime,
            pos.y,
            pos.z
        );
    }
}
```

#### 节点变换与层级

```typescript
// Node 3D 变换 API
node.position        // localPosition (Vec3)
node.worldPosition   // worldPosition (Vec3, 只读计算属性)
node.eulerAngles     // 欧拉角
node.angle           // 2D 旋转角度
node.scale           // 缩放

// 父子层级操作
node.parent          // 获取/设置父节点
node.addChild(child) // 添加子节点
node.removeChild(child)
node.children        // 子节点数组
```

#### 2.x vs 3.x 节点对比

| 维度 | Cocos 2.x | Cocos 3.x |
|------|-----------|-----------|
| 基类 | `cc.Node`（万能节点） | `Node`（统一）+ 专用子类 |
| 3D 支持 | 独立 cc.Node3D | Node3D 继承 Node |
| 变换 | position (Vec3) | position (Vec3) + 完整 3D 变换 |
| 组件 | `addComponent` | `addComponent`（泛型支持） |
| UI | cc.Node + Widget | Node + UITransform + Widget |
| 属性装饰器 | 无 TS 装饰器 | `@property` 装饰器 |

#### 组件生命周期流程

```
节点创建 / 实例化 Prefab
       ↓
  onLoad()        ← 节点和组件已创建，可安全获取引用
       ↓
  onEnable()      ← 组件启用，注册事件监听
       ↓
  start()         ← 第一帧 update 之前，适合初始化逻辑
       ↓
  update(dt)      ← 每帧逻辑更新
       ↓
  lateUpdate(dt)  ← 所有 update 完成后（适合相机跟随）
       ↓
  onDisable()     ← 组件禁用，取消事件监听
       ↓
  onDestroy()     ← 节点销毁，清理资源
```

### ⚡ 实战经验

- **避免在 onLoad 中访问其他节点的 start 初始化数据**：onLoad 执行顺序不保证依赖节点的 start 已执行。跨节点引用应在 start 中处理，或用自定义事件通知。
- **大量节点用池化（NodePool）**：频繁创建销毁节点会导致 GC 卡顿，子弹、列表项等复用场景必须用对象池管理。
- **worldPosition 是计算属性**：每次访问都会重新计算世界变换矩阵，在 update 中高频访问时先缓存为局部变量。
- **组件不要超过 7-8 个**：单个节点挂载过多组件会影响性能且难以维护，合理拆分节点结构。

### 🔗 相关问题

- Cocos Creator 3.x 的 Prefab 系统与实例化有哪些最佳实践？
- 如何设计一个高效的事件系统替代 getNodeByName 硬引用？
- Node 的 layer 和 Camera 的 visibility 如何配合实现选择性渲染？
