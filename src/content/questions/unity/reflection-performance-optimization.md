---
title: "C# 反射（Reflection）在 Unity 中有哪些性能陷阱？如何优化反射调用、缓存 PropertyInfo / MethodInfo？"
category: "unity"
level: 2
tags: ["C#", "反射", "性能优化"]
related: ["unity/gc-performance", "unity/serialization-system"]
hint: "反射很强大但很慢——想想 MethodInfo.Invoke 到底做了什么，有没有办法绕过反射实现高性能动态调用？"
---

## 参考答案

### ✅ 核心要点

1. **反射开销来源**：类型元数据查找、参数装箱（object[]）、安全检查、JIT 间接调用——单次 `MethodInfo.Invoke` 比直接调用慢 100-1000 倍
2. **缓存策略**：`Type.GetMethod()` / `Type.GetProperty()` 的查找开销最大，缓存 `MethodInfo`/`PropertyInfo` 实例可消除重复查找
3. **高性能替代方案**：Delegate.CreateDelegate → 编译为强类型委托，性能接近直接调用（仅 1.5-3x 开销）
4. **Expression Tree 编译**：`Expression.Compile()` 将反射调用编译为 IL，适合需要动态构建调用逻辑的场景
5. **Unity 序列化系统中的反射**：Inspector 显示、[SerializeField] 注入、JSON 反序列化大量使用反射，是 GC 和性能的隐形杀手

### 📖 深度展开

#### 反射性能瓶颈分解

```csharp
// ❌ 最差实践：每次调用都查找
public void SetFieldBad(object target, string fieldName, object value)
{
    Type type = target.GetType();
    FieldInfo field = type.GetField(fieldName);  // 遍历元数据表，~3000ns
    field.SetValue(target, value);                // 参数装箱 + 安全检查，~500ns
}
// 总计每次调用 ~3500ns

// ✅ 一般优化：缓存 MethodInfo/FieldInfo
private static readonly Dictionary<Type, FieldInfo> FieldCache = new();

public void SetFieldCached(object target, string fieldName, object value)
{
    Type type = target.GetType();
    if (!FieldCache.TryGetValue(type, out FieldInfo field))
    {
        field = type.GetField(fieldName);
        FieldCache[type] = field;  // 首次查找后缓存
    }
    field.SetValue(target, value);  // 仍然有装箱开销 ~500ns
}
// 总计每次调用 ~500ns（首次 ~3500ns）

// ✅✅ 最佳实践：Delegate.CreateDelegate
private static readonly Dictionary<Type, Action<object, object>> SetterCache = new();

public void SetFieldDelegate(object target, string fieldName, object value)
{
    Type type = target.GetType();
    if (!SetterCache.TryGetValue(type, out var setter))
    {
        FieldInfo field = type.GetField(fieldName);
        // 创建强类型委托，绕过反射调用栈
        var paramTarget = Expression.Parameter(typeof(object));
        var paramValue = Expression.Parameter(typeof(object));
        var body = Expression.Assign(
            Expression.Field(
                Expression.Convert(paramTarget, type),
                field),
            Expression.Convert(paramValue, field.FieldType));
        setter = Expression.Lambda<Action<object, object>>(body, paramTarget, paramValue).Compile();
        SetterCache[type] = setter;
    }
    setter(target, value);  // 直接调用，~5ns
}
// 总计每次调用 ~5ns（首次 ~10000ns）
```

#### 各方案性能对比

| 方案 | 首次调用 | 后续调用 | GC 开销 | 复杂度 |
|------|---------|---------|---------|--------|
| 直接调用 | ~1ns | ~1ns | 无 | 低 |
| MethodInfo.Invoke（无缓存） | ~3500ns | ~3500ns | object[] 装箱 | 低 |
| MethodInfo.Invoke（有缓存） | ~3500ns | ~500ns | object[] 装箱 | 中 |
| Delegate.CreateDelegate | ~5000ns | ~3ns | 无（强类型） | 中 |
| Expression.Compile | ~10000ns | ~5ns | 无 | 高 |
| Source Generator（编译期） | ~1ns | ~1ns | 无 | 高 |

#### Unity 序列化中的反射陷阱

```csharp
// Unity Inspector 自动序列化大量使用反射
public class ItemConfig : MonoBehaviour
{
    [SerializeField] private int id;
    [SerializeField] private string itemName;
    [SerializeField] private List<int> stats;
    // Unity 在 Inspector 渲染时，对每个 [SerializeField] 字段：
    //   1. GetFields() → 反射查找（有缓存但仍有开销）
    //   2. propertyDrawer → 反射创建 PropertyDrawer 实例
    //   3. 每帧 OnInspectorGUI → GetValue/SetValue（有缓存）
}
```

