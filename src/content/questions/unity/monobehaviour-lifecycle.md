---
title: "Unity 的 MonoBehaviour 生命周期是怎样的？"
category: "unity"
level: 1
tags: ["引擎基础", "Unity核心"]
hint: "从 Awake 到 OnDestroy，每个阶段做什么？顺序如何影响脚本设计？"
---

## 参考答案

### ✅ 核心要点

**完整生命周期顺序：**

```
Awake → OnEnable → Start → (FixedUpdate → Update → LateUpdate) × N
→ OnDisable → OnDestroy
```

| 方法 | 调用时机 | 用途 |
|------|----------|------|
| `Awake()` | 实例化后立即 | 初始化自身，获取组件引用 |
| `OnEnable()` | 对象激活时 | 注册事件、开启协程 |
| `Start()` | 第一帧 Update 前 | 依赖其他组件的初始化 |
| `FixedUpdate()` | 固定时间间隔 | 物理计算 |
| `Update()` | 每帧 | 游戏逻辑 |
| `LateUpdate()` | 每帧（在所有 Update 后） | 相机跟随、UI 更新 |
| `OnDisable()` | 对象禁用时 | 取消事件、停止协程 |
| `OnDestroy()` | 对象销毁时 | 清理资源 |

### 📖 深度展开

**关键注意点：**

1. **Awake vs Start**
   - `Awake` 在对象实例化时立即调用（即使未激活）
   - `Start` 在第一次激活时才调用
   - 跨脚本依赖放在 Start，自身初始化放 Awake

2. **脚本执行顺序**
   - 默认执行顺序不确定
   - 可通过 `[DefaultExecutionOrder(n)]` 或 Project Settings 控制
   - 尽量通过事件解耦而非依赖顺序

3. **OnEnable / OnDisable 配对**
   - 对象池回收时触发 OnDisable 而非 OnDestroy
   - 必须确保注册和注销配对

```csharp
public class Player : MonoBehaviour
{
    private Rigidbody _rb;
    
    void Awake() {
        // 自身初始化：获取组件引用
        _rb = GetComponent<Rigidbody>();
    }
    
    void Start() {
        // 此时其他对象已 Awake，可安全访问
        GameManager.Instance.RegisterPlayer(this);
    }
    
    void OnEnable() {
        EventManager.OnDamage += HandleDamage;
    }
    
    void OnDisable() {
        EventManager.OnDamage -= HandleDamage;
    }
}
```

### ⚡ 实战经验

- **对象池场景**：回收时 OnDisable 被调用，重新激活时 OnEnable 被调用，但 Start 只在第一次执行
- **空回调开销**：Unity 通过反射调用生命周期方法，空的 Update 也有开销，建议删除空的生命周期方法
- **协程生命周期**：协程在 MonoBehaviour 销毁/禁用时自动停止
