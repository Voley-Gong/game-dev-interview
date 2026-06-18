---
title: "Unity 的序列化系统是如何工作的？[SerializeField]、[System.Serializable] 有什么区别？"
category: "unity"
level: 2
tags: ["序列化", "引擎架构", "Inspector", "数据持久化"]
related: ["unity/scriptableobject-architecture", "unity/gameobject-component-model"]
hint: "Inspector 里能看到的字段，背后都经过了序列化引擎的处理。理解序列化是掌握 Unity 数据流的关键。"
---

## 参考答案

### ✅ 核心要点

1. **Unity 序列化引擎**是连接 C# 对象与 Inspector、Prefab、场景文件的桥梁
2. **`[SerializeField]`** 作用于 **字段**，让 private 字段也能被序列化和在 Inspector 显示
3. **`[System.Serializable]`** 作用于 **类/结构体**，让自定义类型可以被 Unity 序列化（嵌套在序列化字段中时）
4. **`ISerializationCallbackReceiver`** 是序列化前后的钩子，用于桥接无法直接序列化的数据结构
5. **序列化规则有严格限制**：只序列化字段（不是属性）、不支持 null 字典、不支持多态引用等

### 📖 深度展开

#### Unity 序列化的底层流程

```
Inspector / Prefab / Scene 文件（YAML）
         ↕ 序列化 / 反序列化
   Unity C++ 序列化层（internal）
         ↕ 托管桥接
   C# 对象（MonoBehaviour / ScriptableObject）
```

每次 Inspector 显示、Prefab 保存、场景保存时，Unity 都会走一遍序列化/反序列化流程。

#### 核心特性对比

| 特性 | `[SerializeField]` | `[System.Serializable]` |
|------|--------------------|--------------------------|
| 作用对象 | 字段（field） | 类 / 结构体 |
| 命名空间 | `UnityEngine` | `System` |
| 效果 | 让 private 字段可被序列化 | 让自定义类型可被 Unity 序列化引擎识别 |
| 必须搭配 | 字段类型本身也需可序列化 | 通常在 MonoBehaviour/SO 中作为字段使用 |

#### 代码示例

```csharp
using UnityEngine;
using System;
using System.Collections.Generic;

// ✅ 自定义可序列化类
[Serializable]
public class EnemyWave
{
    public string waveName;
    public int enemyCount;
    public float spawnInterval;

    [SerializeField] private int internalId; // private 也可序列化

    // ❌ 属性不会被序列化
    public int DoubledCount => enemyCount * 2;
}

public class LevelManager : MonoBehaviour
{
    [SerializeField] private EnemyWave[] waves;           // ✅ 数组
    [SerializeField] private List<EnemyWave> waveList;    // ✅ List
    [SerializeField] private float difficulty = 1f;       // ✅ private 字段

    // ❌ 以下不会被序列化
    public Dictionary<string, EnemyWave> waveMap;          // 字典不支持
    public EnemyWave CurrentWave { get; set; }              // 属性不序列化
}
```

#### ISerializationCallbackReceiver 模式

当需要在 Inspector 中显示字典等不支持的类型时：

```csharp
[Serializable]
public class StringToFloatDict
{
    public string key;
    public float value;
}

public class Blackboard : MonoBehaviour, ISerializationCallbackReceiver
{
    // 运行时使用，不被 Unity 直接序列化
    public Dictionary<string, float> values = new();

    // 序列化用的中间格式
    [SerializeField] private List<StringToFloatDict> serialized = new();

    // 序列化前：把 Dictionary 转成 List
    public void OnBeforeSerialize()
    {
        serialized.Clear();
        foreach (var kv in values)
            serialized.Add(new StringToFloatDict { key = kv.Key, value = kv.Value });
    }

    // 反序列化后：把 List 转回 Dictionary
    public void OnAfterDeserialize()
    {
        values.Clear();
        foreach (var entry in serialized)
            values[entry.key] = entry.value;
    }
}
```

#### 序列化规则速查表

| 类型 | 可序列化？ | 备注 |
|------|-----------|------|
| `public` 字段 | ✅ | 默认序列化 |
| `private` 字段 + `[SerializeField]` | ✅ | |
| `protected` 字段 + `[SerializeField]` | ✅ | |
| 属性（Property） | ❌ | 编译器自动生成的 backing field 也不行 |
| `static` 字段 | ❌ | 不属于实例 |
| `const` / `readonly` | ❌ | |
| `Dictionary<K,V>` | ❌ | 需用 ISerializationCallbackReceiver |
| `List<T>` / `T[]` | ✅ | T 需可序列化 |
| 自定义类 + `[System.Serializable]` | ✅ | 不能继承自 Object |
| `UnityEngine.Object` 子类引用 | ✅ | 以引用形式序列化（GUID） |

#### 值类型 vs 引用类型序列化

```csharp
// 自定义 [Serializable] 类 → 值语义（内联序列化）
[Serializable]
public class Stat { public int value; }

// MonoBehaviour 字段中存储的是副本，不是引用
public class Hero : MonoBehaviour
{
    public Stat attack = new Stat(); // 每个 Hero 有自己的副本
}

// 如果需要共享引用 → 用 ScriptableObject
[CreateAssetMenu]
public class SharedStat : ScriptableObject { public int value; }
```

### ⚡ 实战经验

- **Prefab 覆盖的原理**：序列化字段的差异以 override 形式存在 Prefab 中，理解这点才能调试 "为什么改了没用" 的问题
- **`[field: SerializeField]` 陷阱**：C# 自动属性加 `[field: SerializeField]` 在 Unity 中会生成 `k__BackingField` 名字的字段，虽然能序列化但 Inspector 显示名是乱码，不推荐
- **序列化深度限制**：Unity 对嵌套 `[Serializable]` 类有深度限制（默认 7 层），过深的数据结构会被截断
- **`HideInInspector` vs `NonSerialized`**：`[HideInInspector]` 仍会序列化（只是 Inspector 不显示），`[NonSerialized]` 完全不序列化——存档/网络同步场景需注意区别

### 🔗 相关问题

- ScriptableObject 的序列化和 MonoBehaviour 有什么不同？
- Prefab 的序列化覆盖（Override）机制是怎样的？
- 如何自定义 PropertyDrawer 来美化 Inspector 中自定义类型的显示？