```csharp
// JsonUtility 内部使用反射（编译期生成序列化代码，性能尚可）
// 但 Newtonsoft.Json 的大多数用法是纯反射运行时 → 性能差

// ❌ Newtonsoft.Json 反序列化大量数据时
List<ItemData> items = JsonConvert.DeserializeObject<List<ItemData>>(json);
// 内部对每个属性：GetProperty → GetValue → SetValue，全部反射

// ✅ 使用 JIL / System.Text.Json（源生成器模式）
// System.Text.Json 的 source generator 在编译期生成序列化代码
[JsonSerializable(typeof(List<ItemData>))]
public partial class ItemDataContext : JsonSerializerContext { }
// 零反射，性能接近手写
```

#### Source Generator 替代反射（Unity 2022.2+）

```csharp
// 传统反射：运行时获取所有带 [CustomAttribute] 的方法
var methods = AppDomain.CurrentDomain.GetAssemblies()
    .SelectMany(a => a.GetTypes())
    .SelectMany(t => t.GetMethods())
    .Where(m => m.GetCustomAttribute<CustomAttribute>() != null);  // 极慢

// Source Generator：编译期生成注册代码
[AttributeUsage(AttributeTargets.Method)]
public class CustomAttribute : Attribute { }

// 编译期 Generator 自动生成：
//   public static class CustomMethodRegistry {
//       public static readonly Dictionary<string, Action> Methods = new() {
//           { "MyClass.DoSomething", MyClass.DoSomething },
//       };
//   }
```

#### 实战工具：高性能反射工具类

```csharp
/// <summary>
/// 高性能反射缓存，项目中推荐统一使用
/// </summary>
public static class ReflectionCache<T>
{
    private static readonly Dictionary<string, Func<T, object>> getters = new();
    private static readonly Dictionary<string, Action<T, object>> setters = new();

    public static object Get(T target, string propertyName)
    {
        if (!getters.TryGetValue(propertyName, out var getter))
        {
            var prop = typeof(T).GetProperty(propertyName);
            if (prop == null) throw new ArgumentException($"Property {propertyName} not found on {typeof(T)}");

            var paramTarget = Expression.Parameter(typeof(T));
            var body = Expression.Convert(Expression.Property(paramTarget, prop), typeof(object));
            getter = Expression.Lambda<Func<T, object>>(body, paramTarget).Compile();
            getters[propertyName] = getter;
        }
        return getter(target);
    }

    public static void Set(T target, string propertyName, object value)
    {
        if (!setters.TryGetValue(propertyName, out var setter))
        {
            var prop = typeof(T).GetProperty(propertyName);
            if (prop == null) throw new ArgumentException($"Property {propertyName} not found on {typeof(T)}");

            var paramTarget = Expression.Parameter(typeof(T));
            var paramValue = Expression.Parameter(typeof(object));
            var body = Expression.Assign(
                Expression.Property(paramTarget, prop),
                Expression.Convert(paramValue, prop.PropertyType));
            setter = Expression.Lambda<Action<T, object>>(body, paramTarget, paramValue).Compile();
            setters[propertyName] = setter;
        }
        setter(target, value);
    }
}

// 使用
ReflectionCache<Player>.Set(player, "Health", 100);  // 首次 ~10μs，后续 ~5ns
```

### ⚡ 实战经验

1. **IL2CPP 下的反射注意事项**：IL2CPP 会做静态分析裁剪未使用的类型元数据。如果运行时用 `Type.GetType("MyClass")` 但该类没有被直接引用，IL2CPP 可能裁掉它的元数据导致运行时找不到。项目中必须配置 `link.xml` 保留需要反射的类型，或者用 `[Preserve]` / `[DontCollab]` 属性标记

2. ** PropertyInfo.GetValue 的隐形装箱**：值类型属性（int、float、Vector3）通过 `GetValue` 返回 object 时必然装箱，每帧大量调用会产生严重 GC 压力。在中重度使用反射的 UI 框架中，用 Expression Tree 编译强类型 getter 后 GC 从每帧 4KB 降到 0

3. **Unity 编辑器 vs 运行时反射差异**：编辑器模式下 `GetFields()` 默认返回非 public 字段（因为 Inspector 需要），而运行时 IL2CPP 模式下某些 BindingFlags 组合可能行为不同。跨平台项目中测试反射代码时务必在 Player 模式下验证，不要只依赖编辑器测试

4. **热更新框架中的反射重度场景**：xLua / HybridCLR 的 C# ↔ Lua 桥接、依赖注入容器（Zenject/VContainer）、ORM 映射等大量使用反射注册。这些框架内部通常自带 Expression Compile 优化，但如果项目自定义扩展了这些框架，注意不要在热路径中退回 `MethodInfo.Invoke`

### 🔗 相关问题

- `Expression.Compile()` 生成的委托与 `DynamicMethod` 有什么区别？IL2CPP 下能用吗？
- Unity 的 `[SerializeField]` 反序列化是反射还是 IL 生成代码？如何验证？
- Source Generator 能完全替代反射吗？哪些场景仍然需要运行时反射？
