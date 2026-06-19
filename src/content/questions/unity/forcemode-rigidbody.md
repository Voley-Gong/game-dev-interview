---
title: "Unity Rigidbody 的四种 ForceMode 有什么区别？如何正确使用 Force、Impulse、VelocityChange、Acceleration？"
category: "unity"
level: 2
tags: ["物理引擎", "Rigidbody", "力学模拟"]
related: ["unity/charactercontroller-vs-rigidbody", "unity/physics-joints-articulation"]
hint: "ForceMode 决定了力如何施加到刚体上——是持续的力还是瞬间的冲量？是否考虑质量？"
---

## 参考答案

### ✅ 核心要点

1. **ForceMode.Force**：持续力（单位：牛顿），受质量和时间影响，适合推门、风力等持续作用
2. **ForceMode.Impulse**：瞬间冲量（单位：N·s），受质量影响但不受时间影响，适合爆炸、击退、跳跃
3. **ForceMode.Acceleration**：持续加速度（单位：m/s²），不受质量影响，适合重力、浮力等统一加速度
4. **ForceMode.VelocityChange**：直接改变速度（单位：m/s），忽略质量和时间，适合精确控制运动

### 📖 深度展开

#### 四种 ForceMode 对比

| ForceMode | 公式 | 是否受质量影响 | 是否受时间影响 | 物理单位 | 典型用途 |
|-----------|------|:-:|:-:|------|------|
| Force | `Δv = (F·Δt) / m` | ✅ | ✅ | Newton (N) | 持续推力、引力 |
| Impulse | `Δv = J / m` | ✅ | ❌ | N·s (kg·m/s) | 爆炸、跳跃、击退 |
| Acceleration | `Δv = a·Δt` | ❌ | ✅ | m/s² | 重力、风力场 |
| VelocityChange | `Δv = Δv` | ❌ | ❌ | m/s | 弹射板、传送带 |

#### 代码示例

```csharp
using UnityEngine;

[RequireComponent(typeof(Rigidbody))]
public class ForceModeDemo : MonoBehaviour
{
    private Rigidbody rb;

    private void Awake()
    {
        rb = GetComponent<Rigidbody>();
    }

    // 1. Force: 持续推力，模拟火箭推进
    // mass=2 的物体，施加 10N 力 1 秒 → Δv = 10*1/2 = 5 m/s
    private void FixedUpdate()
    {
        // 每帧持续施加力（FixedUpdate 中用 Force）
        rb.AddForce(Vector3.up * 10f, ForceMode.Force);
    }

    // 2. Impulse: 瞬间冲量，模拟跳跃
    // mass=2，施加 20 N·s → Δv = 20/2 = 10 m/s（瞬间获得 10 m/s 向上速度）
    public void Jump()
    {
        rb.AddForce(Vector3.up * 20f, ForceMode.Impulse);
    }

    // 3. Acceleration: 持续加速度，模拟风场
    // 不受质量影响，所有物体获得相同加速度变化
    public void ApplyWind()
    {
        // 每秒增加 5 m/s 的水平速度，不论质量
        rb.AddForce(Vector3.right * 5f, ForceMode.Acceleration);
    }

    // 4. VelocityChange: 直接改速度，模拟弹射
    // 不受质量影响，直接叠加速度增量
    public void Launch(Vector3 direction, float speed)
    {
        rb.AddForce(direction * speed, ForceMode.VelocityChange);
    }

    // 爆炸力：向外推开范围内所有刚体
    public void Explosion(Vector3 center, float radius, float power)
    {
        Collider[] hits = Physics.OverlapSphere(center, radius);
        foreach (var hit in hits)
        {
            var targetRb = hit.GetComponent<Rigidbody>();
            if (targetRb == null) continue;

            Vector3 dir = (hit.transform.position - center).normalized;
            // 爆炸用 Impulse，距离越远冲量越小
            float falloff = 1f - (Vector3.Distance(center, hit.transform.position) / radius);
            targetRb.AddForce(dir * power * falloff, ForceMode.Impulse);
        }
    }
}
```

#### ForceMode 选择的决策流程

```
需要施加力？
├── 需要持续作用？
│   ├── 不同质量物体应有不同效果？ → Force
│   └── 不论质量，效果一致？       → Acceleration
└── 需要瞬间作用？
    ├── 不同质量物体应有不同效果？ → Impulse
    └── 不论质量，效果一致？       → VelocityChange
```

#### 移动端物理性能提示

```
ForceMode 对性能的影响（每帧调用 1000 次 AddForce）：
├── Force           : 基准 1.0x（标准物理积分）
├── Impulse         : ~0.95x（少一次时间乘法）
├── Acceleration    : ~0.9x（跳过质量除法）
└── VelocityChange  : ~0.85x（最快，直接改速度）

实际差异很小，但如果每帧数千次调用，VelocityChange 略有优势
```

### ⚡ 实战经验

1. **跳跃统一用 Impulse，不要用 Force**：新手常见错误是在 `Update` 里每帧 `AddForce(up * jumpForce, ForceMode.Force)`，这会导致跳跃高度受帧率和按键时长影响。正确做法是在跳跃触发瞬间调用一次 `ForceMode.Impulse`
2. **网络游戏中优先用 VelocityChange**：服务端同步速度位移时，客户端收到目标速度后直接 `VelocityChange` 修正，避免了不同设备物理积分差异导致的累计误差
3. **AddForce 必须在 FixedUpdate 中持续调用**：`Force` 和 `Acceleration` 模式依赖 `Time.fixedDeltaTime` 做积分，在 `Update` 中调用会因帧率波动导致力的大小不一致
4. **Rigidbody.mass 的误区**：mass 并非真实物理质量，只是物理引擎中的相对权重。两个 mass=1 和 mass=10 的物体碰撞，不意味着 10 的物体"更重"，碰撞响应由质量比决定。重力加速度对所有质量相同（g≈9.8），但 air resistance（drag）效果会因 mass 不同而不同

### 🔗 相关问题

- Rigidbody 的 Collision Detection（Discrete / Continuous / Continuous Dynamic）各模式有什么区别？
- 如何实现角色击退效果？Impulse 和 VelocityChange 哪个更适合？
- Rigidbody.interpolation 和 Rigidbody.collisionDetection 有什么关系？如何避免穿墙？
