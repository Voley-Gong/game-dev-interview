---
title: "MVC、MVP、MVVM 在游戏中如何适配？为什么照搬 Web/移动端架构常常翻车？"
category: "architecture"
level: 3
tags: ["MVC", "MVP", "MVVM", "UI 架构", "数据绑定", "解耦", "架构设计"]
related: ["architecture/dependency-injection-lifecycle", "architecture/event-driven-vs-data-driven", "architecture/layered-clean-architecture-game"]
hint: "Web 的 MVC 假设是'请求-响应'，而游戏是每帧 60 次轮询驱动 + 事件驱动混合。照搬会导致 Presenter 膨胀或绑定风暴——关键在于区分 UI 层（用 MVP/MVVM）和玩法层（用组件化/ECS），别用同一套模式套全部。"
---

## 参考答案

### ✅ 核心要点

1. **三者本质都是"关注点分离 + 单向依赖"**：Model（数据与规则）与 View（表现层）必须解耦，区别只在中间层（Controller/Presenter/ViewModel）如何协调，以及 View 与 Model 能否直接通信。游戏里这套思路主要用在 **UI 层**，而非玩法核心逻辑。
2. **MVC = Controller 驱动，View 可直接观察 Model**：传统 MVC 中 View 注册到 Model，数据变化时 Model 通知 View 刷新。问题：游戏 View 常和引擎深度耦合（Unity 的 MonoBehaviour、渲染管线），直接观察 Model 会让表现层反向依赖领域逻辑，难测试。
3. **MVP = Presenter 居中调度，View 纯被动**：Presenter 持有 View 接口和 Model，所有输入经 Presenter 转发，View 只暴露 `SetTitle/ShowHp` 等方法被动刷新。**游戏 UI 面板最常用 MVP**——View 是纯接口，方便脱离引擎做单元测试。
4. **MVVM = 双向数据绑定，ViewModel 不认识 View**：ViewModel 暴露可观察属性，View 通过绑定框架自动同步。Unity UI Toolkit（UXML/USS）、UniRx + Zenject 是常见落地方案。适合**数据密集、表单多**的界面（背包、装备、商城），但绑定过多会拖垮每帧开销。
5. **分层适配原则：UI 用 MVP/MVVM，玩法用组件化/ECS**：不要试图用 MVC 统管整个游戏。UI 是"请求-刷新"模型，天然契合 MVP/MVVM；而战斗、移动等玩法是"每帧 tick"模型，更适合组件化或 ECS，强行套 MVC 会让 Controller 变成上帝对象。

### 📖 深度展开

**三种模式的通信方向对比：**

```
MVC（View 直接观察 Model）：
  Input → Controller → Model ──notify──→ View
                      └──────────────────→ View 可直接读 Model
  问题：View 反向依赖 Model，引擎耦合难测试

MVP（Presenter 居中，View 纯被动接口）：
  Input → Presenter → Model
            ↓ 调用 View 接口
           View（IPanelView）  ← View 不认识 Model
  优势：View 是纯接口，可在编辑器外单测

MVVM（双向绑定，ViewModel 不知道 View 存在）：
  Input → ViewModel → 更新可观察属性
            ↑ 绑定框架自动同步 ↓
           View ←──── 绑定 ──── ViewModel
  优势：ViewModel 与 View 彻底解耦，一对多绑定
  代价：绑定数量多时每帧同步开销大
```

**MVP 在游戏 UI 面板中的落地（C# + 接口）：**

```csharp
// View 接口——脱离引擎也能 mock 测试
public interface IPlayerInfoView {
    void SetHp(int cur, int max);
    void SetMp(int cur, int max);
    void ShowLevelUp();
}

// Model——纯数据与规则，不引用任何 View
public class PlayerModel {
    public int Hp, MaxHp, Mp, MaxMp, Level;
    public event Action OnChanged;
    public void TakeDamage(int dmg) {
        Hp = Math.Max(0, Hp - dmg);
        OnChanged?.Invoke();
    }
}

// Presenter——持有 View 接口 + Model，监听 Model 变化刷新 View
public class PlayerInfoPresenter {
    private readonly IPlayerInfoView _view;
    private readonly PlayerModel _model;

    public PlayerInfoPresenter(IPlayerInfoView view, PlayerModel model) {
        _view = view;
        _model = model;
        _model.OnChanged += Refresh;
        Refresh();  // 初始刷新
    }
    private void Refresh() {
        _view.SetHp(_model.Hp, _model.MaxHp);
        _view.SetMp(_model.Mp, _model.MaxMp);
    }
    public void OnLevelUpButton() {  // View 把按钮事件转发给 Presenter
        _model.Level++;
        _view.ShowLevelUp();
    }
}

// 具体实现绑定到 Unity MonoBehaviour
public class PlayerInfoPanel : MonoBehaviour, IPlayerInfoView {
    [SerializeField] Slider _hpBar, _mpBar;
    public void SetHp(int cur, int max) => _hpBar.value = (float)cur / max;
    public void SetMp(int cur, int max) => _mpBar.value = (float)cur / max;
    public void ShowLevelUp() => /* 播特效 */;
}
```

