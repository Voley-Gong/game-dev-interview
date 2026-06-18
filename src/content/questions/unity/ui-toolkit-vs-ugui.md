---
title: "Unity UI Toolkit 和 UGUI 有什么区别？新项目该选哪个？"
category: "unity"
level: 2
tags: ["UI系统", "UI Toolkit", "UGUI", "UIElements", "编辑器扩展"]
related: ["unity/ugui-canvas-optimization", "unity/sprite-atlas-optimization"]
hint: "从渲染机制、开发体验、运行时性能、生态成熟度四个维度对比两套 UI 系统。"
---

## 参考答案

### ✅ 核心要点

1. **UGUI** 基于 GameObject + Canvas 的组件化 UI 系统，使用 GameObject/Component 模型，所见即所得，生态成熟
2. **UI Toolkit** 是 Unity 下一代 UI 框架，灵感来自 Web 技术（UXML ≈ HTML、USS ≈ CSS），采用保留模式渲染引擎，不依赖 GameObject
3. **核心架构差异**：UGUI 是 Canvas + Graphic 的 Canvas 渲染；UI Toolkit 是 VisualElement 树 + UIRenderer 的保留模式渲染
4. **适用场景**：运行时 UI 仍推荐 UGUI（成熟稳定）；编辑器工具开发首选 UI Toolkit（官方明确不再为 IMGUI 新增功能）
5. **未来趋势**：Unity 官方长期方向是用 UI Toolkit 统一编辑器和运行时 UI，但目前 UGUI 在运行时性能和生态上仍有显著优势

### 📖 深度展开

#### 架构对比

```
UGUI 架构（GameObject 模型）
┌────────────────────────────────────┐
│  Canvas                            │
│   ├── Image (GameObject + 组件)     │ ← 每个UI元素 = GameObject
│   │    └── CanvasRenderer           │
│   ├── Text (GameObject + 组件)      │ ← 变更频繁 → Canvas 重建
│   │    └── CanvasRenderer           │
│   └── Button (GameObject + 组件)    │
│        └── Image + Button script    │
│  渲染：Canvas 合批 → 重建网格 → 提交  │
└────────────────────────────────────┘

UI Toolkit 架构（VisualElement 树）
┌────────────────────────────────────┐
│  UIDocument                        │
│   ├── VisualElement (纯C#对象)      │ ← 不创建GameObject
│   │    ├── Label                   │ ← 轻量数据结构
│   │    └── Button                  │
│   └── VisualElement                │
│  渲染：UIRenderer 保留模式           │ ← 只重绘脏标记区域
│  布局：Yoga 布局引擎（Flexbox）      │
└────────────────────────────────────┘
```

#### 技术栈对比

| 维度 | UGUI | UI Toolkit |
|------|------|------------|
| 设计范式 | GameObject + Component | Web-like（UXML + USS） |
| 布局系统 | RectTransform（手动） | Flexbox / Yoga 自动布局 |
| 样式系统 | 组件属性 | USS（类似CSS的样式表） |
| 数据绑定 | 手动 / 第三方框架 | 内置 Binding System（SerializedObject） |
| 动画 | DOTween / Animator | USS Transition + 内置动画 |
| 事件系统 | EventSystem + Raycast | 事件冒泡模型（Bubble/Trickle） |
| 渲染 | Canvas 批渲染 | UIRenderer（保留模式） |
| 运行时支持 | ✅ 完全成熟 | ⚠️ 2022+ 才完整支持运行时 |
| 编辑器支持 | ⚠️ 可用但非官方推荐 | ✅ 官方编辑器标准 |
| 学习曲线 | 低（拖拽即可） | 中高（需要学 UXML/USS） |
| 社区生态 | 海量插件和教程 | 快速增长但仍有差距 |

#### UXML / USS 示例

