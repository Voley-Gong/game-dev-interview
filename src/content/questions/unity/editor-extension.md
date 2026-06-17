---
title: "Unity 编辑器扩展的核心机制有哪些？如何编写高效的 Editor 脚本？"
category: "unity"
level: 3
tags: ["编辑器扩展", "EditorScripting", "工具开发"]
related: ["unity/scriptableobject-architecture", "unity/monobehaviour-lifecycle"]
hint: "EditorWindow、PropertyDrawer、Custom Inspector 是三大支柱——理解 SerializedObject 是关键。"
---

## 参考答案

### ✅ 核心要点

1. **三大入口**：`EditorWindow`（独立窗口）、`CustomEditor`（Inspector 面板定制）、`PropertyDrawer`（单个字段的自定义绘制）
2. **SerializedObject / SerializedProperty 是安全操作序列化数据的唯一正确方式**——直接反射修改会破坏 Undo/Redo 和 Prefab 覆盖
3. **`GUILayout` vs `EditorGUILayout` vs `UIElements（UI Toolkit）`** 是三代绘制方案，UI Toolkit 是未来方向
4. **编辑器脚手架**：`MenuItem`、`InitializeOnLoad`、`AssetPostprocessor` 等静态回调构成自动化骨架
5. **Editor 程序集分离**：用 `.asmdef` 的 Editor 平台限制，确保编辑器代码不进打包

### 📖 深度展开

#### 架构总览

```
Unity Editor Extension 生态
├── 窗口与面板
│   ├── EditorWindow          → 自定义独立窗口（如批量工具面板）
│   ├── CustomEditor          → 替换 Inspector 默认显示
│   └── PropertyDrawer        → 自定义单个字段/类的绘制方式
├── 数据操作
│   ├── SerializedObject      → 安全读写目标对象（支持 Undo/Prefab）
│   ├── AssetDatabase         → 资产的创建/导入/修改/删除
│   └── EditorUtility         → 进度条、对话框、文件选择等
├── 自动化钩子
│   ├── InitializeOnLoad      → 编辑器启动时执行
│   ├── AssetPostprocessor    → 资源导入回调
│   └── EditorApplication     → update/delegate 回调
└── 绘制系统
    ├── EditorGUILayout (IMGUI)  → 即时模式，简单但性能差
    └── UIElements (UI Toolkit)  → 保留模式，MVVM，高性能
```

#### 实战示例 1：自定义 Inspector

```csharp
// 目标脚本
public class EnemySpawner : MonoBehaviour
{
    public int spawnCount = 10;
    public float spawnRadius = 5f;
    public List<GameObject> enemyPrefabs = new();
    [HideInInspector] public bool isSpawning = false;
}

// 自定义 Inspector
[CustomEditor(typeof(EnemySpawner))]
public class EnemySpawnerEditor : Editor
{
    private SerializedProperty spawnCount;
    private SerializedProperty spawnRadius;
    private SerializedProperty enemyPrefabs;

    private void OnEnable()
    {
        // 缓存 SerializedProperty，避免每帧查找
        spawnCount = serializedObject.FindProperty("spawnCount");
        spawnRadius = serializedObject.FindProperty("spawnRadius");
        enemyPrefabs = serializedObject.FindProperty("enemyPrefabs");
    }

    public override void OnInspectorGUI()
    {
        serializedObject.Update(); // ← 必须先 Update

        // 分组显示
        EditorGUILayout.LabelField("生成配置", EditorStyles.boldLabel);
        EditorGUILayout.PropertyField(spawnCount);
        EditorGUILayout.PropertyField(spawnRadius);

        EditorGUILayout.Space();
        EditorGUILayout.LabelField("敌人 Prefab 列表", EditorStyles.boldLabel);
        EditorGUILayout.PropertyField(enemyPrefabs, true);

        // 添加操作按钮
        EditorGUILayout.Space();
        if (GUILayout.Button("立即生成", GUILayout.Height(30)))
        {
            var spawner = (EnemySpawner)target;
            spawner.SpawnAll();
        }

        serializedObject.ApplyModifiedProperties(); // ← 必须最后 Apply
    }
}
```

#### 实战示例 2：批量资源处理工具窗口

