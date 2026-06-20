---
title: "Unity RectTransform 与 UGUI 布局系统详解：锚点、轴心点、Layout Group 如何协同工作？"
category: "unity"
level: 2
tags: ["UI系统", "UGUI", "布局", "RectTransform", "响应式"]
related: ["unity/ugui-canvas-optimization", "unity/ui-toolkit-vs-ugui", "unity/sprite-atlas-optimization"]
hint: "RectTransform 的 anchor 与 pivot 有什么区别？Layout Group 的布局算法是怎样执行的？"
---

## 参考答案

### ✅ 核心要点

1. **RectTransform 继承自 Transform**，额外增加 `anchorMin/anchorMax`（锚点范围）、`anchoredPosition`（相对锚点的位置）、`sizeDelta`（尺寸增量）、`pivot`（轴心点）四个核心属性来描述 2D 布局
2. **锚点（Anchor）定义父子之间的弹性关系**：锚点是父 RectTransform 上的一个矩形区域（0,0 到 1,1 的归一化坐标），子物体根据锚点在父物体缩放时自动调整位置和大小
3. **Layout Group 系统是自上而下的布局引擎**：`HorizontalLayoutGroup`、`VerticalLayoutGroup`、`GridLayoutGroup` 通过 `ILayoutElement` 接口收集子元素尺寸需求，计算并强制设置每个子元素的 RectTransform
4. **布局更新是异步的**：修改 Layout Group 属性不会立即更新子元素位置，Unity 会在该帧的 Canvas 更新阶段（`Canvas.willRenderCanvases`）统一执行布局计算
5. **Content Size Fitter 是双向布局桥**：它监听子元素的 `preferredWidth/Height` 变化，反向驱动父 RectTransform 的尺寸，但与 Layout Group 嵌套时容易产生循环更新

### 📖 深度展开

#### RectTransform 核心属性关系

```
┌─────────── 父 RectTransform ───────────┐
│                                        │
│    ┌─── 锚点矩形 (Anchor Rect) ───┐    │
│    │  anchorMin = (0.3, 0.2)      │    │
│    │  anchorMax = (0.7, 0.8)      │    │
│    │                              │    │
│    │  ┌─── 子 RectTransform ───┐  │    │
│    │  │  pivot = (0.5, 0.5)    │  │    │
│    │  │  sizeDelta = (0, 0)    │  │    │
│    │  │  → 跟随锚点矩形拉伸     │  │    │
│    │  │  sizeDelta = (-20,-20) │  │    │
│    │  │  → 比锚点矩形各边内缩10px│ │    │
│    │  └────────────────────────┘  │    │
│    └──────────────────────────────┘    │
└────────────────────────────────────────┘

关键公式：
  子物体左边界 = 父宽 × anchorMin.x + offsetMin.x
  子物体右边界 = 父宽 × anchorMax.x + offsetMax.x
  子物体宽度  = 右边界 - 左边界
  
  当 anchorMin.x == anchorMax.x 时：
    子物体宽度 = sizeDelta.x（固定尺寸，不随父缩放）
  当 anchorMin.x != anchorMax.x 时：
    子物体宽度随父宽度弹性变化
```

#### 锚点预设与布局策略

| 锚点配置 | 效果 | 适用场景 |
|---------|------|---------|
| 全拉伸 (0,0)-(1,1) | 四边跟随父物体 | 全屏背景、安全区容器 |
| 水平拉伸 (0,0.5)-(1,0.5) | 宽度随父，高度固定 | 顶部/底部横幅、血条 |
| 垂直拉伸 (0.5,0)-(0.5,1) | 高度随父，宽度固定 | 侧边栏 |
| 中心点 (0.5,0.5)-(0.5,0.5) | 固定大小，居中跟随 | 按钮、图标 |
| 四角锚点（如左下 0,0-0,0） | 固定大小，钉在某角 | 角标、悬浮按钮 |
| 自定义相对锚点 | 精确比例控制 | 分屏布局、Grid Cell |

#### Layout Group 执行流程

```
Canvas.willRenderCanvases (每帧或脏标记触发)
         │
         ▼
┌─ LayoutRebuilder 重建流程 ──────────────────────┐
│                                                 │
│  1. 从子节点向上查找，找到顶层 ILayoutGroup      │
│     (HorizontalGroup / VerticalGroup / Grid)    │
│                                                 │
│  2. 自底向上：收集子元素布局需求                  │
│     遍历子物体的 ILayoutElement：                │
│     ├── minWidth / minHeight                    │
│     ├── preferredWidth / preferredHeight         │
│     ├── flexibleWidth / flexibleHeight          │
│     └── LayoutElement 组件可覆盖默认值           │
│                                                 │
│  3. 自顶向下：计算并分配最终尺寸                  │
│     ├── 处理 padding、spacing                   │
│     ├── 处理 childForceExpand                   │
│     ├── 处理 childControlWidth/Height           │
│     └── 处理 childScaleWidth/Height             │
│                                                 │
│  4. 设置子元素的 RectTransform                   │
│     (anchoredPosition + sizeDelta)              │
│                                                 │
│  5. 处理 ContentSizeFitter（如果有）             │
│     根据子元素总尺寸调整自身大小                  │
│                                                 │
│  6. 标记布局为干净（SetDirty 不再触发）           │
└─────────────────────────────────────────────────┘
```

