---
title: "Cocos Creator 3.x 如何实现多分辨率适配与屏幕适配方案？"
category: "cocos"
level: 2
tags: ["UI适配", "多分辨率", "实战经验"]
related: ["cocos/ui-system"]
hint: "Canvas 适配模式、Widget 组件、安全区域、刘海屏——如何让游戏在各种设备上正确显示？"
---

## 参考答案

### ✅ 核心要点

1. **Canvas 适配模式** → `fitWidth` / `fitHeight` / `showAll` / `noBorder` 四种模式决定画布缩放策略
2. **设计分辨率** → 美术出图基准分辨率，常见 720×1280（竖屏）或 1280×720（横屏）
3. **Widget 组件** → 实现边缘对齐、百分比布局，让 UI 元素在不同屏幕比例下保持正确位置
4. **安全区域（SafeArea）** → 避开刘海屏、圆角、底部手势条的不可点击区域
5. **多倍图策略** → 通过 `cc.assetManager` 的按设备分辨率加载不同清晰度资源

### 📖 深度展开

#### Canvas 适配模式详解

```
设计分辨率: 1280 × 720（横屏）
设备分辨率: 1920 × 1080（16:9）  → 比例一致，完美适配
设备分辨率: 2340 × 1080（19.5:9）→ 比例不同，需要策略

┌─────────────────────────────────────────────┐
│              fitWidth（宽度优先）              │
│  设计宽度 → 撑满屏幕宽度，高度可能溢出或留白    │
│  适合：横屏游戏，竖屏变化小                     │
├─────────────────────────────────────────────┤
│              fitHeight（高度优先）             │
│  设计高度 → 撑满屏幕高度，宽度可能溢出或留白    │
│  适合：竖屏游戏，横屏变化小                     │
├─────────────────────────────────────────────┤
│              showAll（完整显示）               │
│  等比缩放，确保完整显示，可能留黑边             │
│  适合：必须完整展示所有内容                     │
├─────────────────────────────────────────────┤
│              noBorder（无黑边）                │
│  等比缩放，撑满屏幕，可能裁切边缘               │
│  适合：背景图、沉浸式游戏                       │
└─────────────────────────────────────────────┘
```

#### Canvas 配置代码

```typescript
import { view, ResolutionPolicy, screen } from 'cc';

// 方式一：代码设置适配策略（在场景加载前）
view.setDesignResolutionSize(
    1280, 720, 
    ResolutionPolicy.FIXED_HEIGHT  // 高度优先适配
);

// 方式二：在编辑器 Canvas 组件上直接配置
// Design Resolution: 1280 × 720
// Fit Width: ☑ / Fit Height: ☑
```

#### 适配模式选择决策树

```
游戏类型？
├── 竖屏游戏（如消除、卡牌）
│   └── fitHeight + 宽度方向用 Widget 拉伸
│       设计分辨率: 720 × 1280
│
├── 横屏游戏（如动作、RPG）
│   └── fitWidth + 高度方向用 Widget 拉伸
│       设计分辨率: 1280 × 720
│
└── 全屏沉浸式（如跑酷）
    └── noBorder + 核心UI放安全区内
        设计分辨率: 1280 × 720
```

#### Widget 边缘对齐布局

```typescript
import { Widget, UITransform } from 'cc';

// 顶部状态栏：始终贴顶
const topBarWidget = topBarNode.getComponent(Widget)!;
topBarWidget.top = 50;      // 距离顶部 50px
topBarWidget.isAlignTop = true;
topBarWidget.alignMode = Widget.AlignMode.ALWAYS;  // 持续对齐

// 底部导航：始终贴底
const bottomWidget = bottomNav.getComponent(Widget)!;
bottomWidget.bottom = 0;
bottomWidget.isAlignBottom = true;

// 右侧按钮：贴右 + 安全区域偏移
const rightWidget = sideBtn.getComponent(Widget)!;
rightWidget.right = 20;
rightWidget.isAlignRight = true;
```

#### 安全区域处理（刘海屏 / 全面屏）

```typescript
import { sys, screen, view } from 'cc';

// 获取安全区域（引擎自动计算）
const safeArea = sys.getSafeAreaRect();

// 手动处理安全区域：让 UI 容器缩小到安全区内
function adjustSafeArea(containerNode: Node) {
    const widget = containerNode.getComponent(Widget);
    if (!widget) return;

    const safeRect = sys.getSafeAreaRect();
    const visibleSize = view.getVisibleSize();
    
    // 计算四个方向的安全边距
    const top = visibleSize.height - safeRect.yMax;
    const bottom = safeRect.yMin;
    const left = safeRect.xMin;
    const right = visibleSize.width - safeRect.xMax;
    
    widget.top = top;
    widget.bottom = bottom;
    widget.left = left;
    widget.right = right;
    widget.updateAlignment();
}

// iPhone 15 Pro 安全区示例值：
// top: 59pt（灵动岛区域）
// bottom: 34pt（Home 指示条）
```

#### 各主流设备适配对照

| 设备 | 分辨率 | 宽高比 | 适配难点 |
|------|--------|--------|---------|
| iPhone SE | 750×1334 | 16:9 | 基准尺寸，无特殊处理 |
| iPhone 15 Pro | 1179×2556 | 19.5:9 | 灵动岛 + 底部手势条 |
| iPad Pro 11" | 1668×2388 | 4:3 | 宽度差异大，UI 需弹性布局 |
| Android 21:9 | 1080×2520 | 21:9 | 极窄长条，两侧裁切严重 |

### ⚡ 实战经验

1. **不要用绝对坐标布局 UI**：新手最常犯的错误——在 1280×720 设计分辨率下把按钮放在 (600, 300)，换到 19.5:9 屏幕上按钮就跑偏了。永远用 Widget + 边缘对齐，让引擎帮你算位置
2. **背景图做大一圈**：背景图在设计分辨率四周各多出 10%-15% 的溢出区域。这样在 19.5:9 或 21:9 的长屏设备上不会出现黑边。编辑器里用 noBorder 模式预览各种比例
3. **刘海屏适配要趁早**：等项目上线才发现刘海挡住了关键 UI 按钮就晚了。建议开发阶段就用 `sys.getSafeAreaRect()` 在编辑器中可视化安全区域边界
4. **横竖屏切换处理**：部分平板游戏支持横竖屏切换，需要在 `view.on('canvas-resize')` 中重新调整 Widget 布局。注意切换动画期间要禁止用户操作，避免点击穿透

### 🔗 相关问题

- Cocos Creator 中如何实现响应式 UI 布局（类似 CSS Flexbox 的效果）？
- 如何处理横竖屏切换时的 UI 重新布局？
- Laya 和 Cocos 在多分辨率适配方案上有什么差异？
