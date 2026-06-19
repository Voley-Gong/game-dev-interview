---
title: "Unity PropertyDrawer 和 Custom Inspector 的原理与最佳实践是什么？"
category: "unity"
level: 3
tags: ["编辑器扩展", "PropertyDrawer", "Custom Inspector", "SerializedProperty"]
related: ["unity/editor-extension", "unity/serialization-system"]
hint: "从 SerializedProperty 到 GUI 绘制，PropertyDrawer 如何复用，Inspector 如何自定义？"
---

## 参考答案

### ✅ 核心要点

1. **PropertyDrawer** 用于自定义某个字段类型在 Inspector 中的绘制方式，可跨脚本复用
2. **Custom Editor（Editor 脚本）** 用于完全接管某个 MonoBehaviour/ScriptableObject 的整个 Inspector 面板
3. 底层都依赖 **SerializedObject / SerializedProperty** 系统，自动处理撤销、预制体覆盖、多选编辑
4. **PropertyAttribute** 配合 `[CustomPropertyDrawer]` 实现声明式字段绘制（如 `[Range]`, `[Header]`）
5. 直接操作 `serializedObject.FindProperty()` 比直接改字段值更安全，能正确处理预制体差异和多选

### 📖 深度展开

#### PropertyDrawer 工作流程

```
MonoBehaviour / ScriptableObject
  ↓ 自动序列化
SerializedObject (包装目标对象)
  ↓ FindProperty("fieldName")
SerializedProperty (单个字段的序列化句柄)
  ↓ Inspector 绘制
PropertyDrawer.OnGUI() ← CustomPropertyDrawer 特性绑定
  ↓
Rect 位置内绘制自定义 GUI
```

#### 自定义 PropertyDrawer 示例

定义一个特性，限制枚举字段只显示部分选项：

```csharp
// 1. 定义 Attribute
[AttributeUsage(AttributeTargets.Field)]
public class EnumFlagsAttribute : PropertyAttribute { }

// 2. 定义 Drawer
[CustomPropertyDrawer(typeof(EnumFlagsAttribute))]
public class EnumFlagsDrawer : PropertyDrawer
{
    public override void OnGUI(Rect position, SerializedProperty property, GUIContent label)
    {
        // 将 enum 按位与方式显示为多选 Toggle
        property.intValue = EditorGUI.MaskField(position, label, property.intValue, property.enumDisplayNames);
    }

    public override float GetPropertyHeight(SerializedProperty property, GUIContent label)
    {
        return EditorGUIUtility.singleLineHeight;
    }
}

// 3. 使用
public class EnemyAI : MonoBehaviour
{
    [EnumFlags]
    public EnemyBehaviorFlags behaviors;
}
```

#### Custom Editor 示例

完全自定义 MonoBehaviour 的 Inspector：

```csharp
[CustomEditor(typeof(EnemySpawner))]
public class EnemySpawnerEditor : Editor
{
    private SerializedProperty _spawnCount;
    private SerializedProperty _spawnInterval;

    private void OnEnable()
    {
        _spawnCount = serializedObject.FindProperty("spawnCount");
        _spawnInterval = serializedObject.FindProperty("spawnInterval");
    }

    public override void OnInspectorGUI()
    {
        serializedObject.Update();

        // 自定义标题
        EditorGUILayout.LabelField("敌人生成配置", EditorStyles.boldLabel);

        // 默认字段绘制
        EditorGUILayout.PropertyField(_spawnCount);
        EditorGUILayout.PropertyField(_spawnInterval);

        // 添加按钮
        if (GUILayout.Button("立即生成"))
        {
            ((EnemySpawner)target).SpawnNow();
        }

        serializedObject.ApplyModifiedProperties();
    }
}
```

#### PropertyDrawer vs Custom Editor 对比

| 维度 | PropertyDrawer | Custom Editor |
|------|---------------|---------------|
| 作用范围 | 单个字段类型 | 整个组件的 Inspector |
| 复用性 | 高（所有该类型字段自动生效） | 低（一对一绑定目标类型） |
| 灵活度 | 限定在字段 Rect 内 | 完全自由布局 |
| 预制体兼容 | 自动支持 | 需手动使用 SerializedProperty |
| 适用场景 | 枚举、自定义结构体、数据类 | 需要按钮、预览、复杂布局 |

#### 内置 PropertyAttribute 速查

| 特性 | 作用 |
|------|------|
| `[Range(min, max)]` | 浮点/整数字段显示为滑条 |
| `[Header("Title")]` | 添加分组标题 |
| `[Space(height)]` | 添加垂直间距 |
| `[Tooltip("...")]` | 悬停提示 |
| `[HideInInspector]` | 隐藏 public 字段 |
| `[SerializeField]` | 序列化 private 字段 |
| `[FormerlySerializedAs("oldName")]` | 重命名后保持序列化兼容 |

### ⚡ 实战经验

- **永远优先用 SerializedProperty 而非直接改 target.fieldName**：前者自动处理 Undo、Prefab 覆盖标记、多选，后者会破坏这些机制
- **PropertyDrawer 中 GetPropertyHeight 必须与 OnGUI 绘制高度一致**，否则会出现重叠或空白；如果需要多行，计算好 `singleLineHeight * rows + spacing`
- **避免在 OnInspectorGUI 中使用 `new GUIStyle()` 每帧创建样式**，应在构造函数或静态字段中缓存，否则会产生 GC 压力
- **Editor 脚本放在名为 `Editor` 的文件夹下**（可以是子目录如 `Editor/Custom`），否则会被打包到正式版本中

### 🔗 相关问题

- SerializedObject 的序列化流程是怎样的？哪些类型可以被序列化？
- 如何实现 Inspector 中的拖拽接收（DragAndDrop）？
- EditorWindow 和 Editor 有什么区别？各自的使用场景是什么？
