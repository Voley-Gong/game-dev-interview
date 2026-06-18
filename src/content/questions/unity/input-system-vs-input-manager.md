---
title: "Unity 新版 Input System 与旧版 Input Manager 有什么区别？项目中该选哪个？"
category: "unity"
level: 2
tags: ["输入系统", "Input System", "事件驱动", "多平台", "引擎架构"]
related: ["unity/monobehaviour-lifecycle", "unity/delegate-event-performance"]
hint: "从轮询 vs 事件驱动、多设备支持、Action Map 绑定机制三方面理解新旧输入系统的本质差异。"
---

## 参考答案

### ✅ 核心要点

1. **旧版 Input Manager 是轮询式 API**（`Input.GetKeyDown()` 每帧主动查询），新版 Input System 是**事件驱动**（回调通知），两者架构范式完全不同
2. **新版 Input System 原生支持多设备**（键盘、手柄、触屏、摇杆、VR 控制器），通过 Input Action Asset 统一抽象，切换设备零代码改动
3. **Action Map 是新版的核心概念**：将输入动作（Jump/Move/Shoot）与物理按键解耦，策划可以在不改代码的情况下调整按键绑定
4. **新版支持 Player Input 组件**，自动处理设备分配、多本地玩家（Local Multiplayer）、控制方案切换（如手柄断线自动切键盘）
5. **旧版并非被弃用**：两者可以通过 `InputSystem.RunEarlyUpdate()` 共存，中小项目用旧版完全够用，大型/多平台项目强烈推荐新版

### 📖 深度展开

#### 架构对比

```
旧版 Input Manager（轮询式）
┌─────────────────────────────────┐
│  每帧 Update()                  │
│    ↓                            │
│  if (Input.GetKeyDown(KeyCode.Space))  │
│      Jump();                    │
│    ↓                            │
│  问题：按键硬编码、多设备需手写  │
│       设备判断逻辑               │
└─────────────────────────────────┘

新版 Input System（事件驱动）
┌─────────────────────────────────┐
│  Input Device (Keyboard/Gamepad) │
│    ↓ 原生事件                    │
│  Input System Event Loop         │
│    ↓ 分发                        │
│  Input Action Asset (.inputactions) │
│    ├── Move [WASD / LeftStick]  │
│    ├── Jump [Space / SouthButton]│
│    └── Shoot [Mouse0 / RT]      │
│    ↓ 回调                        │
│  PlayerInput.OnJump(CallbackContext) │
└─────────────────────────────────┘
```

#### 核心差异对比表

| 维度 | 旧版 Input Manager | 新版 Input System |
|------|-------------------|-------------------|
| **API 风格** | 轮询（Polling） | 事件驱动（Event-driven） |
| **输入定义** | 代码中硬编码 KeyCode | Input Action Asset 配置文件 |
| **多设备** | 手动判断 `Input.GetJoystickNames()` | 原生抽象，自动切换 Control Scheme |
| **多本地玩家** | 需自行实现设备分配 | PlayerInput 组件自动处理 |
| **按键重绑定** | 需自建系统 | 内置 InputRebinding API |
| **VR/触屏** | 支持有限 | 原生支持 XR、Touchscreen |
| **调试工具** | 无 | Input Debugger 实时查看设备状态 |
| **性能** | 轮询有固定开销 | 事件驱动，无输入时零开销 |
| **学习成本** | 极低 | 中等 |

#### 新版 Input System 代码示例

**方式一：Player Input 组件（推荐快速上手）**

```csharp
using UnityEngine;
using UnityEngine.InputSystem;

// 需要挂载 PlayerInput 组件，并关联 .inputactions 资产
[RequireComponent(typeof(PlayerInput))]
public class PlayerController : MonoBehaviour
{
    private Vector2 _moveInput;
    private bool _isFiring;

    // 方法名与 Action Map 中的 action 名 + "On" 前缀对应
    // 必须用 public 或 [SerializeField]，PlayerInput 通过反射调用

    public void OnMove(InputValue value)
    {
        // Move 是 2D Vector Action（WASD 或摇杆）
        _moveInput = value.Get<Vector2>();
    }

    public void OnJump(InputValue value)
    {
        // Button Action，value.isPressed 区分按下/松开
        if (value.isPressed)
        {
            Jump();
        }
    }

    public void OnFire(InputValue value)
    {
        _isFiring = value.isPressed;
    }

    void Update()
    {
        if (_moveInput.sqrMagnitude > 0.01f)
        {
            transform.position += new Vector3(
                _moveInput.x, 0, _moveInput.y
            ) * (5f * Time.deltaTime);
        }

        if (_isFiring)
        {
            FireContinuous();
        }
    }

    private void Jump() => /* ... */ ;
    private void FireContinuous() => /* ... */;
}
```

**方式二：C# Generated Class（类型安全，推荐大型项目）**

