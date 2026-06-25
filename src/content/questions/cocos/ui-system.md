---
title: "Cocos Creator UI 系统的 Layout、Mask、富文本与性能优化"
category: "cocos"
level: 2
tags: ["UI系统", "Layout", "Mask", "性能优化", "渲染"]
related: ["cocos/drawcall-optimization", "cocos/render-pipeline"]
hint: "Layout 自动布局的触发时机？Mask 的性能开销？UI 渲染合批如何保证？"
---

## 参考答案

### ✅ 核心要点

1. **Canvas 是 UI 根节点**：所有 UI 组件必须挂在 Canvas 下，Canvas 负责屏幕适配和多分辨率渲染
2. **Layout 组件**：自动排列子节点（水平/垂直/网格），通过 `updateLayout()` 触发布局更新
3. **Mask 组件**：基于模板测试实现裁剪，有 GRAPHICS / RECTANGLE_STENCIL 两种模式，开销不同
4. **富文本系统**：`RichText` 支持内嵌图片和样式标记，但渲染开销大于普通 Label
5. **UI 渲染性能**：确保相同层级、相同纹理、相同材质的 UI 节点相邻排列以触发合批

### 📖 深度展开

#### Canvas 与多分辨率适配

```
Canvas (设计分辨率 720×1280)
  ├── Fit Width  / Fit Height 适配模式
  ├── UiCamera
  └── UI 节点树
       ├── SafeArea (刘海屏适配)
       ├── TopBar
       ├── Content (ScrollView/List)
       └── BottomBar
```

| 适配模式 | 特点 | 适用场景 |
|---------|------|---------|
| Fit Width | 宽度铺满，高度可能溢出/留白 | 竖屏游戏 |
| Fit Height | 高度铺满，宽度可能溢出/留白 | 横屏游戏 |
| Fit Both (Show All) | 等比缩放，无变形但有黑边 | 通用 |
| Fit Both (Show More) | 等比缩放，可能裁剪边缘 | 弹窗/全屏 UI |

#### Layout 组件深度解析

```typescript
// Layout 组件核心属性
const layout = node.getComponent(Layout);
layout.type = Layout.Type.HORIZONTAL;  // 水平排列
layout.spacingX = 10;                   // 间距
layout.paddingLeft = 20;                // 左边距
layout.horizontalDirection = 1;         // 从左到右
layout.resizeMode = Layout.ResizeMode.CONTAINER; // 容器自适应大小

// ⚠️ 手动触发布局更新
layout.updateLayout();

// 动态列表常见模式
@ccclass('VirtualList')
class VirtualList extends Component {
    @property(Layout) layout: Layout | null = null;
    @property(Prefab) itemPrefab: Prefab | null = null;

    private _items: string[] = [];

    updateItems(data: string[]) {
        this._items = data;
        // 先清空旧子节点
        this.node.removeAllChildren();

        // 逐个创建子节点
        for (const itemData of data) {
            const item = instantiate(this.itemPrefab!);
            item.getChildByName('label')!
                .getComponent(Label)!.string = itemData;
            this.node.addChild(item);
        }

        // 触发 Layout 重新排列
        this.layout?.updateLayout();
    }
}
```

**Layout 触发时机：**
- 子节点增删时（`addChild` / `removeChild`）
- 子节点尺寸变化时（需手动调用 `updateLayout`）
- 组件 `onEnable` 时
- ⚠️ 直接修改节点 position 不会触发 Layout

#### Mask 组件性能分析

```
Mask 渲染流程：
┌─────────────────────────────┐
│  绘制 Mask 模板区域          │
│  (GRAPHICS_STENCIL)         │
│         ↓                    │
│  子节点绘制（模板测试通过区域）│
│         ↓                    │
│  清除模板缓冲                │
└─────────────────────────────┘
```

| Mask 类型 | 实现方式 | 性能开销 | 功能限制 |
|-----------|---------|---------|---------|
| GRAPHICS_STENCIL | 模板测试 | 中等（打断合批） | 支持任意形状 |
| RECTANGLE_STENCIL | 矩形模板测试 | 较低 | 仅矩形区域 |
| NONE | 无 Mask | 无 | 无裁剪 |

**Mask 与合批的关系：**
Mask 节点会打断合批链，因为模板测试需要独立的渲染 Pass。对于 ScrollView 中的大量列表项，UI 元素的渲染顺序会被 Mask 分割。

#### UI 合批条件

```
合批要求（全部满足）：
1. 相同的 Material（材质/Shader）
2. 相同的 Texture（或同一图集）
3. 相同的 BlendState
4. 节点层级连续（中间不能插入不同材质的节点）
5. 不被 Mask 截断
```

**常见合批破坏场景：**

```typescript
// ❌ 破坏合批：中间插入不同纹理的节点
- SpriteA (atlas1.png)
- SpriteB (atlas2.png)  ← 打断合批
- SpriteC (atlas1.png)  ← 需要重新开始一个批次

// ✅ 保持合批：相同纹理的节点相邻排列
- SpriteA (atlas1.png)
- SpriteC (atlas1.png)
- SpriteB (atlas2.png)

// ❌ 破坏合批：Label 与 Sprite 交替排列
// Label 使用 SDF/TTF 材质，Sprite 使用默认材质
```

### ⚡ 实战经验

1. **ScrollView 优化**：超过 50 个列表项必须使用虚拟列表（复用可见区域的 Item）。手动管理 Item 的显示/隐藏和位置更新，而不是依赖 Layout 组件。使用 `ScrollView` 的 `scrollTo` 事件做分页加载
2. **图集合并**：将同一个界面用的 Sprite 都打入同一个 Auto Atlas，大幅减少 DrawCall。注意图集尺寸不要超过 2048×2048（部分低端设备限制），超大的单独拆出
3. **Label 性能**：大量 Label 使用 `CacheMode.BITMAP` 可以缓存位图减少开销。但频繁变化的 Label（如计分、倒计时）不要用 BITMAP 缓存，用 `CHAR` 模式或默认模式更高效
4. **Layout 性能陷阱**：大量子节点 + Layout 组件会导致每帧都做布局计算。对于固定列表，布局完成后通过 `layout.enabled = false` 关闭 Layout，或者将节点 position 固化

### 🔗 相关问题

- 如何实现一个高性能的虚拟滚动列表？
- 多分辨率适配中如何处理刘海屏和安全区域？
- UI 系统的合批与 3D 渲染的合批有什么区别？
