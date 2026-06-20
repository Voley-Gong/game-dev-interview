---
title: "Unity JsonUtility 与 Newtonsoft.Json 序列化方案对比及陷阱"
category: "unity"
level: 2
tags: ["序列化", "C#", "JsonUtility", "Newtonsoft", "数据持久化"]
related: ["unity/serialization-system", "unity/scriptableobject-architecture"]
hint: "JsonUtility 为什么不支持 Dictionary？IL2CPP 下序列化框架有哪些坑？"
---

## 参考答案

### ✅ 核心要点

1. **JsonUtility 是 Unity 内置的高性能序列化器**，基于 C++ 层实现，速度快、GC 低，但功能受限
2. **Newtonsoft.Json (Json.NET) 功能全面**，支持 Dictionary、多态、循环引用等高级场景，但 GC 压力更大
3. **JsonUtility 的核心限制**：不支持 Dictionary、不支持 `null` 集合元素、不支持多态序列化、必须用 `[Serializable]` + `[field: SerializeField]`
4. **IL2CPP 下 Newtonsoft 需要特殊处理**：反射 AOT 会被裁剪，需要 `link.xml` 或 `Il2CppSetOption` 保护
5. **生产建议**：热数据（存档、配置）用 JsonUtility，复杂嵌套结构用 Newtonsoft，网络协议考虑 MemoryPack 或 MessagePack

### 📖 深度展开

#### JsonUtility 基础用法

```csharp
[Serializable]
public class PlayerData
{
    public string playerName;
    public int level;
    public float exp;
    [NonSerialized] public string tempCache; // 不参与序列化

    // ❌ 不支持 Dictionary
    // public Dictionary<string, int> items;

    // ✅ 用列表模拟
    public List<ItemEntry> itemList = new();
}

[Serializable]
public class ItemEntry
{
    public string key;
    public int value;
}

// 序列化
string json = JsonUtility.ToJson(playerData, prettyPrint: true);

// 反序列化
PlayerData data = JsonUtility.FromJson<PlayerData>(json);

// 增量更新（性能优化：复用对象）
JsonUtility.FromJsonOverwrite(json, existingPlayerData);
```

#### JsonUtility vs Newtonsoft.Json 性能对比

| 维度 | JsonUtility | Newtonsoft.Json |
|------|-------------|-----------------|
| 序列化速度 | ★★★★★ (C++ native) | ★★★☆☆ |
| 反序列化速度 | ★★★★☆ | ★★★☆☆ |
| GC 分配 | 极低（可复用对象） | 较高（大量 string/反射） |
| Dictionary 支持 | ❌ | ✅ |
| 多态序列化 | ❌ | ✅ (`TypeNameHandling`) |
| null 元素 | 跳过不输出 | 可配置 (`NullValueHandling`) |
| 只读属性 | 不序列化 | 可序列化 |
| LINQ 查询 | ❌ | ✅ (`JObject`, `JToken`) |
| IL2CPP 兼容 | ✅ 原生支持 | ⚠️ 需要裁剪保护 |

#### Dictionary 序列化的绕行方案

```csharp
// 方案一：ISerializationCallbackReceiver（推荐）
[Serializable]
public class SerializableDict : ISerializationCallbackReceiver
{
    public Dictionary<string, int> runtime = new();

    [SerializeField] private List<string> keys = new();
    [SerializeField] private List<int> values = new();

    public void OnBeforeSerialize()
    {
        keys.Clear();
        values.Clear();
        foreach (var kv in runtime)
        {
            keys.Add(kv.Key);
            values.Add(kv.Value);
        }
    }

    public void OnAfterDeserialize()
    {
        runtime.Clear();
        for (int i = 0; i < keys.Count; i++)
            runtime[keys[i]] = values[i];
    }
}
```

#### IL2CPP 下 Newtonsoft 的裁剪问题

```xml
<!-- link.xml：保护 Newtonsoft.Json 不被 IL2CPP 裁剪 -->
<linker>
  <assembly fullname="Newtonsoft.Json" preserve="all"/>
  <assembly fullname="System">
    <type fullname="System.ComponentModel.TypeConverter" preserve="all"/>
  </assembly>
</linker>
```

### ⚡ 实战经验

1. **存档系统首选 `FromJsonOverwrite`**：它不会创建新对象，直接填充已有实例，零 GC，对移动端存档频繁读写的场景非常关键
2. **网络协议别用 JSON**：如果项目对网络性能敏感，考虑 MemoryPack（零编码二进制）或 Protobuf，序列化体积和速度比 JSON 快 10 倍以上
3. **Newtonsoft + IL2CPP 的坑不止 link.xml**：某些泛型类型的元数据在运行时才被 JIT，IL2CPP AOT 编译时找不到，会抛 `ExecutionEngineException`；推荐用 `AOT.cs` 预生成代理
4. **不要在热路径用反射**：如果每帧反序列化数据，即使是 JsonUtility 也要注意 `FromJson` 会分配新字符串，建议用 `JsonUtility.FromJsonOverwrite` 配合对象池

### 🔗 相关问题

- Unity 的 `[Serializable]` 和 `[SerializeField]` 有什么区别？
- 如何实现一个支持版本迁移的存档系统？
- MemoryPack / MessagePack 在 Unity 中如何使用？
