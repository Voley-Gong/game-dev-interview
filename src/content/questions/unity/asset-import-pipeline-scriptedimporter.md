---
title: "Unity 资源导入管线如何工作？ScriptedImporter、AssetPostprocessor、AssetProcessor 的区别与自定义导入实战"
category: "unity"
level: 3
tags: ["编辑器扩展", "资源管线", "AssetImport"]
related: ["unity/texture-compression-platform", "unity/serialization-system"]
hint: "想想一个 Texture2D 从磁盘 PNG 变成运行时可用的资产，中间经历了哪些阶段？在哪里拦截和修改？"
---

## 参考答案

### ✅ 核心要点

1. **导入管线本质**：Unity 在 `AssetDatabase.ImportAsset` 时执行完整的 Import Pipeline，包括读取文件 → 创建 Importer → 导入 → 序列化 .meta → 写入 Library 缓存
2. **AssetPostprocessor**：基于回调的钩子机制，在标准资产导入前后注入自定义逻辑（如自动设置 Texture 的 MaxSize、Platform 格式）
3. **ScriptedImporter**：Unity 2018.1+ 引入的完全自定义 Importer，可以定义全新文件类型的导入行为，替代 Postprocessor 的「修改」模式为「接管」模式
4. **.meta 文件**：每个资产的 GUID、ImportSettings 序列化存储，是跨机器、跨平台一致性的核心
5. **性能要点**：首次导入大量资产时，ImportPipeline 是 CPU 密集型操作，合理配置 `AssetImportManager` 并行导入和增量导入至关重要

### 📖 深度展开

#### 导入管线完整流程

```
文件系统变化检测
    │
    ▼
┌──────────────────┐
│ 1. 确定 Importer   │  ← 按文件扩展名匹配
│   (TextureImporter │     (PNG→TextureImporter, .cs→MonoImporter)
│    / AudioImporter │
│    / ModelImporter)│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 2. 读取 .meta 设置  │  ← 用户配置的导入参数
│   (ImportSettings) │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 3. 执行导入        │  ← Importer.OnImportAsset
│   (生成主对象 +     │     生成 Texture2D / AudioClip / Mesh
│    子对象)          │     + .meta 序列化
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 4. AssetPostprocessor│  ← 回调链
│   OnPreprocess*      │     可修改导入结果
│   OnPostprocess*     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 5. 写入 Library 缓存 │  ← 下次启动直接读缓存
│   (Hash 校验)        │     Hash 变化才重新导入
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 6. 触发回调通知      │  ← AssetImportManager
│   (domain reload)    │     AssetPostprocessor
└──────────────────┘
```

#### AssetPostprocessor 实战：自动纹理设置

```csharp
public class TexturePostprocessor : AssetPostprocessor
{
    // 在纹理导入前拦截
    void OnPreprocessTexture()
    {
        TextureImporter importer = (TextureImporter)assetImporter;

        // 根据路径自动分类设置
        if (assetPath.Contains("UI/"))
        {
            importer.textureType = TextureImporterType.Sprite;
            importer.spritePackingTag = "UI_Atlas";
            importer.maxTextureSize = 2048;
            importer.textureCompression = TextureCompressionFormat.ASTC;
            importer.compressionQuality = 50;
        }
        else if (assetPath.Contains("Textures/Normal"))
        {
            importer.textureType = TextureImporterType.NormalMap;
            importer.maxTextureSize = 1024;
        }
        else // 角色 / 场景贴图
        {
            importer.maxTextureSize = 2048;
            importer.textureCompression = TextureCompressionFormat.ASTC;
        }

        // Android / iOS 平台覆盖
        importer.SetPlatformTextureSettings(new TextureImporterPlatformSettings
        {
            name = "Android",
            overridden = true,
            format = TextureImporterFormat.ASTC_6x6,
            maxTextureSize = 2048,
        });
        importer.SetPlatformTextureSettings(new TextureImporterPlatformSettings
        {
            name = "iPhone",
            overridden = true,
            format = TextureImporterFormat.ASTC_6x6,
            maxTextureSize = 2048,
        });

        Debug.Log($"[TexturePP] Auto-configured: {assetPath}");
    }

    // 所有资产导入后触发（静态方法，全局）
    static void OnPostprocessAllAssets(
        string[] importedAssets,
        string[] deletedAssets,
        string[] movedAssets,
        string[] movedFromAssetPaths)
    {
        foreach (string path in importedAssets)
        {
            if (path.EndsWith(".png"))
            {
                // 检查是否被正确引用、加入 Addressables 组等
                ValidateTextureImport(path);
            }
        }
    }
}
```

