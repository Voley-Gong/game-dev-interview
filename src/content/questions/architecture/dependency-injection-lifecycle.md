---
title: "游戏开发中如何做依赖注入（DI）与模块生命周期管理？"
category: "architecture"
level: 3
tags: ["依赖注入", "DI", "生命周期管理", "模块解耦", "IoC", "架构设计"]
related: ["architecture/solid-principles-game", "architecture/game-framework-comparison", "architecture/event-driven-vs-data-driven"]
hint: "DI 不是'用个框架'，而是控制反转——谁负责 new 对象、谁负责销毁、销毁顺序对不对，这些才是核心。"
---

## 参考答案

### ✅ 核心要点

1. **依赖注入的本质是控制反转（IoC）**：对象不再自己 `new` 它依赖的服务，而是由外部容器注入。好处是解耦——A 模块不认识 B 的具体实现，只认接口，方便替换、测试和热更。
2. **三种注入方式**：构造函数注入（最推荐，依赖不可变、启动即可用）、属性/字段注入（灵活但依赖可能为 null，存在时序陷阱）、服务定位器 ServiceLocator（对象主动去拿，看似方便实则隐藏了依赖关系，不推荐作为主方案）。
3. **生命周期范围是关键**：游戏对象分单例（Singleton，全程存活，如配置/网络）、场景级（Scene-scoped，切场景销毁，如该场景的 UI Manager）、临时（Transient，用完即弃，如一次性特效）。混用范围是内存泄漏和空引用的根源。
4. **初始化顺序≠注册顺序**：模块注册顺序和初始化（Init）顺序是两回事。网络模块依赖配置模块，必须等配置加载完才能 Init。成熟框架用依赖图拓扑排序，或显式声明 `[DependsOn]`。
5. **销毁顺序必须逆序**：先销毁依赖方再销毁被依赖方（先关 UI 再关资源系统再关网络），否则 UI 析构时访问已释放的资源管理器 → 崩溃。这是最容易踩的生命周期坑。

### 📖 深度展开

**手动 new vs DI 容器 vs ServiceLocator 对比：**

```csharp
// ❌ 硬编码依赖——A 认识 B 的具体实现，无法替换/测试
class BattleSystem {
    private readonly MySQLDatabase _db = new();   // 换成 SQLite 要改源码
}

// ⚠️ ServiceLocator——隐藏依赖，A 表面上无构造参数，实则偷偷去拿
class BattleSystem {
    public void Save() {
        var db = ServiceLocator.Get<IDatabase>(); // 依赖被藏起来了
        db.Save(this);
    }
}

// ✅ 构造函数注入——依赖显式、可替换、可 mock 测试
class BattleSystem {
    private readonly IDatabase _db;
    public BattleSystem(IDatabase db) { _db = db; } // 谁注入都行
}
```

**轻量级 DI 容器实现（游戏常用）：**

```csharp
public interface ILifecycle {
    void OnInit();      // 容器启动后调用，可安全访问其他已注入的服务
    void OnDispose();   // 容器销毁时逆序调用
}

public enum Lifetime { Singleton, Scoped, Transient }

public class DIContainer {
    // 注册表：接口 → (工厂方法, 生命周期)
    private readonly Dictionary<Type, (Func<object> factory, Lifetime life)> _registry = new();
    private readonly List<ILifecycle> _singletons = new(); // 记录初始化/销毁顺序

    public void Register<TInterface, TImpl>(Lifetime life = Lifetime.Singleton)
        where TImpl : TInterface, new() {
        _registry[typeof(TInterface)] = (() => new TImpl(), life);
    }

    public T Resolve<T>() {
        var (factory, life) = _registry[typeof(T)];
        var instance = factory();
        if (instance is ILifecycle lc && life == Lifetime.Singleton)
            _singletons.Add(lc); // 加入生命周期管理列表
        return (T)instance;
    }

    public void InitAll()  => _singletons.ForEach(s => s.OnInit());
    public void DisposeAll() {
        for (int i = _singletons.Count - 1; i >= 0; i--) // 逆序销毁！
            _singletons[i].OnDispose();
    }
}
```

