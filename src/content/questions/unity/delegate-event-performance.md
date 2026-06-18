---
title: "Unity 中 Delegate、Action、Func、UnityEvent 有什么区别？使用时有哪些性能陷阱？"
category: "unity"
level: 2
tags: ["C#", "Delegate", "Event", "性能优化", "GC"]
related: ["unity/gc-performance", "unity/monobehaviour-lifecycle"]
hint: "它们都能实现回调/观察者模式，但底层实现、GC 表现和适用场景差异很大。"
---

## 参考答案

### ✅ 核心要点

1. **Delegate 是 C# 的函数指针类型**，`Action` 和 `Func` 是框架内置的泛型委托，本质都是 `MulticastDelegate`
2. **event 关键字** 在委托基础上封装了 `add/remove` 访问器，外部只能 `+=` / `-=`，不能直接触发或赋空
3. **UnityEvent** 是 Unity 引擎层的可序列化事件系统，可在 Inspector 中绑定回调，但每次调用有反射开销
4. **GC 陷阱**：闭包捕获局部变量会导致编译器生成隐藏类实例（堆分配）；`+=` 匿名方法每次创建新委托对象
5. **选择原则**：高频回调用 `Action`/`Func` + 缓存委托；需要 Inspector 可配置用 `UnityEvent`；跨模块通信用事件总线（基于 Action）

### 📖 深度展开

#### 四种回调方式对比

```
调用链路对比（从快到慢）

直接方法调用      →  ~0ns     零开销
  ↓
Action / Func    →  ~5ns     一层间接调用
  ↓
event (+ Action) →  ~5ns     同上，封装层额外 add/remove
  ↓
UnityEvent       →  ~500ns   反射 + InvocationList 遍历
  ↓
SendMessage      →  ~5000ns  字符串反射查找，极度不推荐
```

#### 各方式详解与代码

**1. Action / Func（纯 C# 泛型委托）**

```csharp
// Action 无返回值，Func 有返回值
// 高频场景：缓存委托实例避免GC
public class EventBus
{
    // ❌ 错误写法：每次 += 产生临时委托对象
    // event.OnDamaged += (amount) => TakeDamage(amount);
    
    // ✅ 正确写法：缓存委托引用
    private static readonly Action<float> OnHealthChangedHandler = OnHealthChanged;
    
    public static event Action<float> OnHealthChanged;
    
    private static void OnHealthChanged(float delta)
    {
        // 处理血量变化
    }
    
    public void Register()
    {
        OnHealthChanged += OnHealthChangedHandler; // 零分配
    }
    
    public void Unregister()
    {
        OnHealthChanged -= OnHealthChangedHandler; // 必须同一个实例才能移除
    }
}
```

**2. event 关键字 vs 普通 Delegate**

```csharp
public class EnemySpawner : MonoBehaviour
{
    // 普通委托：外部可以随意赋值或触发
    public Action<Enemy> OnEnemySpawned; // ⚠️ 外部可以 OnEnemySpawned = null 清空所有监听
    
    // event 修饰：外部只能 += 和 -=，不能赋空或直接触发
    public event Action<Enemy> OnEnemyDied; // ✅ 安全的观察者模式
    
    private void SpawnEnemy()
    {
        var enemy = CreateEnemy();
        OnEnemySpawned?.Invoke(enemy); // 自己触发
        OnEnemyDied?.Invoke(enemy);
    }
}

// 外部使用
public class UIManager : MonoBehaviour
{
    void OnEnable()
    {
        var spawner = FindFirstObjectByType<EnemySpawner>();
        spawner.OnEnemyDied += HandleEnemyDied; // ✅ 可以注册
        // spawner.OnEnemyDied = null;           // ❌ 编译错误！event不允许外部赋值
        // spawner.OnEnemyDied(enemy);            // ❌ 编译错误！event不允许外部触发
    }
    
    void OnDisable()
    {
        var spawner = FindFirstObjectByType<EnemySpawner>();
        spawner.OnEnemyDied -= HandleEnemyDied; // ✅ 注销
    }
}
```

**3. UnityEvent（可序列化事件）**

```csharp
using UnityEngine.Events;

public class Trap : MonoBehaviour
{
    [System.Serializable]
    public class TrapEvent : UnityEvent<GameObject> { }
    
    // 在Inspector中可视化绑定回调（拖拽方法引用）
    public TrapEvent OnTrapTriggered = new TrapEvent();
    
    private void OnTriggerEnter(Collider other)
    {
        OnTrapTriggered?.Invoke(other.gameObject);
    }
}
```