#### ScriptedImporter 实战：自定义数据格式

```csharp
// 定义新的文件类型导入器（如 .dialog 配置文件）
[ScriptedImporter(1, "dialog")]
public class DialogScriptedImporter : ScriptedImporter
{
    public string encoding = "UTF-8";

    public override void OnImportAsset(AssetImportContext ctx)
    {
        // 1. 读取文件内容
        string content = File.ReadAllText(ctx.assetPath, System.Text.Encoding.GetEncoding(encoding));

        // 2. 解析数据
        DialogData data = DialogParser.Parse(content);

        // 3. 创建主资产对象
        ctx.AddObjectToAsset("main", data);
        ctx.SetMainObject(data);

        // 4. 可选：添加子资产（如各对话节点）
        for (int i = 0; i < data.Nodes.Count; i++)
        {
            ctx.AddObjectToAsset($"node_{i}", data.Nodes[i]);
        }

        // 5. 注册依赖（文件变化时自动重新导入）
        // ctx.DependsOnSourceAsset(dependencyPath);
    }
}

// 在 Project 窗口中双击 .dialog 文件时打开自定义编辑器
[CustomEditor(typeof(DialogData))]
public class DialogDataEditor : ScriptedImporterEditor
{
    public override void OnInspectorGUI()
    {
        // 自定义 Inspector
        var data = (DialogData)target;
        EditorGUILayout.LabelField($"对话节点数: {data.Nodes.Count}");
        base.OnInspectorGUI();
    }
}
```

#### 三种导入拦截方式对比

| 维度 | AssetPostprocessor | ScriptedImporter | AssetModificationProcessor |
|------|-------------------|------------------|---------------------------|
| **触发时机** | 标准资产导入前后 | 完全接管新类型导入 | 资产增删改移动时 |
| **适用场景** | 批量自动设置纹理/模型参数 | 自定义文件格式（.csv → ScriptableObject） | 文件移动时自动修正引用 |
| **能否创建新资产类型** | ❌ 只能修改已有 | ✅ 定义全新导入行为 | ❌ 只监听文件操作 |
| **API 版本** | 一直存在 | Unity 2018.1+ | Unity 2018.1+ |
| **多处理器冲突** | 多个 PP 可能互相覆盖设置 | 每个扩展名一个 Importer，无冲突 | N/A |

### ⚡ 实战经验

1. **首次导入性能**：项目中 5000+ 张纹理首次导入可能耗时 20 分钟以上。在 CI 上用 `batchmode -importPackage` 预热导入缓存，或者用 `AssetDatabase.ForceReserializeAssets` 批量更新 .meta。另外，`AssetImportManager.SaveArguments` 可以序列化导入参数，让 CI 机器跳过实际解码

2. **Postprocessor 覆盖问题**：多个 `AssetPostprocessor` 脚本同时修改同一个纹理的设置，后执行的会覆盖前面的。项目中应该统一只保留一个 TexturePostprocessor 入口，用路径规则分发。或者用 `ScriptedImporter` 接管特定路径，避免冲突

3. **.meta 冲突与 GUID 丢失**：Git 合并冲突时 .meta 文件丢失或修改会导致 GUID 变化 → 所有引用断裂。项目中强制规则：.meta 必须提交、禁止删除 .meta、合并冲突时优先保留已有 GUID。可以用 `AssetDatabase.FindAssets` + GUID 校验脚本在 CI 上检测

4. **ScriptedImporter 的 reimport 陷阱**：修改 ScriptedImporter 代码后，所有使用该 Importer 的资产都会触发 reimport。在大项目中这可能卡死编辑器几分钟。建议在 Importer 的 `version` 参数中递增版本号，配合 `EditorUtility.SetDirty` 手动控制 reimport 时机

### 🔗 相关问题

- Unity 的 `AssetDatabase.Refresh()` 和 `AssetDatabase.ImportAsset()` 有什么区别？强制刷新会导致什么性能问题？
- 如何用 `AssetDatabase.MoveAsset()` 移动资产时自动修复引用？与直接 `File.Move` 有何不同？
- Addressables 的资源组是否可以在导入阶段自动分组？如何结合 ScriptedImporter 实现？
