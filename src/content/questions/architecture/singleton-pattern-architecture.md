---
title: "单例模式在游戏开发中该怎么用？有哪些陷阱和替代方案？"
category: "architecture"
level: 2
tags: ["单例模式", "设计模式", "架构设计", "全局状态", "解耦"]
related: ["architecture/module-decoupling-bus-signal", "architecture/dependency-injection-lifecycle", "architecture/solid-principles-game"]
hint: "单例不是「方便」的代名词，而是「全局唯一状态 + 隐式依赖」。先用对，再考虑替代。"
---

## 参考答案

### ✅ 核心要点

1. **本质是全局唯一 + 隐式依赖**：单例保证一个实例，但代价是任何代码都能直接访问它，形成隐式耦合、依赖关系不透明
2. **合理场景：全局基础设施**：配置管理、资源管理、音频、网络、日志等「真·全局唯一」的基础设施适合单例；业务逻辑（玩家、背包、战斗）不应做成单例
3. **Unity 中常见三种写法**：`MonoBehaviour` 单例（挂场景）、`ScriptableObject` 单例（数据驱动）、纯 C# 静态单例——各有取舍
4. **滥用导致测试地狱**：单例是全局可变状态，单元测试难以隔离，并发下还可能引发竞态
5. **替代方案**：依赖注入（DI）、事件总线、服务定位器（Service Locator）——把「谁能访问谁」从隐式改为显式

### 📖 深度展开

**Unity 中 `MonoBehaviour` 单例的标准写法：**

```csharp
public class AudioManager : MonoBehaviour {
    public static AudioManager Instance { get; private set; }

    void Awake() {
        if (Instance != null && Instance != this) {
            Destroy(gameObject);   // 防重复：切场景若没销毁会造出第二个
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);   // 跨场景常驻
    }

    void OnDestroy() {
        if (Instance == this) Instance = null;  // 防悬空引用
    }
}

// 业务侧：AudioManager.Instance.Play("hit");
```

三个最容易踩的坑：① **重复实例**（场景里手拖了两个 → 重复 Awake 抢占 `Instance`）；② **生命周期竞态**（`Instance` 在 Awake 设，但别人在它之前访问 → null）；③ **切换场景未 `DontDestroyOnLoad`** → 单例随场景销毁，引用变 null。

**纯 C# 静态单例（不继承 MonoBehaviour）：**

```csharp
public sealed class ConfigManager {
    public static ConfigManager Instance { get; } = new ConfigManager();
    private ConfigManager() { }   // 私有构造，禁止外部 new
    // 优点：不依赖 Unity 生命周期、可任意时机访问
    // 缺点：拿不到 MonoBehaviour 的 Update/Awake，无法用协程
}
```

**单例泛滥的典型反模式：**

```
PlayerManager.Instance（玩家）
InventoryManager.Instance（背包）
CombatManager.Instance（战斗）
ShopManager.Instance（商店）
QuestManager.Instance（任务）
... 十几个 Manager 全是单例
```

后果：任意两个 Manager 可以互相 `Instance.XXX()` 调用 → **依赖关系变成一张没人画得清的网**。改一个 Manager 不知道影响了谁；写单元测试时必须把所有单例都初始化；新人接手根本理不清谁依赖谁。

**替代方案对比：**

| 方案 | 思路 | 优点 | 缺点 / 适用 |
|------|------|------|-------------|
| **单例** | 全局唯一，直接访问 | 简单直接 | 隐式耦合、难测试 |
| **依赖注入（DI）** | 谁需要谁就在构造时传进来 | 依赖显式、易测试、易替换 | 需要框架/约定，初期成本高 |
| **事件总线 / 信号** | 不直接持有，靠发消息解耦 | 完全解耦、可一对多 | 流程不直观、调试难追 |
| **Service Locator** | 一个注册中心，按需查找 | 比单例松、可替换 | 仍是「全局查找」式依赖 |

**DI 思路（显式依赖）：**

```csharp
// 不再用 ShopManager.Instance.Buy(item)
// 而是把依赖在构造时传入
public class ShopController {
    private readonly IInventory _inventory;   // 接口，可替换/可 Mock
    private readonly ICurrency _currency;
    public ShopController(IInventory inv, ICurrency cur) {
        _inventory = inv; _currency = cur;
    }
}
// 依赖关系一目了然；测试时传 Mock 进去即可
```

**经验法则（什么时候用单例）：**
- ✅ 全局唯一且**无状态或状态简单**的基础设施：`ResourceManager`、`AudioManager`、`Logger`、`Config`
- ❌ **有复杂业务逻辑、会被多人/多场景持有**的对象：玩家、关卡、战斗系统——这些该由上层显式持有和传递

### ⚡ 实战经验

- **单例数量是架构健康度的指标**：项目里单例越多、互相耦合越深，技术债越重。定期审视，能下沉到 DI/事件总线的就下沉
- **`Instance` 访问前判空**：尤其在场景切换、初始化竞态时，`Instance` 可能为 null。关键路径加判空 + 日志，比直接 NRE 崩溃好排查
- **测试性是反单例的最强理由**：只要写过单例依赖的单元测试，就会深刻理解「全局可变状态」有多难 Mock。新项目从一开始就用 DI，能省掉后期重构地狱
- **别用「单例 + 里边塞一堆静态数据」代替配置表**：把静态数据放进 `ScriptableObject` 或配置文件，而不是静态单例字段——前者能在编辑器里改、能热更，后者改一行就要重新编译

### 🔗 相关问题

- 依赖注入（DI）在游戏开发中如何落地？相比单例具体好在哪？
- 事件总线/信号机制如何替代 Manager 之间的直接调用？
- `MonoBehaviour` 单例在多个场景叠加加载时如何避免重复实例？
