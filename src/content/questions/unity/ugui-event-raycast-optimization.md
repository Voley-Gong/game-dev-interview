---
title: "Unity UGUI 事件系统如何工作？Raycast Target 对性能有什么影响？"
category: "unity"
level: 2
tags: ["UI系统", "UGUI", "性能优化", "事件系统"]
related: ["unity/ugui-canvas-optimization", "unity/sprite-atlas-optimization"]
hint: "每个 Image 和 Text 上都有 Raycast Target 勾选框——你关注过它吗？"
---

## 参考答案

### ✅ 核心要点

1. **EventSystem + GraphicRaycaster** 构成 UGUI 输入事件的核心管线
2. **Raycast Target** 控制每个 Graphic 是否参与射线检测，多余的勾选会产生不必要的遍历开销
3. **事件传递** 支持冒泡（Bubble），通过 `ExecuteEvents` 派发到目标及父级
4. **Canvas 的 GraphicRaycaster** 每次输入事件都会遍历该 Canvas 下所有 Raycast Target = true 的 Graphic
5. **大量 UI 元素时**，禁用不需要交互的 Raycast Target 是最简单有效的性能优化之一

### 📖 深度展开

#### 事件系统架构

```
用户输入 (Touch / Mouse / Keyboard)
  ↓
InputModule (StandaloneInputModule / TouchInputModule)
  ↓
EventSystem.RaycastAll → 遍历所有 Raycaster
  ↓
GraphicRaycaster (每个 Canvas 一个)
  ↓ 遍历 Canvas 下所有 Graphic
  ↓ 过滤 Raycast Target = true
  ↓ 按 hierarchy depth + sibling index 排序
  ↓
获取排序后的命中列表 (Raycast Results)
  ↓
ExecuteEvents.Execute → 派发事件 (PointerClick, Drag, etc.)
  ↓
目标对象 → 冒泡到父级 (IPointerClickHandler, IDragHandler...)
```

#### Raycast Target 的开销

每次用户点击/拖动时，`GraphicRaycaster` 会执行以下步骤：

```csharp
// 简化的 GraphicRaycaster 内部逻辑
public override void Raycast(PointerEventData eventData, List<RaycastResult> resultAppendList)
{
    // 1. 获取 Canvas 下所有激活的 Graphic
    var canvasGraphics = GraphicRegistry.GetGraphicsForCanvas(canvas);
    
    // 2. 遍历，过滤 Raycast Target
    foreach (var graphic in canvasGraphics)
    {
        if (!graphic.raycastTarget) continue;
        if (!RectTransformUtility.RectangleContainsScreenPoint(
            graphic.rectTransform, eventData.position, eventData.enterEventCamera))
            continue;
        
        if (graphic.Raycast(eventData.position, eventData.enterEventCamera))
            resultAppendList.Add(...);
    }
    
    // 3. 按深度排序
    resultAppendList.Sort(s_RaycastComparer);
}
```

**问题场景：** 一个复杂的背包面板可能有 200+ 个子物体，每个有 Image + Text，如果全部勾选 Raycast Target，每次点击事件都要遍历 400+ 个 Graphic。

#### Raycast Target 优化策略

| 策略 | 做法 | 适用场景 |
|------|------|----------|
| **逐个禁用** | 在 Inspector 取消勾选 | 纯装饰性 Image / Text |
| **批量工具** | Editor 脚本递归禁用 | 项目收尾阶段批量处理 |
| **分层 Canvas** | 交互层与装饰层分 Canvas | 大型 UI 面板 |
| **替代实现** | 用 Collider + Physics.Raycast | 3D 场景中的 UI 交互 |

#### 批量禁用 Raycast Target 的 Editor 工具

```csharp
using UnityEngine;
using UnityEngine.UI;
using UnityEditor;

public class RaycastTargetOptimizer : EditorWindow
{
    [MenuItem("Tools/Optimize Raycast Targets")]
    static void Optimize()
    {
        int count = 0;
        foreach (var selection in Selection.gameObjects)
        {
            var graphics = selection.GetComponentsInChildren<Graphic>(true);
            foreach (var g in graphics)
            {
                // 只禁用没有交互组件的 Graphic
                var hasInteractive = g.GetComponent<IPointerClickHandler>() != null
                    || g.GetComponent<IPointerDownHandler>() != null
                    || g.GetComponent<IDragHandler>() != null
                    || g.GetComponent<IBeginDragHandler>() != null
                    || g.GetComponent<IEndDragHandler>() != null;
                
                if (!hasInteractive)
                {
                    Undo.RecordObject(g, "Disable Raycast Target");
                    g.raycastTarget = false;
                    count++;
                }
            }
        }
        EditorUtility.DisplayDialog("完成", $"已禁用 {count} 个 Raycast Target", "OK");
    }
}
```

#### Canvas 分层策略

```
Panel (Canvas - Raycaster ON)
├── Decorations (Canvas - Raycaster OFF, 仅显示)
│   ├── Background Image (raycastTarget = false)
│   ├── Title Text (raycastTarget = false)
│   └── Decoration Icons (raycastTarget = false)
├── Buttons (Canvas - Raycaster ON)
│   ├── Item1 Button (raycastTarget = true)
│   └── Item2 Button (raycastTarget = true)
```

### ⚡ 实战经验

- **Profiler 验证法**：在 Profiler 中搜索 `GraphicRaycaster.Raycast`，如果一帧中耗时 > 0.5ms，就值得优化
- **Text 元素最容易被忽略**：UGUI 的 Text 默认勾选 Raycast Target，但 99% 的纯展示文字不需要交互
- **InputField 特殊处理**：InputField 内部的 Caret、Placeholder 等子物体需要保留 Raycast Target，否则点击区域不准确
- **ScrollRect 性能**：滚动列表中的 Item 模板尤其要注意，模板被复制几十次，Raycast Target 开销会成倍放大

### 🔗 相关问题

- UGUI Canvas 的 Rebuild 和 Batch 过程是怎样的？（→ Canvas 优化）
- 如何在 Unity 中实现虚拟列表（Virtual Scroll）来处理万级 UI 元素？
- UI Toolkit 的事件系统与 UGUI 有何不同？