**游戏模块的生命周期时序：**

```
启动阶段（按依赖拓扑序初始化）
  ┌──────────────────────────────────────────────┐
  │ 1. ConfigService    .OnInit()  读配置表        │  ← 无依赖，最先
  │ 2. NetworkService   .OnInit()  连接服务器      │  ← 依赖 Config
  │ 3. ResourceService  .OnInit()  初始化资源管理   │  ← 依赖 Config
  │ 4. UIService        .OnInit()  创建 UI 根节点   │  ← 依赖 Resource
  │ 5. BattleService    .OnInit()  注册战斗系统     │  ← 依赖 Network+Resource+UI
  └──────────────────────────────────────────────┘

关闭阶段（必须逆序销毁）
  5. BattleService.OnDispose()  停止战斗逻辑、保存存档
  4. UIService    .OnDispose()  关闭所有 UI 面板
  3. ResourceService.OnDispose() 卸载资源引用计数
  2. NetworkService.OnDispose()  断开连接、发送登出包
  1. ConfigService .OnDispose()  释放配置内存
```

**三种依赖管理方式对比：**

| 维度 | 手动 new | ServiceLocator | DI 容器（构造注入） |
|------|----------|----------------|---------------------|
| 依赖是否显式 | 否 | 隐藏 | ✅ 显式 |
| 可替换性 | 差（改源码） | 中 | 好 |
| 可测试性 | 差 | 中 | ✅ mock 注入 |
| 启动开销 | 零 | 零 | 有（反射/注册） |
| 适合规模 | 单文件脚本 | 小型项目 | 中大型项目 |
| 热更友好度 | 差 | 中 | ✅ 按接口注入热更实现 |

**Unity Extenject / VContainer 等框架的差异：**

- **Extenject（Zenject）**：功能全（子容器、约定绑定、编辑器注入），反射多、启动慢，适合大型项目，但过度使用 `[Inject]` 属性注入会变面条代码。
- **VContainer**：基于 Source Generator 编译期生成代码，零反射、启动快，是 Unity 2022+ 项目的现代首选。比 Extenject 轻 10 倍。
- **手写轻量容器**：小型项目完全可自写 200 行容器，避免框架黑盒。核心就是「字典 + 工厂 + 生命周期列表」。

### ⚡ 实战经验

- **属性注入的 null 陷阱**：用 `[Inject]` 标记字段注入时，如果在容器 `InitAll()` 之前就访问该字段（如 Awake 里直接用），拿到的是 null。统一约定：所有初始化逻辑放 `OnInit()`，禁止在构造/Awake 里访问被注入的依赖。
- **单例泛滥」是反模式**：什么都注册成 Singleton，结果切场景时该销毁的没销毁（场景级 UI 被当成单例存活），内存涨到 OOM。务必区分 Singleton（真全局）和 Scoped（场景/关卡级），UI 系统绝大多数是 Scoped。
- **循环依赖直接报错别绕过**：A 依赖 B、B 又依赖 A 时，DI 容器会死循环或报错。正确解法是引入事件/接口打破环（A 不直接调 B，而是发事件让 B 监听），而不是用懒加载（Lazy）掩盖——懒加载只会把崩溃推迟到运行时更难查。
- **销毁顺序逆序，但异步销毁要特殊处理**：NetworkService 断开是异步的（要等服务器确认登出），不能在 `OnDispose` 里同步等。方案：引入 `OnDisposeAsync()` 链式 await，或用标志位标记「正在关闭」让上层逻辑早退。

### 🔗 相关问题

1. 热更新场景下，DI 容器如何注入热更 DLL 里的实现类？（提示：按接口注册，热更后重新 Bind）
2. Extenject 的子容器（SubContainer）在分关卡/分玩法隔离时怎么用？
3. 如何对游戏模块做单元测试？DI 在其中扮演什么角色？