```xml
<!-- HeroPanel.uxml — 类似 HTML 的声明式 UI -->
<engine:UXML xmlns:engine="UnityElements">
    <engine:VisualElement class="hero-panel">
        <engine:Label text="Knight Lv.42" class="hero-name"/>
        <engine:VisualElement class="stats-row">
            <engine:Label text="ATK" class="stat-label"/>
            <engine:Label text="1280" class="stat-value"/>
        </engine:VisualElement>
        <engine:Button text="Level Up" class="btn-primary"/>
    </engine:VisualElement>
</engine:UXML>
```

```css
/* HeroPanel.uss — 类似 CSS 的样式表 */
.hero-panel {
    background-color: rgba(20, 20, 30, 0.9);
    border-radius: 8px;
    padding: 16px;
    flex-direction: column;
}

.hero-name {
    font-size: 24px;
    color: #FFD700;
    margin-bottom: 8px;
}

.stats-row {
    flex-direction: row;
    justify-content: space-between;
}

.btn-primary {
    background-color: #4CAF50;
    color: white;
    border-radius: 4px;
    transition: background-color 0.2s; /* 自动动画过渡 */
}

.btn-primary:hover {
    background-color: #66BB6A;
}
```

```csharp
// C# 侧加载和交互
public class HeroPanelUI : MonoBehaviour
{
    private void Start()
    {
        var root = GetComponent<UIDocument>().rootVisualElement;
        
        // 加载UXML
        var visualTree = Resources.Load<VisualTreeAsset>("HeroPanel");
        visualTree.CloneTree(root);
        
        // 查询元素（类似querySelector）
        var btn = root.Q<Button>(className: "btn-primary");
        btn.clicked += OnLevelUpClicked;
    }
    
    private void OnLevelUpClicked()
    {
        Debug.Log("升级！");
    }
}
```

#### UGUI 的 Canvas 重建问题

```
UGUI 性能痛点：Canvas 重建

某个UI元素变更（如Text内容变化）
     ↓
标记整个 Canvas 为 Dirty
     ↓
Canvas.SendWillRenderCanvases()  ← 主线程！
     ↓
重新构建所有子元素的 Mesh + 材质
     ↓
如果 Canvas 过大 → 帧率暴跌

解决方案：Canvas 分层拆分
┌─ Static Canvas（不变的UI，独立Canvas）
│   └─ 背景图、装饰元素
├─ Dynamic Canvas（频繁变化的UI，独立Canvas）
│   └─ 血条、计时器、聊天文本
└─ 弹窗 Canvas（偶尔显示的UI）
    └─ 设置面板、确认框

UI Toolkit 没有这个问题：
VisualElement 只重绘标记为dirty的子树，不会全局重建
```

### ⚡ 实战经验

- **运行时项目 2024-2026 仍优先 UGUI**：UI Toolkit 的运行时渲染在移动端某些机型上存在兼容性问题（GPU instancing 支持不一致），UGUI 经过多年验证更可靠
- **编辑器扩展必须用 UI Toolkit**：Unity 官方已明确不再为 IMGUI 新增 API，PropertyDrawer / EditorWindow 新项目一律用 UI Toolkit
- **UGUI 的 Canvas 拆分是必修课**：见过太多项目把所有 UI 堆在一个 Canvas 里，血条更新导致整个 HUD 重建，帧率从 60 掉到 30。把频繁变更的元素（血条、倒计时、伤害飘字）拆到独立 Canvas
- **UI Toolkit 的样式复用很香**：USS 样式表可以跨多个 Panel 复用，主题切换（深色/浅色模式）只需要换一张 USS 文件，UGUI 要手动管理一大堆 Sprite 和 Color

### 🔗 相关问题

- UGUI 的 Canvas 的 Render Mode（Screen Space Overlay / Screen Space Camera / World Space）各自适用于什么场景？
- UI Toolkit 如何实现运行时数据绑定（MVVM 模式）？
- 在 UGUI 中如何优化大量 Text 元素的渲染性能（TextMeshPro vs Text）？
