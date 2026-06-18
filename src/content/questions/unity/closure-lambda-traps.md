---
title: "C# 闭包（Closure）在 Unity 中有哪些性能陷阱？lambda 捕获变量发生了什么？"
category: "unity"
level: 2
tags: ["C#", "闭包", "lambda", "GC", "性能优化"]
related: ["unity/gc-performance", "unity/delegate-event-performance"]
hint: "lambda 捕获的局部变量真的在栈上吗？foreach 循环里的闭包为什么结果不对？"
---

## 参考答案

### ✅ 核心要点

1. **闭包本质**：lambda/匿名方法捕获外部变量时，编译器会生成一个隐藏类（display class），将捕获的变量作为该类的字段
2. **堆分配**：每次创建闭包实例都会在堆上分配（GC Garbage），这是 lambda 性能问题的根源
3. **捕获陷阱**：foreach 中捕获循环变量（C# 5.0 前）、捕获 `this` 导致意外延长生命周期
4. **Update 中的隐患**：在热路径（Update/LateUpdate）中使用 lambda 会导致每帧 GC 分配
5. **优化手段**：避免热路径闭包、用显式方法替代、缓存委托、使用 `System.Action` 缓存

### 📖 深度展开

#### 闭包的编译器魔法

看一段最常见的代码：

```csharp
// 你写的代码
void Start()
{
    int hp = 100;
    button.onClick.AddListener(() => Debug.Log($"HP: {hp}"));
}
```

编译器实际生成的代码类似：

```csharp
// 编译器生成的隐藏类（Display Class）
class <>c__DisplayClass1
{
    public int hp;           // 捕获的变量变成字段
    public <>c__DisplayClass1 this_ref; // 如果捕获了 this

    public void <Start>b__0()
    {
        Debug.Log($"HP: {hp}");
    }
}

void Start()
{
    // 每次执行都在堆上 new 一个对象
    var closure = new <>c__DisplayClass1();
    closure.hp = 100;
    button.onClick.AddListener(new Action(closure.<Start>b__0));
}
```

**关键结论：捕获的局部变量从栈"提升"到了堆上。**

#### 捕获分类与分配分析

| 场景 | 是否分配 GC | 原因 |
|------|------------|------|
| `() => DoSomething()` 无捕获 | ❌ 不分配 | 编译器缓存为静态委托 |
| `(x) => x * 2` 纯参数 | ❌ 不分配 | 静态方法，无捕获 |
| `() => Debug.Log(hp)` 捕获局部变量 | ✅ 分配 | 生成 display class 实例 |
| `() => transform.position = pos` 捕获 this | ✅ 分配 | 生成 display class 捕获 this |
| `list.Find(x => x.active)` 扩展方法 | ✅ 分配 | 捕获了 this 或参数 |

#### 经典陷阱：foreach 循环变量捕获

```csharp
// C# 5.0 之前（Unity 旧版 Mono）的经典 Bug
var actions = new List<Action>();
foreach (var i in new[] { 1, 2, 3 })
{
    actions.Add(() => Debug.Log(i));
}
// C# 5.0+：输出 1, 2, 3（每次迭代重新创建 i）
// C# 5.0 前：输出 3, 3, 3（所有 lambda 共享同一个 i）
```

Unity 使用的 C# 版本：
- **Unity 2021+ (C# 9.0)**：foreach 变量每次迭代独立，不存在此问题
- **旧版 Unity (C# 4.x)**：经典闭包陷阱，所有 lambda 共享同一变量

#### Update 热路径中的隐形杀手

```csharp
// ❌ 每帧分配！每帧创建闭包 + 委托
void Update()
{
    // 这个 lambda 捕获了 this，每帧 new 一个对象
    SomeSystem.RegisterCallback(data => ProcessData(data));
}

// ✅ 缓存委托，零分配
private System.Action<Data> _cachedCallback;

void Awake()
{
    _cachedCallback = ProcessData;
}

void Update()
{
    SomeSystem.RegisterCallback(_cachedCallback);
}
```

#### LINQ 的隐藏 GC

```csharp
// ❌ 每次 LINQ 操作都会分配迭代器和委托
void Update()
{
    var active = enemies.Where(e => e.isActive).ToList(); // 至少 3 次 GC 分配
}

// ✅ 手动遍历，零分配
void Update()
{
    for (int i = 0; i < enemies.Count; i++)
    {
        if (enemies[i].isActive)
        {
            // 处理
        }
    }
}
```

### ⚡ 实战经验

1. **Profiler 验证法**：打开 Unity Profiler → 搜索 "GC.Alloc"，在热路径中看到持续分配基本就是闭包或 LINQ 在作怪。一帧哪怕只分配 40B，在 60FPS 下每秒就是 2.4KB GC 压力
2. **按钮回调缓存**：UI 按钮的 `onClick.AddListener` 在 `Awake`/`Start` 中注册一次即可，绝不要在 Update 中反复注册——闭包捕获 + 委托创建双重分配
3. **`System.Action` 字段缓存模式**：对于需要在多处复用的回调，在类初始化时缓存为字段，这是 Unity 移动端项目中最常用的零 GC 回调模式
4. **`==` 比较的坑**：闭包捕获 `this` 后，如果在闭包内做 `null` 检查（如被销毁的 GameObject），用 `this == null` 会触发 Unity 重载的 `==` 操作符，应改用 `ReferenceEquals` 或 `this != null && !this.Equals(null)` 的安全模式

### 🔗 相关问题

- [Unity 中委托和事件系统有哪些性能注意事项？](unity/delegate-event-performance)
- [如何检测和消除 Unity 中的 GC 内存分配？](unity/gc-performance)
- ValueTask 和 Task 在 Unity 中如何选择以减少 GC 分配？