**MVVM 的数据绑定（UniRx 响应式示例）：**

```csharp
// ViewModel——只有可观察属性，不知道 View
public class InventoryViewModel {
    public ReactiveProperty<int> Gold { get; } = new(0);
    public ReactiveCollection<Item> Items { get; } = new();
    public void BuyItem(Item it) { Gold.Value -= it.Price; Items.Add(it); }
}

// View——ObserveSubscribe 自动同步，ViewModel 无需感知 View
public class InventoryView : MonoBehaviour {
    public InventoryViewModel VM;
    [SerializeField] TMP_Text _goldText;
    void Start() {
        VM.Gold.Subscribe(g => _goldText.text = g.ToString()).AddTo(this);
        VM.Items.ObserveAdd().Subscribe(e => SpawnItemUI(e.Value)).AddTo(this);
    }
}
```

**三种模式在游戏中的适用场景对比：**

| 维度 | MVC | MVP | MVVM |
|------|-----|-----|------|
| View↔Model 通信 | View 直接观察 | 经 Presenter 中转 | 经绑定框架自动同步 |
| View 可测试性 | 差（耦合 Model） | ✅ 好（纯接口） | ✅ 好（不认识 View） |
| 样板代码量 | 少 | 中（手动刷新） | 多（绑定声明） |
| 每帧开销 | 低 | 低（事件触发） | 高（绑定同步） |
| 适用游戏场景 | 简单 HUD | 复杂面板（背包/任务） | 表单密集（装备/商城） |
| 引擎适配难度 | 低 | 中 | 高（需绑定框架） |

### ⚡ 实战经验

- **别用 MVC 套整个游戏，Controller 必然膨胀成上帝对象**：把"移动、战斗、背包、UI"全塞进一个 GameController，几千行后无法维护。正确做法：UI 层用 MVP/MVVM（请求-刷新模型），玩法层用组件化或 ECS（每帧 tick 模型），用事件总线/信号在两层间通信，而不是用一个大 Controller 串起来。
- **MVVM 的绑定是性能黑洞**：一个背包面板 50 个格子 × 每个格子 5 个绑定属性 = 250 个监听，每帧同步一次在低端机上肉眼可见掉帧。对策：列表型 UI 用虚拟化 + 只绑定可见项；只在数据真正变化时才触发绑定（脏标记），而非每帧轮询。竞品游戏常因绑定风暴在背包界面卡顿。
- **MVP 的 Presenter 之间不要互相直接引用**：A 面板的 Presenter 直接 `new BPresenter()` 会形成网状依赖，换皮/重排时牵一发动全身。用事件总线或 DI 容器（Zenject/VContainer）解耦，Presenter 只依赖接口和事件，由容器负责组装和生命周期。
- **View 实现可以脱引擎测试是 MVP 最大红利**：把 `IPlayerInfoView` 抽成纯接口后，Presenter 的逻辑（血量计算、升级判定）可以完全在无 Unity 的单元测试里跑，CI 不依赖引擎。很多团队忽视这点，把逻辑写在 MonoBehaviour 里导致测试只能手动进 Play Mode，回归成本极高。

### 🔗 相关问题

1. 游戏中 Model 层的事件通知，用 C# event/Action 还是独立的事件总线（EventBus/信号）？各自的解耦程度和性能差异如何？
2. Unity 的 ScriptableObject 常被当作 MVVM 的 Model，这种静态数据架构和运行时可变 Model 如何协调？只读配置 vs 运行时状态怎么分层？
3. 大型 MMO 的 UI 系统动辄上百个面板，如何管理 Presenter/ViewModel 的生命周期、内存泄漏和打开栈？
