---
title: "Unity UGUI Canvas 性能优化有哪些关键策略？"
category: "unity"
level: 2
tags: ["UI", "性能优化", "UGUI", "Canvas"]
related: ["unity/drawcall-batching", "unity/gpu-instancing"]
hint: "Canvas 重建(Rebuild)和重排(Rebatch)是两大性能杀手，关键在于分屏和减少脏标记"
---

## 参考答案

### ✅ 核心要点

1. **Canvas 是 UGUI 渲染的基本单元**：一个 Canvas 内的元素会合批为一个 Mesh，但 Canvas 内任意元素变化会触发整个 Canvas 的 Mesh 重建
2. **三大性能杀手**：Rebuild（顶点/布局重建）、Rebatch（合批重新计算）、Overdraw（重叠 UI 元素的过度绘制）
3. **分 Canvas 策略**：静态 UI 和动态 UI 必须拆分到不同 Canvas，避免高频变化的元素拖累静态元素
4. **Graphic Raycaster 开销**：UI 点击检测会遍历 Canvas 下所有可交互元素，复杂 UI 的射线检测消耗惊人
5. **图集（Sprite Atlas）是合批的前提**：不同图集的 Sprite 会打断合批，合理规划图集是 UI 性能的基础

### 📖 深度展开

#### Canvas 渲染流程

```
Canvas 更新流程（每帧）
├── 1. Rebuild（重建阶段）
│     ├── Layout Rebuild（布局计算）
│     │     └── 水平/垂直布局递归计算
│     └── Graphic Rebuild（图形重建）
│           └── 重新生成顶点/UV/颜色数据
│
├── 2. Rebatch（重新合批）
│     ├── 按材质/纹理/渲染顺序分组
│     ├── 合并相同材质的顶点到同一个 Mesh
│     └── 输出 SubMesh 列表（每个 SubMesh = 1 个 DrawCall）
│
├── 3. SendWillRenderCanvases
│     └── 调用 Canvas.sendWillRenderCanvases 事件
│
└── 4. 渲染提交
      └── CanvasRenderer → 渲染管线 → 上屏
```

**关键结论**：只要一个元素被标记为 "Dirty"（脏标记），它所在的整个 Canvas 都需要 Rebuild + Rebatch。这就是为什么要拆分 Canvas。

#### Canvas 拆分策略

```
UI 根节点
├── Static Canvas（静态 Canvas）
│     ├── 背景图（永不变化）
│     ├── 装饰边框
│     └── 静态文字
│     → 永远不会 Rebuild，性能几乎为零
│
├── Dynamic Canvas（动态 Canvas）
│     ├── 血条 / 计时器（每帧更新）
│     ├── 弹幕 / 滚动列表
│     └── 动画 UI
│     → 频繁 Rebuild，但只影响这个 Canvas
│
└── Overlay Canvas（顶层 Canvas）
      ├── Toast 提示
      └── 加载进度条
      → 独立分层，不干扰其他 UI
```

| 拆分维度 | 策略 | 原因 |
|---------|------|------|
| 更新频率 | 静态 / 动态分离 | 避免静态元素被动重建 |
| 渲染层级 | 背景层 / 内容层 / 弹窗层 | 分层管理合批，减少单 Canvas 复杂度 |
| 功能模块 | HUD / 背包 / 设置 | 模块独立开关，关闭时整个 Canvas Disable |

#### 常见性能问题与优化方案

**问题 1：Text 每帧变化导致整个 Canvas Rebuild**

```csharp
// ❌ 错误：直接修改 Text 组件
// 每次 text.text = "xxx" 都会标记整个 Canvas 为 Dirty
scoreText.text = score.ToString(); // 每帧调用 → 每帧 Rebuild

// ✅ 优化方案 A：拆分到独立 Canvas
// 将分数 Text 放到单独的 Canvas 下，只影响这个小 Canvas
[Header("独立 Canvas 上的分数显示")]
public Canvas scoreCanvas; // 只包含分数 Text

// ✅ 优化方案 B：减少更新频率
private float updateTimer = 0f;
private const float UPDATE_INTERVAL = 0.1f; // 10 帧更新一次

void Update()
{
    updateTimer += Time.deltaTime;
    if (updateTimer >= UPDATE_INTERVAL)
    {
        scoreText.text = score.ToString();
        updateTimer = 0f;
    }
}

// ✅ 优化方案 C：TextMeshPro 性能更好（静态时零开销）
// TMP 使用 SDF 字体，字符变化时只需更新少量顶点数据
// 推荐全项目统一使用 TextMeshPro 替代 UI.Text
```

**问题 2：滚动列表（ScrollRect）大量元素导致卡顿**

