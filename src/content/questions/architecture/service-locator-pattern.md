---
title: "Service Locator 模式在游戏框架中如何应用？它与依赖注入（DI）有何区别？"
category: "architecture"
level: 3
tags: ["Service Locator", "设计模式", "依赖注入", "GameFramework", "ET框架", "架构设计"]
related: ["architecture/dependency-injection-lifecycle", "architecture/solid-principles-game", "architecture/module-decoupling-bus-signal"]
hint: "Service Locator 是一个全局服务注册表，需要时「主动拉取」依赖——和 DI 的「被动注入」恰好相反，两者的可测试性和耦合方向截然不同。"
---

## 参考答案

### ✅ 核心要点

1. **Service Locator 本质是全局服务注册表**：服务在启动时注册自身（`Register<ILogger>(new FileLogger())`），使用方在需要时通过 Locator 查找（`Locator.Get<ILogger>()`）。它把"谁来创建依赖"和"谁来使用依赖"解耦，但使用方和 Locator 本身是耦合的。
2. **与依赖注入（DI）的根本区别在依赖获取方向**：DI 是"推"模式——容器在构造时主动注入依赖（构造函数/属性/方法注入），类不知道容器的存在；Service Locator 是"拉"模式——类主动找 Locator 要依赖，类必须知道 Locator 的存在。
3. **Service Locator 的致命缺陷是隐藏依赖**：一个类的构造函数签名看不出它需要什么服务（因为 `Locator.Get<T>()` 散落在方法体内），编译期无法发现缺失的依赖，只能在运行时崩溃。DI 通过构造函数参数让依赖显式可见。
4. **在游戏框架中大量使用**：Unity GameFramework 的 `GameEntry.GetService<T>()`、ET 框架的 `Game.Scene.GetComponent<T>()` 本质都是 Service Locator 变体。原因是游戏对象生命周期复杂（场景切换、预制体实例化），DI 容器难以统一管理，Locator 的全局访问反而更方便。
5. **务实策略：两者混用**：框架基础设施（日志、配置、网络）用 Service Locator 全局访问；业务模块（战斗系统、背包系统）之间用 DI 或事件解耦。不要教条地只选一种。

### 📖 深度展开

**Service Locator vs Dependency Injection 的依赖方向：**

```
Dependency Injection（推模式 —— 容器主动注入）：
  ┌─────────┐  构造时注入   ┌──────────┐
  │ DI容器   │ ──────────► │ CombatSystem │
  │         │              │  (字段: ILogger) │
  └─────────┘              └──────────┘
  优点：CombatSystem 不知道容器存在，可 new 出来单测
  代价：所有依赖必须在构造链上传递

Service Locator（拉模式 —— 使用方主动查找）：
  ┌──────────────────┐    Get<T>()    ┌───────────┐
  │ ServiceLocator    │ ◄──────────── │ CombatSystem │
  │  ├ ILogger        │               │ (方法体内调:  │
  │  ├ IConfigService │               │  Locator    │
  │  └─ INetworkMgr   │               │   .Get<…>())│
  └──────────────────┘                └───────────┘
  优点：不用穿线传参，全局拿取方便
  代价：CombatSystem 耦合 Locator，依赖被隐藏
```

**Service Locator 核心实现：**

```csharp
// 服务定位器 —— 泛型注册表 + 生命周期管理
public static class ServiceLocator {
    private static readonly Dictionary<Type, object> _services = new();
    private static readonly Dictionary<Type, Func<object>> _lazyFactories = new();

    // 即时注册：实例已创建
    public static void Register<T>(T service) where T : class {
        var type = typeof(T);
        if (_services.ContainsKey(type)) {
            Debug.LogWarning($"[ServiceLocator] {type.Name} 已注册，将被覆盖");
        }
        _services[type] = service;
    }

    // 延迟注册：首次 Get 时才创建（节省启动内存）
    public static void RegisterLazy<T>(Func<T> factory) where T : class {
        _lazyFactories[typeof(T)] = factory;
    }

    public static T Get<T>() where T : class {
        var type = typeof(T);
        // 1. 先找已实例化的
        if (_services.TryGetValue(type, out var service))
            return (T)service;
        // 2. 再找延迟工厂
        if (_lazyFactories.TryGetValue(type, out var factory)) {
            var instance = (T)factory();
            _services[type] = instance;       // 缓存实例
            _lazyFactories.Remove(type);
            return instance;
        }
        // ⚠️ 这就是"隐藏依赖"的危险——编译期发现不了，运行时才炸
        throw new InvalidOperationException(
            $"[ServiceLocator] 未注册服务: {type.Name}。请检查初始化顺序。");
    }

    public static bool IsRegistered<T>() => _services.ContainsKey(typeof(T));

    // 场景切换时清理场景级服务，保留全局服务
    public static void Unregister<T>() => _services.Remove(typeof(T));
    public static void Clear() { _services.Clear(); _lazyFactories.Clear(); }
}

// 使用示例
public class GameBootstrapper : MonoBehaviour {
    void Awake() {
        // 注册全局服务
        ServiceLocator.Register<ILogger>(new FileLogger("game.log"));
        ServiceLocator.Register<IConfigService>(LoadConfigs());
        ServiceLocator.RegisterLazy<INetworkManager>(() => new NetworkManager()); // 按需创建
    }
}

// 业务代码中获取
public class CombatSystem {
    public void OnEntityDamaged(Entity e, float dmg) {
        ServiceLocator.Get<ILogger>().Log($"Entity {e.Id} took {dmg} damage");
        var config = ServiceLocator.Get<IConfigService>();
        if (dmg > config.GetFloat("max_damage_cap")) { /* 上报异常 */ }
    }
}
```