```csharp
public class AssetBatchProcessor : EditorWindow
{
    private string searchPattern = "t:Texture";
    private int maxTextureSize = 1024;
    private TextureImporterFormat targetFormat = TextureImporterFormat.ASTC_6x6;

    [MenuItem("Tools/批量纹理处理工具")]
    public static void ShowWindow()
    {
        GetWindow<AssetBatchProcessor>("纹理批处理");
    }

    private void OnGUI()
    {
        GUILayout.Label("纹理批量处理", EditorStyles.boldLabel);
        EditorGUILayout.Space();

        searchPattern = EditorGUILayout.TextField("搜索过滤", searchPattern);
        maxTextureSize = EditorGUILayout.IntPopup("最大尺寸", maxTextureSize,
            new[] { "512", "1024", "2048", "4096" },
            new[] { 512, 1024, 2048, 4096 });
        targetFormat = (TextureImporterFormat)EditorGUILayout.EnumPopup("目标格式", targetFormat);

        EditorGUILayout.Space();

        if (GUILayout.Button("查找匹配纹理", GUILayout.Height(25)))
        {
            var guids = AssetDatabase.FindAssets(searchPattern);
            ShowNotification(new GUIContent($"找到 {guids.Length} 个纹理"));
        }

        if (GUILayout.Button("执行批量处理", GUILayout.Height(35)))
        {
            ProcessTextures();
        }
    }

    private void ProcessTextures()
    {
        var guids = AssetDatabase.FindAssets(searchPattern);
        var paths = guids
            .Select(AssetDatabase.GUIDToAssetPath)
            .Where(p => p.EndsWith(".png") || p.EndsWith(".jpg"))
            .ToArray();

        try
        {
            AssetDatabase.StartAssetEditing(); // ← 批量操作必须包裹

            for (int i = 0; i < paths.Length; i++)
            {
                var importer = AssetImporter.GetAtPath(paths[i]) as TextureImporter;
                if (importer == null) continue;

                importer.maxTextureSize = maxTextureSize;
                importer.androidFormat = targetFormat;
                importer.iphoneFormat = targetFormat;
                importer.SaveAndReimport();

                // 显示进度条
                bool cancel = EditorUtility.DisplayCancelableProgressBar(
                    "处理纹理",
                    $"{Path.GetFileName(paths[i])} ({i + 1}/{paths.Length})",
                    (float)i / paths.Length);

                if (cancel) break;
            }
        }
        finally
        {
            AssetDatabase.StopAssetEditing(); // ← 确保释放
            EditorUtility.ClearProgressBar();
        }

        AssetDatabase.SaveAssets();
        ShowNotification(new GUIContent($"处理完成！共 {paths.Length} 张纹理"));
    }
}
```

#### 实战示例 3：PropertyDrawer

```csharp
// 自定义数据类型
[Serializable]
public class RangeFloat
{
    public float min;
    public float max;
    public float value;
}

// 自定义绘制器（最小最大滑块）
[CustomPropertyDrawer(typeof(RangeFloat))]
public class RangeFloatDrawer : PropertyDrawer
{
    public override void OnGUI(Rect position, SerializedProperty property, GUIContent label)
    {
        EditorGUI.BeginProperty(position, label, property);

        var minProp = property.FindPropertyRelative("min");
        var maxProp = property.FindPropertyRelative("max");
        var valProp = property.FindPropertyRelative("value");

        // 第一行：标签 + MinMaxSlider
        Rect sliderRect = new(position.x, position.y, position.width, 20f);
        Rect labelRect = new(position.x, position.y + 22f, 40f, 18f);
        Rect valueRect = new(position.x + 45f, position.y + 22f, position.width - 45f, 18f);

        EditorGUI.MinMaxSlider(sliderRect, label, ref minProp.floatValue, ref maxProp.floatValue, 0f, 100f);
        EditorGUI.LabelField(labelRect, "Value");
        valProp.floatValue = EditorGUI.Slider(valueRect, valProp.floatValue, minProp.floatValue, maxProp.floatValue);

        EditorGUI.EndProperty();
    }

    public override float GetPropertyHeight(SerializedProperty property, GUIContent label)
    {
        return 42f; // 两行高度
    }
}
```

#### IMGUI vs UI Toolkit 对比

| 维度 | IMGUI (EditorGUILayout) | UI Toolkit (UIElements) |
|------|------------------------|------------------------|
| 模式 | 即时模式（每帧重绘） | 保留模式（DOM 树） |
| 性能 | 复杂界面卡顿 | 高效，只更新变化部分 |
| 数据绑定 | 手动同步 | 自动绑定（Binding API） |
| 样式 | C# 硬编码 | USS（类 CSS） |
| 学习曲线 | 低，上手快 | 中高，需学 UXML/USS |
| Unity 版本 | 全版本 | 2021+ 推荐，2023+ 主推 |
| 未来方向 | 逐步弃用 | 官方主推 |

### ⚡ 实战经验

1. **始终使用 SerializedObject/SerializedProperty**：直接用 `serializedObject.FindProperty()` + `ApplyModifiedProperties()`，才能保证 Undo/Redo、Prefab 覆盖、多选编辑全部正常。反射修改字段会绕过 Unity 序列化系统，导致各种幽灵 Bug
2. **批量资源操作必须包裹 `AssetDatabase.StartAssetEditing()` / `StopAssetEditing()`**：否则每次 `SaveAndReimport` 都会触发完整的资产导入管线，100 个文件可能等 5 分钟；包裹后批量导入只需 30 秒
3. **用 `.asmdef` 隔离 Editor 代码**：创建 `Editor/MyTool.Editor.asmdef`，设置 `includePlatforms: ["Editor"]`，确保编辑器代码绝对不会被打包进游戏。忘记隔离是导致 Build 失败的常见原因
4. **EditorApplication.delayCall 替代构造函数**：`[InitializeOnLoad]` 的静态构造函数在 Unity 编译时就会执行，此时很多 API 不可用。用 `EditorApplication.delayCall += () => { ... }` 延迟到编辑器就绪后执行

### 🔗 相关问题

- 如何用 UI Toolkit（UIElements）替代 IMGUI 编写编辑器工具？
- AssetPostprocessor 如何实现纹理导入的自动化规范？
- 如何编写自定义的 Build Pipeline 脚本？
