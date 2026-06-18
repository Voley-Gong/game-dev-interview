---
title: "Unity 中单例模式（Singleton）有哪些实现方式？各自的优缺点是什么？"
category: "unity"
level: 2
tags: ["设计模式", "单例", "C#", "架构"]
related: ["unity/monobehaviour-lifecycle", "unity/scriptableobject-architecture"]
hint: "从最简单的 static Instance 到泛型基类、再到 ScriptableObject 单例，每种方式的适用场景不同。"
---

## 参考答案

### ✅ 核心要点

1. **普通单例**：`public static T Instance` 挂在 MonoBehaviour 上，最简单但有生命周期陷阱
2. **泛型单例基类**：提取通用 `SingletonMono<T>`，避免重复代码
3. **持久化单例**：`DontDestroyOnLoad` 保证跨场景存活
4. **ScriptableObject 单例**：数据驱动的单例，无需场景中的 GameObject
5. **嵌套/多场景安全**：需考虑重复实例检查、运行时与编辑器模式差异

### 📖 深度展开

#### 方式一：基础 MonoBehaviour 单例

```csharp
public class GameManager : MonoBehaviour
{
    public static GameManager Instance { get; private set; }

    void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        // 可选：跨场景持久化
        // DontDestroyOnLoad(gameObject);
    }

    void OnDestroy()
    {
        if (Instance == this)
            Instance = null;
    }
}
```

**优点**：简单直观，面试中写得出来。
**缺点**：每个类都要重复写这段代码；挂多个实例时静默 `Destroy` 可能掩盖配置错误。

#### 方式二：泛型单例基类

```csharp
public abstract class SingletonMono<T> : MonoBehaviour where T : MonoBehaviour
{
    static T _instance;
    static bool _isQuitting;

    public static T Instance
    {
        get
        {
            if (_isQuitting) return null;

            if (_instance == null)
            {
                _instance = FindFirstObjectByType<T>();
                if (_instance == null)
                {
                    var go = new GameObject($"[{typeof(T).Name}]");
                    _instance = go.AddComponent<T>();
                    DontDestroyOnLoad(go);
                }
            }
            return _instance;
        }
    }

    protected virtual void Awake()
    {
        if (_instance != null && _instance != this)
        {
            Destroy(gameObject);
            return;
        }
        _instance = this as T;
    }

    protected virtual void OnApplicationQuit()
    {
        _isQuitting = true;
    }
}

// 使用
public class AudioManager : SingletonMono<AudioManager>
{
    public void PlayBGM(string clipName) { /* ... */ }
}
```

**优点**：一处实现，处处复用；延迟查找自动创建。
**缺点**：`FindFirstObjectByType` 有性能开销（首次访问时）；泛型约束无法限制外部 `new`。

#### 方式三：ScriptableObject 单例（数据驱动）

```csharp
[CreateAssetMenu(fileName = "GameConfig", menuName = "Config/GameConfig")]
public class GameConfig : ScriptableObject
{
    public static GameConfig Instance
    {
        get
        {
            if (_instance == null)
            {
                _instance = Resources.Load<GameConfig>("GameConfig");
                #if UNITY_EDITOR
                if (_instance == null)
                {
                    // 编辑器模式下自动创建，方便开发
                    var path = "Assets/Resources/GameConfig.asset";
                    _instance = UnityEditor.AssetDatabase.LoadAssetAtPath<GameConfig>(path);
                }
                #endif
            }
            return _instance;
        }
    }
    static GameConfig _instance;

    public float masterVolume = 1f;
    public string serverUrl;
}
```

**优点**：数据可在 Inspector 编辑；不依赖场景；设计师友好。
**缺点**：不能存 MonoBehaviour 引用（重启后丢失）；运行时修改会持久化到编辑器（打包后不会）。

#### 各方案对比

| 维度 | 基础单例 | 泛型基类 | ScriptableObject |
|------|---------|---------|-------------------|
| 代码量 | 少 | 中等（一次编写） | 中等 |
| 跨场景存活 | 需手动 DontDestroyOnLoad | 可内置 | 天然跨场景 |
| Inspector 可编辑 | ✅（Inspector 字段） | ✅ | ✅✅（独立资源文件） |
| 生命周期安全 | 中 | 高 | 高 |
| 适用场景 | 快速原型 | 大型项目核心系统 | 配置/全局数据 |

#### 退出/重置陷阱

```csharp
// ❌ 危险：应用退出时 Instance 仍可被访问，导致创建已销毁的对象
void OnApplicationQuit() { _isQuitting = true; }

// 在其他系统的 Update 中可能触发：
void Update()
{
    // 如果 _isQuitting 没检查，这里会创建一个新 GameObject
    GameManager.Instance.DoSomething();
}
```

### ⚡ 实战经验

- **避免 `GameObject.Find`**：用 `FindFirstObjectByType<T>`（Unity 2023+）替代过时的 `FindObjectByType`，性能更好；但仍应缓存结果
- **多场景加载冲突**：Additive 场景加载时，两个场景各有一个单例 → 用 `DontDestroyOnLoad` + 重复检查兜底
- **执行顺序依赖**：如果 A.Awake 依赖 B.Instance，在 Project Settings → Script Execution Order 中调整，或在 `Start` 而非 `Awake` 中获取引用
- **测试友好性**：单例使得单元测试困难（全局状态难以隔离），项目大了考虑用依赖注入框架（如 VContainer、Extenject）

### 🔗 相关问题

- ScriptableObject 和 MonoBehaviour 在数据管理上各有什么优劣？
- 如果不用单例，大型项目如何管理全局服务？（提示：依赖注入、服务定位器模式）
- `DontDestroyOnLoad` 的对象在场景切换时有哪些注意事项？