#### 常见布局组合模式

**模式一：自适应文字按钮**
```
Button (Content Size Fitter + Horizontal Layout Group)
  └── Text (Content Size Fitter)
```
```csharp
// 按钮：水平排列 + 自适应宽度
[RequireComponent(typeof(HorizontalLayoutGroup), typeof(ContentSizeFitter))]
public class AutoSizeButton : MonoBehaviour
{
    void Start()
    {
        var fitter = GetComponent<ContentSizeFitter>();
        fitter.horizontalFit = FitMode.PreferredSize; // 宽度随内容
        fitter.verticalFit = FitMode.Unconstrained;
        
        var hlg = GetComponent<HorizontalLayoutGroup>();
        hlg.padding = new RectOffset(20, 20, 10, 10); // 内边距
        hlg.childForceExpandWidth = false;             // 不强制拉伸
        hlg.childControlWidth = true;                  // 控制子元素宽度
    }
    
    // ⚠️ 修改文字后需要强制重建布局
    public void UpdateLabel(string newText)
    {
        label.text = newText;
        LayoutRebuilder.ForceRebuildLayoutImmediate(transform as RectTransform);
    }
}
```

**模式二：可复用的列表项（含动态高度）**
```
ListItem (Vertical Layout Group + Content Size Fitter[Vertical])
  ├── Header (Horizontal Layout Group)
  │   ├── Icon (固定 64×64)
  │   └── Title (Text，水平自适应)
  ├── Description (Text，宽度自适应，高度自适应)
  └── Footer (Horizontal Layout Group)
```

**模式三：安全区适配**
```csharp
public class SafeAreaFitter : MonoBehaviour
{
    private RectTransform _rectTransform;
    
    void Awake()
    {
        _rectTransform = GetComponent<RectTransform>();
        ApplySafeArea();
    }
    
    // 处理屏幕旋转时的安全区变化
    Rect _lastSafeArea;
    void Update()
    {
        if (Screen.safeArea != _lastSafeArea)
            ApplySafeArea();
    }
    
    void ApplySafeArea()
    {
        var safeArea = Screen.safeArea;
        _lastSafeArea = safeArea;
        
        // 将屏幕安全区转换为 RectTransform 的 offset
        var parentRect = _rectTransform.parent as RectTransform;
        if (parentRect == null) return;
        
        // 获取父矩形在屏幕空间的尺寸
        Vector2 parentSize = parentRect.rect.size;
        
        // 安全区偏移（相对于父容器）
        Vector2 anchorMin = safeArea.position;
        Vector2 anchorMax = safeArea.position + safeArea.size;
        anchorMin.x /= Screen.width;
        anchorMin.y /= Screen.height;
        anchorMax.x /= Screen.width;
        anchorMax.y /= Screen.height;
        
        _rectTransform.anchorMin = anchorMin;
        _rectTransform.anchorMax = anchorMax;
        _rectTransform.offsetMin = Vector2.zero;
        _rectTransform.offsetMax = Vector2.zero;
    }
}
```

#### Layout Group 嵌套的性能影响

| 层级 | 计算复杂度 | 帧耗时（100 个子元素） | 建议 |
|------|-----------|---------------------|------|
| 1 层 | O(n) | <0.1ms | 完全可以 |
| 2 层 | O(n×m) | 0.1-0.5ms | 合理范围 |
| 3 层+ | O(n×m×k) | >1ms | 避免深层嵌套 |
| Scroll + 动态增删 | 高频 SetLayoutDirty | 每次增删都触发重建 | 用对象池 + LayoutRebuilder.ForceRebuild 批量处理 |

### ⚡ 实战经验

- **LayoutRebuilder.ForceRebuildLayoutImmediate 的坑**：它只会重建当前节点及其子树，不会向上传播。如果父级 ContentSizeFitter 依赖子元素的尺寸变化，需要在子级重建后再调用一次父级的 `ForceRebuildLayoutImmediate`，或者利用 `Coroutine` 延迟一帧
- **不要在 Update 中频繁操作 RectTransform**：频繁 SetPositionAndRotation 会触发 Canvas 重建。用脏标记模式：标记数据变化，在 LateUpdate 中批量更新 UI；或使用 `Canvas.willRenderCanvases` 注册一次性更新回调
- **ScrollView 大量 Item 用虚拟滚动**：超过 50 个列表项，不要用 Layout Group + ContentSizeFifter 全量布局，改用循环复用（ScrollRect + 对象池），只对可视区 + buffer 的 Item 做布局计算。开源方案如 EnhancedScroller、SuperScrollView 都是这个原理
- **锚点配置做响应式 UI**：不要在代码里写不同分辨率的位置偏移。用锚点预设 + Layout Group 让 UI 自然适配，只有极端比例（如折叠屏）才在代码中做特殊处理

### 🔗 相关问题

- UGUI Canvas 的重建机制是什么？哪些操作会触发 Canvas 重建？
- 如何实现高性能的无限滚动列表（Virtual Scroll）？
- UI Toolkit 的布局系统（Flexbox/Yoga）与 UGUI 的 Layout Group 有何区别？
