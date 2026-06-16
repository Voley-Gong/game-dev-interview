---
title: "Cocos Creator 2.x 升级 3.x 的迁移策略与常见问题？"
category: "cocos"
level: 3
tags: ["引擎迁移", "版本升级", "架构变更"]
related: ["cocos/render-pipeline", "cocos/node-component-system"]
hint: "从 API 变更、组件体系、坐标系、渲染底层四个维度梳理迁移路径"
---

## 参考答案

### ✅ 核心要点

1. **架构重构**：3.x 底层完全重写，组件命名空间从 `cc` 统一到模块化导入
2. **3D 优先**：3.x 以 3D 为核心架构，2D 作为 3D 的子集渲染（不再有独立的 2D 引擎）
3. **API 变更量大**：几乎所有核心 API 都有改名或参数变更，官方提供自动迁移工具但需手动修正
4. **坐标系统一**：3.x 统一使用 Y-up 右手坐标系，2.x 是 Y-down 左手坐标系
5. **资源系统升级**：`cc.loader` → `assetManager`，Bundle 机制替代单纯的 resources 目录

### 📖 深度展开

#### 核心 API 变更对照表

| 维度 | Cocos 2.x | Cocos 3.x | 说明 |
|------|-----------|-----------|------|
| 资源加载 | `cc.loader.loadRes()` | `assetManager.loadResources()` | 支持更多配置项 |
| 节点获取 | `cc.find()` | `find()` (from `cc`) | 路径查找方式不变 |
| 组件基类 | `cc.Component` | `Component` | 需 import |
| 节点类型 | `cc.Node` | `Node` / `Node3D` | 3D 场景使用 Node3D |
| 向量类 | `cc.Vec2` | `Vec2` | 不再挂在 cc 命名空间 |
| 事件 | `node.on('click', ...)` | `node.on(Node.EventType.*...)` | 事件系统重构 |
| UI 组件 | `cc.Sprite` | `Sprite` | 组件名变化不大，API 有调整 |
| 音频 | `cc.audioEngine` | `AudioSource` 组件 | 改为组件式使用 |
| 物理引擎 | 内置 chipmunk | 可选 cannon/bullet | 3D 物理支持 |
| 坐标系 | Y-down 左手系 | Y-up 右手系 | 影响所有位置计算 |

#### 代码迁移示例

```typescript
// ============ 2.x 写法 ============
const { ccclass, property } = cc._decorator;

@ccclass
export default class PlayerCtrl extends cc.Component {
  @property(cc.Sprite)
  sprite: cc.Sprite = null;

  @property({ type: cc.Node })
  target: cc.Node = null;

  onLoad() {
    cc.loader.loadRes('textures/hero', cc.SpriteFrame, (err, sf) => {
      this.sprite.spriteFrame = sf;
    });
    this.node.on('touchstart', this.onTouch, this);
  }

  onTouch(event: cc.Event.EventTouch) {
    const pos = event.getLocation();
    this.node.setPosition(pos.x, pos.y);
  }

  update(dt: number) {
    const dir = this.target.position.sub(this.node.position);
    this.node.x += dir.x * dt * 100;
  }
}

// ============ 3.x 等效写法 ============
import { _decorator, Component, Sprite, SpriteFrame, Node, Vec3, find, assetManager } from 'cc';
const { ccclass, property } = _decorator;

@ccclass
export class PlayerCtrl extends Component {
  @property(Sprite)
  sprite: Sprite = null;

  @property(Node)
  target: Node = null;

  onLoad() {
    assetManager.loadResources('textures/hero/hero', SpriteFrame, (err, sf) => {
      if (!err) this.sprite.spriteFrame = sf;
    });
    this.node.on(Node.EventType.TOUCH_START, this.onTouch, this);
  }

  onTouch(event: EventTouch) {
    const uiPos = event.getUILocation();
    // 注意 3.x 使用 Vec3，且坐标系 Y-up
    this.node.setPosition(uiPos.x, uiPos.y, 0);
  }

  update(dt: number) {
    const dir = new Vec3();
    Vec3.subtract(dir, this.target.position, this.node.position);
    // 归一化后乘速度
    dir.normalize().multiplyScalar(100 * dt);
    this.node.setPosition(
      this.node.position.x + dir.x,
      this.node.position.y + dir.y,
      0
    );
  }
}
```

#### 坐标系迁移详解

```
2.x 坐标系（Y-down，左手系）：
  (0,0) ──────────→ X+
   │
   ↓ Y+
   
  视觉上 Y 向下增长，与屏幕像素坐标一致

3.x 坐标系（Y-up，右手系）：
  ↑ Y+
  │
  │
  (0,0) ──────────→ X+
   
  Y 向上增长，与数学/3D 习惯一致

迁移影响：
- 所有 setPosition / position.y 的正负方向可能反转
- UI 布局坐标需重新校准
- 动画轨迹数据需要转换
```

#### 资源系统迁移

```typescript
// 2.x: cc.loader 系列
cc.loader.loadResDir('prefabs/enemies', cc.Prefab, (err, assets) => {
  // ...
});
cc.loader.release('prefabs/enemies');
cc.loader.getRes('prefabs/hero');

// 3.x: assetManager 系列
assetManager.loadResources('prefabs/enemies', Prefab, (err, assets) => {
  // assets 是数组
});
assetManager.release('prefabs/enemies');
assetManager.getResources('prefabs/hero');

// 3.x 新增：Bundle 机制（替代远程资源加载）
assetManager.loadBundle('https://cdn.example.com/assets/battle', (err, bundle) => {
  bundle.load('scenes/battle', SceneAsset, (err, scene) => {
    director.runScene(scene);
  });
});

// 3.x 新增：预加载
assetManager.preload('prefabs/hero', Prefab);
```

### ⚡ 实战经验

1. **不要一次性迁移**：先用官方迁移工具（`cocos-creator-3d-migration`）转换 70% 的代码，剩余 30% 手动修正。中大项目建议按模块分批迁移，先迁移一个独立模块验证可行性
2. **第三方插件是最大坑**：2.x 的许多社区插件（如 FairyGUI 适配层）没有 3.x 版本，要么自己重写适配层，要么找替代方案。迁移前先盘点所有第三方依赖
3. **UI 坐标必须逐个验证**：坐标系变更影响所有 UI 布局，尤其是代码动态设置位置的地方。建议写一个坐标转换工具函数批量处理，但仍然需要人眼校验每个场景
4. **性能可能不升反降**：3.x 的 3D 渲染管线比 2.x 的 2D 管线重，纯 2D 项目迁移后初期帧率可能下降 10~20%。需要用 Dynamic Atlas、静态合批等手段找回性能

### 🔗 相关问题

- Cocos Creator 3.x 的渲染管线与 2.x 有什么本质区别？
- 迁移过程中如何保证线上版本的平滑过渡（热更新兼容）？
- 2.x 的 cc.tween 系统 vs 3.x 的 tween 系统有什么变化？