```
UnityEvent 的 Inspector 可视化：
┌──────────────────────────────────────┐
│  On Trap Triggered ()                │
│   ├─ Object: PlayerHealth            │
│   │   Method: TakeDamage(int)        │
│   ├─ Object: AudioManager            │
│   │   Method: PlaySound(string)      │
│   └─ Object: QuestManager            │
│       Method: CompleteQuest(string)  │
└──────────────────────────────────────┘
非程序员（策划/美术）可以直接在编辑器里配置事件回调
```

#### GC 陷阱深度分析

```csharp
public class GC陷阱示例 : MonoBehaviour
{
    private Action<int> callback;
    
    void Trap1_闭包捕获()
    {
        int localValue = 42;
        
        // ❌ 闭包捕获 localValue → 编译器生成隐藏类
        // 每帧调用 = 每帧 new 一个隐藏类实例 = GC 垃圾
        SomeSystem.OnUpdate += (delta) => {
            ProcessValue(localValue + delta);
        };
    }
    
    void Trap2_匿名方法分配()
    {
        // ❌ 每次 += 都创建新的 Action 实例
        for (int i = 0; i < 10; i++)
        {
            callback += (x) => Debug.Log(x);
        }
        // 10 次堆分配，且后续无法 -= 移除这些匿名方法
        
        // ✅ 正确：用命名方法
        callback += HandleCallback;
    }
    
    void Trap3_装箱分配()
    {
        // ❌ Action<object> + 传值类型 → 装箱
        Action<object> action = (o) => Process(o);
        action(42); // int → object 装箱分配
    }
    
    void HandleCallback(int x) { }
    void Process(object o) { }
}
```

```
闭包捕获的编译器展开：

源码：
    int hp = 100;
    Action heal = () => hp += 10;

编译器实际生成：
    class HiddenClosure {           ← 堆分配！
        public int hp;
        public void Method() { hp += 10; }
    }
    var closure = new HiddenClosure { hp = 100 };  ← new 对象
    closure.hp = 100;
    Action heal = closure.Method;   ← 新委托实例
```

#### 事件总线模式（实战推荐）

```csharp
// 基于 Action 的高性能事件总线
public static class GameEvents
{
    private static readonly Dictionary<string, Action> _events = new();
    private static readonly Action _cachedEmpty = () => { };

    public static void Subscribe(string key, Action handler)
    {
        if (_events.TryGetValue(key, out var existing))
            _events[key] = existing + handler; // 委托合并
        else
            _events[key] = handler;
    }

    public static void Unsubscribe(string key, Action handler)
    {
        if (_events.TryGetValue(key, out var existing))
        {
            var newDelegate = (Action)Delegate.RemoveAll(existing, handler);
            if (newDelegate == null)
                _events.Remove(key);
            else
                _events[key] = newDelegate;
        }
    }

    public static void Publish(string key)
    {
        if (_events.TryGetValue(key, out var handler))
            handler?.Invoke();
    }
}

// 使用：零字符串分配的改进版可用 readonly struct Key 替代 string
```

### ⚡ 实战经验

- **高频回调永远用 Action/Func**：帧内触发的回调（如属性变化通知、帧更新事件），UnityEvent 的反射开销在 Profiler 中清晰可见，单帧可能贡献 1-3ms
- **`-=` 必须用同一个委托实例**：`+= () => {}` 创建的匿名方法永远无法 `-=`，导致内存泄漏。注册时缓存委托引用，注销时使用同一引用
- **UnityEvent 的 PersistentCalls vs NonPersistentCalls**：Inspector 中绑定的是 PersistentCalls（序列化、无GC闭包问题）；代码 `AddListener` 添加的是 NonPersistentCalls。两者独立执行，调试时要注意区分
- **闭包捕获是性能杀手**：在每帧执行的 Update 循环中用 lambda 捕获局部变量，Profiler 中会看到持续的 GC.Allocate，累积导致帧卡顿。重构方案：用成员变量替代局部变量，消除闭包

### 🔗 相关问题

- C# 的 `delegate` 底层是怎么实现的？`MulticastDelegate` 的 InvocationList 是什么结构？
- 如何实现一个类型安全且零分配的事件系统？
- C# 11+ 的 static abstract 接口成员能否替代部分委托场景？