```csharp
// ---------- 自动生成的代码（Input Action Asset → Generate C# Class）----------
public partial class @PlayerControls : IInputActionCollection
{
    public InputAction MoveAction { get; }
    public InputAction JumpAction { get; }
    public InputAction FireAction { get; }
    // ...
}

// ---------- 业务代码 ----------
public class PlayerController : MonoBehaviour
{
    private PlayerControls _controls;

    void Awake()
    {
        _controls = new PlayerControls();

        // 事件驱动：注册回调
        _controls.Gameplay.Jump.performed += OnJumpPerformed;
        _controls.Gameplay.Jump.canceled += OnJumpCanceled;
        _controls.Gameplay.Fire.performed += OnFirePerformed;
    }

    void OnEnable()  => _controls.Gameplay.Enable();
    void OnDisable() => _controls.Gameplay.Disable();

    private void OnJumpPerformed(InputAction.CallbackContext ctx)
    {
        Jump();
    }

    private void OnFirePerformed(InputAction.CallbackContext ctx)
    {
        // 可以读取不同类型的值
        // ctx.ReadValue<float>()  → 按钮轴
        // ctx.ReadValue<Vector2>() → 2D 方向
        // ctx.interaction → 按住、双击、慢速点击等交互类型
        Debug.Log($"Fire triggered. Interaction: {ctx.interaction}");
    }

    void Update()
    {
        // 轮询式读取也支持（适合持续移动这类输入）
        Vector2 move = _controls.Gameplay.Move.ReadValue<Vector2>();
        transform.position += new Vector3(move.x, 0, move.y) * (5f * Time.deltaTime);
    }

    void OnDestroy()
    {
        _controls.Gameplay.Jump.performed -= OnJumpPerformed;
        _controls.Gameplay.Jump.canceled -= OnJumpCanceled;
        _controls.Gameplay.Fire.performed -= OnFirePerformed;
        _controls.Dispose();
    }
}
```

#### CallbackContext 生命周期

```
用户按键 → 三个阶段回调

         started            performed           canceled
           │                   │                   │
    ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐
    │ 开始交互     │     │ 完成交互     │     │ 交互取消     │
    │ (按键按下)   │     │ (达到阈值)   │     │ (松开/超时)  │
    └─────────────┘     └─────────────┘     └─────────────┘
                                              │
                                    cancelled │
                                    (Hold 交互超时等)

对于不同 Interaction：
- Tap（点击）: started → performed → canceled（快速完成）
- Hold（按住）: started → performed（持续按住后）→ canceled（松开）
- Slow Tap:  started →（等待判定时间）→ performed 或 canceled
```

#### 运行时按键重绑定

```csharp
public class RebindUI : MonoBehaviour
{
    [SerializeField] private InputActionReference jumpAction;

    public void StartRebind()
    {
        // 禁用当前 Action，进入监听模式
        jumpAction.action.Disable();

        var rebindOperation = jumpAction.action.PerformInteractiveRebinding()
            .WithControlsExcluding("Mouse")     // 排除鼠标
            .WithCancelBindingThrough("<Keyboard>/escape") // ESC 取消
            .OnMatchWaitForAnother(0.1f)        // 防误触
            .OnComplete(operation =>
            {
                jumpAction.action.Enable();
                operation.Dispose();

                // 保存重绑定结果
                jumpAction.action.SaveBindingOverridesAsJson();
                PlayerPrefs.SetString("rebinds", jumpAction.action.SaveBindingOverridesAsJson());
            })
            .Start();
    }

    void Start()
    {
        // 启动时加载保存的重绑定
        string rebindJson = PlayerPrefs.GetString("rebinds", "");
        if (!string.IsNullOrEmpty(rebindJson))
        {
            jumpAction.action.LoadBindingOverridesFromJson(rebindJson);
        }
    }
}
```

### ⚡ 实战经验

- **Active Mode 的 Input System 有自己的 Update 循环**：默认在 Dynamic Update 之前处理输入，如果游戏逻辑依赖特定帧序（如 Fixed Update 中的物理），需要配置 `InputSettings.updateMode` 为 `ProcessEventsInFixedUpdate`，但会引入 1 帧输入延迟
- **旧版和新版共存时注意**：如果 `Project Settings → Active Input Handling = Both`，两者都工作但旧版有额外开销；在 Update 中同时用旧版 `Input.GetKey()` 和新版回调处理同一个按键，会导致重复触发
- **多本地玩家（分屏/同屏）的实现要点**：PlayerInput 组件配合 PlayerInputManager 使用，自动处理设备分配（Join Behavior）和 Split Screen，但如果需要自定义规则（如「2P 必须用手柄」），需要监听 `PlayerInputManager.onPlayerJoined` 事件手动控制
- **手柄兼容性是最大坑点**：不同品牌手柄（Xbox / PS / Switch Pro）的按键映射不同，新版 Input System 内置了 Control Path 映射（如 `<Gamepad>/buttonSouth` 而非硬编码 A/✕/B），务必用抽象 Control Path 而非具体设备按钮名

### 🔗 相关问题

- 如何实现「按键不可用时不提示交互」的需求（如 QTE 系统中动态启用/禁用 Action）？
- 新版 Input System 的事件驱动和 Unity 的 `Input.GetButton` 轮询，在帧序上有什么细微差异？会导致输入丢失吗？
- VR 应用的输入处理与普通游戏有何不同？XR Controller 的输入如何映射到 Action？
