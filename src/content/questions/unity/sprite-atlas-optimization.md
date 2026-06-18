---
title: "Unity Sprite Atlas（图集）的原理与优化策略？"
category: "unity"
level: 2
tags: ["UI系统", "图集", "Sprite Atlas", "性能优化", "DrawCall"]
related: ["unity/ugui-canvas-optimization", "unity/drawcall-batching"]
hint: "为什么把零散小图合成一张大图能减少 DrawCall？图集太大会有什么问题？"
---

## 参考答案

### ✅ 核心要点

1. **Sprite Atlas** 将多张小 Sprite 合并为一张纹理图集，减少 GPU 纹理切换开销，是 UGUI 降低 DrawCall 的核心手段
2. Unity 提供两种图集方案：**Sprite Atlas（Unity 2017.1+，推荐）** 和旧版 **Sprite Packer（已弃用）**
3. 图集通过 **减少 SetPass Call**（Shader Pass 切换）提升性能——同一图集内的 Sprite 如果材质相同，可以合批到同一个 Draw Call
4. **Late Binding（延迟绑定）** 机制：图集运行时才决定实际包含哪些 Sprite，支持变体（Variant）实现设备适配
5. 图集不是越大越好——超大图集会导致内存浪费、加载卡顿、Mipmap 失效等问题

### 📖 深度展开

#### 为什么图集能减少 DrawCall

```
❌ 不使用图集（3 个 Draw Call）
┌─────────────┐  SetPass 1: UI/Default + icon_a.png
│  Image A    │  → 绘制头像图标
├─────────────┤
│  Image B    │  SetPass 2: 切换纹理 → bg.png
├─────────────┤  → 绘制背景
│  Image C    │  SetPass 3: 切换纹理 → button.png
└─────────────┘  → 绘制按钮

✅ 使用图集后（1 个 Draw Call）
┌─────────────────────────────────┐
│       Sprite Atlas (2048x2048)   │
│  ┌──────┐  ┌────────┐  ┌─────┐ │
│  │icon_a│  │  bg    │  │button│ │  SetPass 1: UI/Default + atlas.png
│  └──────┘  └────────┘  └─────┘ │  → 三个元素合批绘制
└─────────────────────────────────┘
```

#### Sprite Atlas 创建与配置

```csharp
using UnityEngine;
using UnityEngine.U2D;
using UnityEditor;
using UnityEngine.U2D.Interface;

// 编辑器脚本：批量创建图集
public class AtlasCreator
{
    [MenuItem("Tools/Create UI Atlas")]
    static void CreateAtlas()
    {
        // 创建 Sprite Atlas 资产
        SpriteAtlas atlas = new SpriteAtlas();

        // 设置图集参数
        var settings = new SpriteAtlasTextureSettings
        {
            readable = false,           // 运行时不可读（省内存）
            generateMipMaps = false,     // UI 不需要 Mipmap
            sRGB = true                 // UI 使用 sRGB 色彩空间
        };
        atlas.SetTextureSettings(settings);

        // 设置打包格式
        var packingSettings = new SpriteAtlasPackingSettings
        {
            blockOffset = 2,             // Sprite 间距
            padding = 4,                 // 边缘填充（防止采样溢出）
            enableRotation = false,      // 不旋转
            enableTightPacking = false   // UI 不用紧密打包
        };
        atlas.SetPackingSettings(packingSettings);

        // 添加 Sprite 来源（可以是文件夹或单个 Sprite）
        var source = new[] { "Assets/Art/UI/Icons" };
        atlas.AddSourcesAsync(source);

        // 保存
        AssetDatabase.CreateAsset(atlas, "Assets/Art/Atlas/ui_icons.spriteatlas");
        AssetDatabase.SaveAssets();
    }
}
```

#### 图集变体（Variant）——设备适配

```
主图集: ui_main.spriteatlas (2048x2048, ASTC 6x6)
  ├── Variant: High    (2048x2048, ASTC 4x4)  ← 高端机
  ├── Variant: Medium  (1024x1024, ASTC 6x6)  ← 中端机
  └── Variant: Low     ( 512x512,  ASTC 8x8)  ← 低端机

运行时根据设备自动选择：
  QualitySettings.GetQualityLevel() → 对应变体
```

#### 运行时加载图集中的 Sprite

```csharp
using UnityEngine.U2D;
using UnityEngine;

public class AtlasLoader : MonoBehaviour
{
    [SerializeField] private SpriteAtlas _uiAtlas;

    // 方式1：按名称获取
    public Sprite GetSprite(string name)
    {
        return _uiAtlas.GetSprite(name);
    }

    // 方式2：获取图集中所有 Sprite
    public Sprite[] GetAllSprites()
    {
        Sprite[] sprites = new Sprite[_uiAtlas.spriteCount];
        _uiAtlas.GetSprites(sprites);
        return sprites;
    }

    // 方式3：异步加载（Addressables 集成）
    async void LoadAtlasAsync()
    {
        var handle = Addressables.LoadAssetAsync<SpriteAtlas>("ui_icons");
        await handle.Task;
        Sprite sprite = handle.Result.GetSprite("icon_gold");
    }
}
```

#### 图集策略对比

| 策略 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 单一巨型图集 | DrawCall 最少 | 内存大、加载慢、更新不便 | 小型休闲游戏 |
| 按功能模块分 | 按需加载、内存可控 | 跨模块混用破坏合批 | 中大型游戏 UI |
| 按界面分（每界面一图集） | 加载/卸载清晰 | 界面间共享元素重复 | 页游式应用 |
| 按频率分（常驻/按需） | 冷启动快 | 管理复杂 | 大型 RPG/MMO |

#### Canvas Rebuild 与图集的关系

```
Canvas sendWillRenderCanvases (每帧)
  ├── 遍历所有 Graphic 组件
  ├── 检查是否需要 Rebuild（顶点/材质/布局）
  ├── 如果 Rebuild → 重新生成 Mesh → 可能打破合批
  └── 最终提交到 CanvasRenderer

图集影响：
  同图集 + 同材质 → 同批次（1 DrawCall）
  跨图集 → 不同批次（多 DrawCall）
  动态修改 Sprite → 触发 Rebuild → 如果频繁发生会很卡
```

### ⚡ 实战经验

1. **图集不是越大越好**：超过 2048x2048 的图集在部分旧设备上有兼容问题，且加载时卡顿明显。建议单图集不超过 2048x2048，按功能模块拆分多个图集
2. **注意 Sprite 的 Padding 设置**：UV 采样在 Sprite 边缘可能采到相邻 Sprite 的像素（尤其有缩放/旋转时）。Padding 至少 2-4 像素，Mipmap 模式下需要更多
3. **Include in Build 的陷阱**：Sprite Atlas 的 `Include in Build` 默认开启，图集会直接打进包体。如果使用 Addressables 远程加载图集，务必关闭此选项，否则包体重复包含
4. **运行时图集加载时机**：图集本身也是资源，加载有开销。建议在 Loading 场景预加载，避免打开 UI 时卡顿。配合 Addressables 的 `Preload` 模式效果最佳

### 🔗 相关问题

- UGUI 的 Canvas 如何影响 DrawCall 合批？多个 Canvas 一定比单个 Canvas 好 吗？
- Addressables 如何管理图集的远程更新和版本控制？
- 如果两个 Sprite 在不同图集但材质相同，还能合批吗？如何解决？