**Unity GameFramework 中的 Service Locator 实践：**

```csharp
// GameFramework 用 GetComponent 模式实现 Service Locator
// GameEntry 是全局访问点，每个模块是一个 Component
public static class GameEntry {
    public static readonly DataManager Data = new DataManager();
    public static readonly UIComponent UI = new UIComponent();
    public static readonly NetworkComponent Network = new NetworkComponent();
    public static readonly ResourceComponent Resource = new ResourceComponent();
}

// 使用：GameEntry.UI.OpenUI("BagPanel");
// 本质就是 ServiceLocator.Get<UIComponent>().OpenUI(...)
```

**Service Locator vs DI vs 单例 对比：**

| 维度 | 单例 | Service Locator | Dependency Injection |
|------|------|-----------------|---------------------|
| 依赖可见性 | 最差（全局静态） | 差（隐藏在方法体内） | ✅ 好（构造函数参数） |
| 可测试性 | 极差（难 Mock） | 差（需 Mock Locator） | ✅ 好（直接传 Mock） |
| 初始化顺序控制 | 无 | 有（注册顺序） | ✅ 有（容器拓扑排序） |
| 使用便利性 | ✅ 最简单 | ✅ 简单 | 中（需穿线传参） |
| 循环依赖处理 | 无法处理 | 运行时崩溃 | ✅ 编译期/启动期检测 |
| 游戏场景适配 | 适合无状态工具 | ✅ 适合框架级服务 | 适合业务模块间 |

### ⚡ 实战经验

- **初始化顺序 bug 是 Service Locator 的头号坑**：模块 A 在 `Awake` 里 `Get<IConfigService>()`，但 ConfigService 在另一个脚本的 `Awake` 里才注册——Unity 不保证脚本执行顺序，大概率 NRE。解法：统一在一个 Bootstrapper 里按序注册所有服务，业务模块延迟到 `Start` 或首次使用时才 Get。
- **别用 Service Locator 传递跨模块数据**：有些人把 `GameState`、`PlayerData` 塞进 Locator 当全局变量用——这不是 Service Locator 的用途，这是全局状态地狱。Locator 只该放无状态的服务接口（日志、配置、网络），不放可变业务数据。
- **单元测试时必须能替换 Locator 内的服务**：如果业务代码直接 `ServiceLocator.Get<T>()` 调静态方法，测试时无法注入 Mock。解法：让 ServiceLocator 实例化（非静态），通过接口注入到业务类中——这样就退化成了 DI 容器，但保留了注册的灵活性。
- **服务清理要分场景级和全局级**：进新场景时如果不清理场景级服务（如当前场景的EntityManager），会和旧场景的残留冲突。在 ServiceLocator 里加 `ClearSceneServices()` 方法，在场景卸载回调中调用，全局服务（日志/网络）保留。

### 🔗 相关问题

1. Service Locator 被批评为"反模式"（Anti-Pattern），核心原因是什么？什么场景下它的优势反而大于 DI？
2. ET 框架的 `Entity.GetComponent<T>()` 和传统 Service Locator 有何异同？它是如何避免隐藏依赖问题的？
3. 在一个 Unity 项目中，如何渐进式地从全局单例/Service Locator 迁移到 DI 容器（如 Zenject/VContainer）？迁移的优先级如何排定？
