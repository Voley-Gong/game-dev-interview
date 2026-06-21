---
title: "MVC / MVP / MVVM 架构模式在游戏 UI 开发中如何选择与适配？"
category: "architecture"
level: 3
tags: ["MVC", "MVP", "MVVM", "UI架构", "数据绑定", "架构设计"]
related: ["architecture/ui-framework", "architecture/event-driven-vs-data-driven", "architecture/solid-principles-game"]
hint: "不要纠结哪个模式'最对'，而是看数据流向、View 与逻辑的耦合度，以及团队对数据绑定的接受程度。"
---

## 参考答案

### ✅ 核心要点

1. **三者本质都是「关注点分离」**：把数据（Model）、展示（View）、交互逻辑（Controller/Presenter/ViewModel）拆开，区别在于三者谁持有谁、数据怎么流动。
2. **MVC——View 直接监听 Model**：Controller 只负责改 Model，Model 变了主动通知 View 更新。问题是 View 和 Model 耦合，小型游戏够用但中型项目容易失控（一个 View 引用十几个 Model 字段）。
3. **MVP——Presenter 做中间人**：View 只暴露接口（IView），Presenter 调用 View 接口刷新、监听 View 事件回写 Model。View 和 Model 彻底不见面，可测试性最好，但接口会爆炸（复杂 HUD 动辄 30+ 个 setter）。
4. **MVVM——双向数据绑定**：ViewModel 持有可观察属性（Observable/ReactiveProperty），View 通过绑定自动刷新，无需手写 setter。最省代码，但调试链路长（一个属性变了不知道是谁触发的），且绑定框架本身有性能开销。
5. **游戏里常见折中：MVP 打底 + 局部 MVVM**：核心战斗 HUD、背包用 MVP 保证可控；设置面板、商店等表单类 UI 用 MVVM 的数据绑定省掉模板代码。纯 MVC 仅用于极简的菜单场景。

### 📖 深度展开

**三种模式的数据流向对比：**

```
MVC：Controller 改 Model，Model 通知 View
  User → Controller → Model ──(notify)──→ View
  问题：View 直接依赖 Model，耦合双向

MVP：Presenter 操纵一切，View 和 Model 互不可见
  User → View ──(event)──→ Presenter → Model
                             Presenter ──(IView.setter)──→ View
  优点：可对 Presenter 单测（mock IView）

MVVM：ViewModel 暴露可观察状态，View 自动绑定
  User → View ──(command)──→ ViewModel → Model
  ViewModel ←──(Observable)──→ View（自动刷新）
  优点：View 近乎零模板代码
```

**游戏 UI 实例：背包面板的 MVP 实现**

```csharp
// Model —— 纯数据，可被存档系统序列化
public class InventoryModel {
    public ReactiveList<ItemSlot> Slots { get; } = new();
    public int Gold { get; private set; }
    public void AddItem(int itemId, int count) { /* 改数据 */ }
}

// IView —— View 必须实现的接口，Presenter 只认接口
public interface IInventoryView {
    void RefreshSlots(IReadOnlyList<ItemSlot> slots);
    void RefreshGold(int gold);
    void PlayAddAnimation(int slotIndex);
    event Action<int, int> OnUseItem; // slotIndex, count
}

// Presenter —— 持有 Model 和 View 引用，双向协调
public class InventoryPresenter {
    private readonly InventoryModel _model;
    private readonly IInventoryView _view;

    public InventoryPresenter(InventoryModel model, IInventoryView view) {
        _model = model;
        _view = view;
        _view.OnUseItem += HandleUseItem;
        _model.Slots.OnChanged += () => _view.RefreshSlots(_model.Slots);
    }

    private void HandleUseItem(int slotIndex, int count) {
        _model.UseItem(slotIndex, count);
        _view.RefreshGold(_model.Gold);  // Presenter 主动推数据
    }
}
```

**MVVM 版本（借助数据绑定框架）：**

```csharp
// ViewModel —— 只暴露可观察属性，不持有 View
public class InventoryViewModel {
    public ReactiveProperty<int> Gold { get; } = new(0);
    public ReactiveCollection<ItemSlotVM> Slots { get; } = new();

    public void UseItem(int slotIndex) {
        var slot = Slots[slotIndex];
        slot.Count.Value -= 1;
        if (slot.Count.Value <= 0) Slots.RemoveAt(slotIndex);
        Gold.Value += slot.SellPrice; // View 自动刷新，无需手动调用
    }
}
// View 层只需声明绑定：GoldText.Bind(vm.Gold); SlotList.Bind(vm.Slots);
```

**三种模式在游戏场景下的对比：**

| 维度 | MVC | MVP | MVVM |
|------|-----|-----|------|
| View-Model 耦合 | 高（直接引用） | 无（隔 IView） | 无（绑定解耦） |
| 模板代码量 | 少 | 多（手写 setter） | 少（绑定自动） |
| 可测试性 | 差 | 好（mock View） | 好（测 VM 即可） |
| 调试难度 | 低 | 中 | 高（绑定链路长） |
| 绑定性能开销 | 无 | 无 | 有（每帧轮询/事件） |
| 适用 UI | 简单菜单 | 战斗 HUD/背包 | 商店/设置/任务 |
| 典型实现 | 原生 Unity UGUI | GameFramework UI | UniRx/UIToolkit UXML |

**游戏 UI 特有的适配要点：**

- **View 是一次性资源**：游戏 UI 频繁打开关闭，Presenter 必须在 View 销毁时解绑事件（`OnDestroy` 里 `-=`），否则 View 被对象池回收后还会收到 Model 通知 → 空引用崩溃。
- **避免在绑定回调里做重逻辑**：MVVM 的属性变更可能在一帧内触发几十次（如列表刷新），绑定回调里别做网络请求或资源加载，用节流（throttle）或延迟到帧末统一处理。
- **战斗 HUD 慎用 MVVM**：血条/技能 CD 这类高频更新 UI，数据绑定的反射/事件分发开销会累积。用 MVP 直接每帧 `Update()` 赋值反而更快。

### ⚡ 实战经验

- **Presenter 泄漏是头号 bug**：View 关闭后忘记解绑 Model 的事件，Model 继续通知已被回收的 View，表现为「打开关闭几次背包后偶现空引用」。务必在 `OnClose` 里做 `model.OnChanged -= handler`，或用弱引用事件。
- **MVVM 的双向绑定容易成环**：ViewModel 改了属性 A 触发 View 刷新，View 的刷新回调又改了属性 B 回写 Model，B 变了再触发 A……形成无限刷新循环。加一个 `isUpdating` 守卫标志打断回环。
- **别让 Presenter 直接 new View**：UI 预制体加载是异步的，Presenter 持有 View 引用前必须等资源加载完成。正确做法是「先加载 View → 回调里 new Presenter 并注入 View」，而不是 Presenter 构造时同步去拿 View。
- **列表类 UI 的绑定是性能黑洞**：一个 50 格的背包每次增删都全量刷新绑定，在低端机会掉帧。改为增量更新（只刷新变化的格子），或用虚拟列表（VirtualList）只渲染可见的 8-10 格。

### 🔗 相关问题

1. 游戏中 Presenter/ViewModel 膨胀到上千行后该怎么拆分？（提示：按功能域拆 Sub-Presenter，或引入 UseCase/Command 层）
2. Unity 的 UI Toolkit（UXML/USS）相比 UGUI 更适合哪种模式？
3. 如何在不引入第三方框架（UniRx 等）的情况下实现轻量级数据绑定？
