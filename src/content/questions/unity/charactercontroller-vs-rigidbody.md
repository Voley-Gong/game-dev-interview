---
title: "Unity CharacterController 与 Rigidbody 的区别与选型？"
category: "unity"
level: 2
tags: ["物理引擎", "角色控制", "碰撞检测", "移动"]
related: ["unity/physics-raycast", "unity/physics-joints-articulation"]
hint: "什么时候用 CharacterController，什么时候用 Rigidbody？两者在碰撞响应上有何本质区别？"
---

## 参考答案

### ✅ 核心要点

1. **CharacterController**：封装了碰撞检测但不受物理力影响，适合精确控制的角色移动
2. **Rigidbody**：完整的物理模拟，受重力/力/力矩驱动，适合需要真实物理交互的对象
3. **碰撞响应本质**：CharacterController 是"推回"机制；Rigidbody 是物理引擎解算
4. **性能差异**：CharacterController 开销远低于 Rigidbody（无需物理求解器参与）
5. **混合使用**：可以用 `OnControllerColliderHit` 处理 CharacterController 与 Rigidbody 的交互

### 📖 深度展开

#### 架构对比

```
CharacterController
  ├── 继承自 Collider（本质是一个特殊 CapsuleCollider）
  ├── 自带移动逻辑：Move() / SimpleMove()
  ├── 不受 Rigidbody 力影响（无物理反馈）
  ├── 碰撞检测：Sweep Test（扫描碰撞）
  └── 坡度/台阶/地面检测内置

Rigidbody + Collider
  ├── 受物理引擎（PhysX）完整模拟
  ├── 必须通过 AddForce / velocity 控制移动
  ├── 碰撞 → 物理求解器计算冲量 → 改变速度
  ├── 支持 Joint（铰链/弹簧）、质心、惯性
  └── 需要 FixedUpdate 控制
```

#### 代码对比

**CharacterController 方式：**

```csharp
[RequireComponent(typeof(CharacterController))]
public class PlatformerController : MonoBehaviour
{
    private CharacterController controller;
    private Vector3 velocity;
    public float moveSpeed = 6f;
    public float jumpHeight = 2f;
    public float gravity = -20f;
    public float turnSmoothTime = 0.1f;
    private float turnSmoothVelocity;

    void Start()
    {
        controller = GetComponent<CharacterController>();
    }

    void Update()
    {
        // 判断是否在地面
        bool grounded = controller.isGrounded;
        if (grounded && velocity.y < 0)
            velocity.y = -2f; // 保持贴地

        // 输入
        float horizontal = Input.GetAxisRaw("Horizontal");
        float vertical = Input.GetAxisRaw("Vertical");
        Vector3 direction = new Vector3(horizontal, 0f, vertical).normalized;

        if (direction.magnitude >= 0.1f)
        {
            // 平滑转向
            float targetAngle = Mathf.Atan2(direction.x, direction.z) * Mathf.Rad2Deg;
            float angle = Mathf.SmoothDampAngle(
                transform.eulerAngles.y, targetAngle, ref turnSmoothVelocity, turnSmoothTime);
            transform.rotation = Quaternion.Euler(0f, angle, 0f);

            // 移动
            Vector3 moveDir = Quaternion.Euler(0f, targetAngle, 0f) * Vector3.forward;
            controller.Move(moveDir.normalized * moveSpeed * Time.deltaTime);
        }

        // 跳跃
        if (Input.GetButtonDown("Jump") && grounded)
        {
            velocity.y = Mathf.Sqrt(jumpHeight * -2f * gravity);
        }

        // 重力
        velocity.y += gravity * Time.deltaTime;
        controller.Move(velocity * Time.deltaTime);
    }

    // 与 Rigidbody 的交互
    void OnControllerColliderHit(ControllerColliderHit hit)
    {
        Rigidbody body = hit.collider.attachedRigidbody;
        if (body == null || body.isKinematic) return;

        // 推动物体
        Vector3 pushDir = new Vector3(hit.moveDirection.x, 0, hit.moveDirection.z);
        body.velocity = pushDir * 3f;
    }
}
```

**Rigidbody 方式：**