```csharp
// ❌ 错误：1000 个列表项全部实例化
// Layout Group 会计算所有元素的布局 → 巨大 Rebuild 开销

// ✅ 正确方案：对象池 + 虚拟滚动（Virtual Scroll）
// 只渲染可见区域的元素（约 10-20 个），滚动时复用
public class VirtualScrollRect : MonoBehaviour
{
    [SerializeField] private RectTransform viewport;
    [SerializeField] private RectTransform content;
    [SerializeField] private GameObject itemPrefab;

    private float itemHeight = 80f;
    private int totalItems = 1000;
    private List<RectTransform> itemPool = new();

    void Update()
    {
        float scrollTop = content.anchoredPosition.y;
        int startIndex = Mathf.FloorToInt(scrollTop / itemHeight);
        int visibleCount = Mathf.CeilToInt(viewport.rect.height / itemHeight) + 2;

        // 只更新可见范围内的元素
        for (int i = 0; i < itemPool.Count; i++)
        {
            int dataIndex = startIndex + i;
            if (dataIndex >= 0 && dataIndex < totalItems && i < visibleCount)
            {
                itemPool[i].gameObject.SetActive(true);
                itemPool[i].anchoredPosition = new Vector2(0, -dataIndex * itemHeight);
                // 更新元素内容...
            }
            else
            {
                itemPool[i].gameObject.SetActive(false);
            }
        }
    }
}

// 💡 Unity 2023+ 推荐使用 UI Toolkit 的 ListView（内置虚拟化）
// 或使用开源方案如 SuperScrollView（UGUI 虚拟滚动）
```

**问题 3：Graphic Raycaster 点击检测开销大**

```csharp
// ❌ 问题场景：复杂 UI 界面（500+ 元素）点击时
// GraphicRaycaster 会遍历所有 Raycast Target = true 的 Graphic
// 每帧检查鼠标/触摸事件，500 个元素 × 60fps = 30000 次检测/秒

// ✅ 优化：关闭不需要交互的元素的 Raycast Target
// 在 Inspector 中取消勾选 Raycast Target（Image/Text 组件上）
// 或批量处理：
[MenuItem("Tools/优化 UI Raycast Target")]
static void DisableUnusedRaycastTargets()
{
    var graphics = FindObjectsOfType<Graphic>();
    foreach (var graphic in graphics)
    {
        // 没有 Button/Toggle/Slider 等交互组件的 Graphic
        if (graphic.GetComponent<IPointerClickHandler>() == null &&
            graphic.GetComponent<IPointerDownHandler>() == null &&
            graphic.GetComponent<IPointerUpHandler>() == null &&
            graphic.GetComponent<IDragHandler>() == null &&
            !graphic.GetComponentInParent<Button>() &&
            !graphic.GetComponentInParent<Toggle>() &&
            !graphic.GetComponentInParent<Slider>())
        {
            graphic.raycastTarget = false;
            Debug.Log($"关闭: {graphic.name}", graphic);
        }
    }
}
```

#### Sprite Atlas 图集管理

```csharp
using UnityEngine.U2D;
using UnityEditor;

// ✅ 项目中所有 UI Sprite 必须放入 Sprite Atlas
// 1. 创建 Sprite Atlas: Create > 2D > Sprite Atlas
// 2. 将同模块的 Sprite 拖入
// 3. 运行时自动合批，不需要手动加载

// 运行时动态获取 Atlas 中的 Sprite（按需）
public class IconLoader : MonoBehaviour
{
    [SerializeField] private SpriteAtlas iconAtlas;
    [SerializeField] private Image iconImage;

    void SetIcon(string iconName)
    {
        // 从图集中获取 Sprite（内部已在一张大图上，不会打断合批）
        Sprite sprite = iconAtlas.GetSprite(iconName);
        iconImage.sprite = sprite;
    }
}

// 图集划分原则：
// ├── UI_Common（通用按钮、边框、背景）→ 常驻内存
// ├── UI_Login（登录界面专属）→ 登录后卸载
// ├── UI_Battle（战斗界面专属）→ 退出战斗后卸载
// └── UI_Shop（商店专属）→ 关闭商店后卸载
// 每个图集控制在 2048×2048 以内（移动端最佳）
```

### ⚡ 实战经验

1. **Canvas 拆分是 UGUI 优化的第一优先级**。曾遇到一个项目所有 UI 在一个 Canvas 上，每帧 Rebuild 耗时 8ms。拆分为 5 个 Canvas（HUD / 背包 / 聊天 / 弹窗 / 加载）后，每帧总 Rebuild 耗时降到 1.5ms。Profiler 中搜索 `Canvas.SendWillRenderCanvases` 和 `Canvas.BuildBatch` 就能定位问题
2. **Layout Group 是隐藏的性能黑洞**。VerticalLayoutGroup / GridLayoutGroup 每次有子元素变化都会递归计算所有子元素布局。深层嵌套的 LayoutGroup（布局套布局套布局）会导致 Rebuild 时间指数增长。能用绝对定位解决的 UI 就不要用 LayoutGroup
3. **Overdraw 检查用 Scene View 的 Overdraw 模式**。复杂的半透明 UI 叠加会导致严重的过度渲染（一个像素被绘制 5-10 次）。优化方向：减少半透明层级、全屏背景图用不透明 Image、考虑使用 Rect Mask 2D 裁剪不可见区域
4. **手机端 Canvas.additionalShaderChannels 要按需设置**。默认包含 TexCoord1/2/3 和 Tangent/Normal，如果自定义 UI Shader 不需要这些通道，关闭它们可以减少每顶点数据量，在大规模 UI 上有可观的带宽节省

### 🔗 相关问题

- TextMeshPro 和传统 UI.Text 在渲染原理上有什么区别？
- 如何用 Profiler 精确定位 UGUI 的性能瓶颈？
- UGUI 和 UI Toolkit 在架构和性能特征上有什么本质区别？