```csharp
[RequireComponent(typeof(Rigidbody))]
public class PhysicsCharacterController : MonoBehaviour
{
    private Rigidbody rb;
    public float moveSpeed = 6f;
    public float jumpForce = 7f;
    public float groundCheckDistance = 0.2f;
    public LayerMask groundLayer;

    void Start()
    {
        rb = GetComponent<Rigidbody>();
        rb.freezeRotation = true; // 防止角色翻倒
        rb.interpolation = RigidbodyInterpolation.Interpolate; // 平滑显示
        rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic; // 防穿墙
    }

    void FixedUpdate()
    {
        bool grounded = IsGrounded();

        float horizontal = Input.GetAxisRaw("Horizontal");
        float vertical = Input.GetAxisRaw("Vertical");
        Vector3 direction = new Vector3(horizontal, 0f, vertical).normalized;

        if (direction.magnitude >= 0.1f)
        {
            // 通过速度直接控制（Kinematic 风格）
            Vector3 targetVelocity = direction * moveSpeed;
            Vector3 velocityChange = targetVelocity - new Vector3(rb.velocity.x, 0, rb.velocity.z);
            rb.AddForce(velocityChange, ForceMode.VelocityChange);

            // 转向
            Quaternion targetRot = Quaternion.LookRotation(direction);
            rb.MoveRotation(Quaternion.Slerp(transform.rotation, targetRot, 0.2f));
        }

        if (Input.GetButtonDown("Jump") && grounded)
        {
            rb.AddForce(Vector3.up * jumpForce, ForceMode.VelocityChange);
        }
    }

    bool IsGrounded()
    {
        // 球形检测比 Raycast 更稳定
        return Physics.CheckSphere(
            transform.position + Vector3.down * 1f,
            groundCheckDistance,
            groundLayer);
    }

    void OnDrawGizmosSelected()
    {
        Gizmos.color = Color.red;
        Gizmos.DrawWireSphere(
            transform.position + Vector3.down * 1f, groundCheckDistance);
    }
}
```

#### 选型决策表

| 场景 | 推荐 | 原因 |
|------|------|------|
| 动作游戏 / 平台跳跃 | CharacterController | 精确控制跳跃弧线，不会因碰撞翻倒 |
| FPS / TPS 射击 | CharacterController | 精确位移，避免被小障碍物弹飞 |
| 物理沙盒 / 布娃娃 | Rigidbody | 需要真实的物理碰撞和倒地效果 |
| 赛车 / 载具 | Rigidbody | 物理引擎处理惯性、漂移、碰撞变形 |
| NPC / 怪物 | CharacterController + NavMeshAgent | NavMeshAgent 内部用 CharacterController 逻辑 |
| 弹球 / 保龄球 | Rigidbody | 完全依赖物理模拟 |
| 塔防 / 策略 | Transform 直接移动 | 不需要物理参与 |

#### 常见陷阱：混合使用的坑

```csharp
// ❌ 错误：CharacterController 上挂 Rigidbody 会导致冲突
// 两个组件互相争夺移动控制权，产生抖动和穿墙

// ✅ 正确：如果角色是 CharacterController，环境物体是 Rigidbody
// 用 OnControllerColliderHit 推 Rigidbody 物体

// ✅ 正确：Rigidbody 角色 + Rigidbody 环境
// 物理引擎自动处理碰撞响应
```

#### 关键属性对比

| 属性 | CharacterController | Rigidbody |
|------|-------------------|-----------|
| Slope Limit | ✅ 内置坡度限制 | ❌ 需手动处理 |
| Step Offset | ✅ 内置台阶检测 | ❌ 需手动实现 |
| Skin Width | ✅ 碰撞精度调整 | ❌ 无此概念 |
| Center / Radius / Height | ✅ Capsule 参数 | 由 Collider 决定 |
| Mass / Drag | ❌ 无质量概念 | ✅ 物理属性完整 |
| Use Gravity | ❌ 需手动实现 | ✅ 自动受重力 |
| Is Kinematic | ❌ 不适用 | ✅ 可切换物理开关 |

### ⚡ 实战经验

1. **Stair Climbing（爬楼梯）**：CharacterController 的 `Step Offset` 只对小于该高度的台阶有效。大于 Step Offset 的台阶会被视为墙壁，楼梯建模时每个台阶高度建议 ≤ 0.3
2. **Rigidbody 穿墙问题**：高速移动必须设置 `CollisionDetectionMode = Continuous Dynamic`，否则单帧位移超过碰撞体厚度会穿墙。但 Continuous Dynamic 性能开销大，移动端慎用
3. **CharacterController 不触发 OnTrigger**：CharacterController 只触发 `OnControllerColliderHit`，不触发 `OnCollisionEnter` 和 `OnTriggerEnter`。需要触发器检测时额外挂 Collider 或用 Physics.CheckSphere
4. **网络同步选型**：多人游戏优先选 CharacterController，因为移动是确定性的（相同输入→相同结果），比 Rigidbody 的物理模拟更容易做状态同步

### 🔗 相关问题

- NavMeshAgent 和 CharacterController 如何协同工作？
- 如何实现可攀爬墙壁的自定义角色控制器？
