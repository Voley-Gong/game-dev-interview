---
title: "Unity多人游戏的状态同步方案有哪些？如何选择？"
category: "unity"
level: 3
tags: ["网络同步", "Netcode", "状态同步", "帧同步"]
related: ["unity/dots-ecs", "unity/mobile-optimization"]
hint: "从权威服务器到帧同步，从Netcode for GameObjects到Mirror——多人游戏的底层骨架"
---

## 参考答案

### ✅ 核心要点

1. **两大同步范式**：状态同步（State Sync）和 帧同步（Lockstep / Deterministic）
2. **权威服务器（Authoritative Server）**：服务器持有真实状态，客户端预测+回滚
3. **Netcode for GameObjects（NGO）**：Unity 官方多人方案，C/S 架构，基于 GameObject
4. **Mirror / Photon**：社区成熟方案，各有侧重（Mirror 开源免费、Photon 全托管服务）
5. **插值与预测**：核心体验优化——收到不连续的网络包后让画面"看起来平滑"

### 📖 深度展开

#### 状态同步 vs 帧同步

| 维度 | 状态同步 | 帧同步 |
|------|---------|--------|
| 同步内容 | 物体的位置、速度、HP 等状态值 | 玩家输入操作（Move(x, y)） |
| 计算位置 | 服务器算物理和逻辑 | 每个客户端各自算 |
| 带宽消耗 | 较高（同步的数据量大） | 极低（只传输入） |
| 反作弊 | 天然防作弊（服务器权威） | 需要额外校验机制 |
| 断线重连 | 容易（重传快照即可） | 困难（需要回放所有帧） |
| 确定性要求 | 不需要 | **严格需要**（浮点数都不能不同） |
| 典型游戏 | MMO、FPS、MOBA | RTS、格斗、棋类 |

#### 网络架构图

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Client A   │ ←──→   │              │   ←──→   │   Client B   │
│  (预测+插值)  │  状态   │    Server    │   状态   │  (预测+插值)  │
│              │  同步   │  (权威状态)   │   同步   │              │
└──────────────┘         └──────────────┘         └──────────────┘
                              │
                              │ 游戏逻辑
                              ▼
                         ┌─────────┐
                         │ Physics │
                         │ + Game  │
                         │  Logic  │
                         └─────────┘

          Client → Server: "我要移动到 (10, 0, 5)"
          Server → All Clients: "对象X的新位置是 (10, 0, 5)，速度 (0,0,0)"
```

#### Unity 网络方案对比

| 方案 | 类型 | 特点 | 适用场景 |
|------|------|------|---------|
| **Netcode for GameObjects** | 官方 C/S | 集成 Transport、NetworkTransform | 中小型 C/S 游戏 |
| **Mirror** | 开源 C/S | 类似 UNet API，社区活跃 | 独立游戏、原型 |
| **Photon Fusion** | 商业 C/S | 全托管服务器、状态同步+预测 | FPS、MOBA |
| **Unity Transport** | 底层协议 | 灵活的 UDP/WebSocket 层 | 自定义网络栈 |
| **自研方案** | 灵活 | Protobuf + WebSocket/UDP | 大型 MMO |

#### 关键同步组件（以 NGO 为例）

```csharp
// 1. 网络对象标识
[RequireComponent(typeof(NetworkObject))]
public class PlayerController : NetworkBehaviour
{
    // 2. 网络变量——服务器修改后自动同步到所有客户端
    [NetworkVariable]
    public NetworkVariable<int> Health = new(100);

    [NetworkVariable]
    public NetworkVariable<Vector3> Position = new();

    // 3. ServerRpc——客户端调用，服务器执行
    [ServerRpc]
    public void MoveServerRpc(Vector3 direction, ServerRpcParams rpcParams = default)
    {
        // 服务器端权威移动
        Vector3 newPos = transform.position + direction * speed * Time.deltaTime;
        GetComponent<Rigidbody>().MovePosition(newPos);
        Position.Value = newPos; // 自动同步
    }

    // 4. ClientRpc——服务器调用，所有客户端执行
    [ClientRpc]
    public void PlayHitEffectClientRpc()
    {
        GetComponent<ParticleSystem>().Play();
    }

    void Update()
    {
        if (!IsOwner) return;

        if (Input.GetKeyDown(KeyCode.Space))
        {
            MoveServerRpc(Vector3.forward);
        }
    }
}
```

#### 客户端预测与平滑插值

```csharp
// 客户端预测：本地先跑，服务器确认后校正
public class ClientPrediction : NetworkBehaviour
{
    private Vector3 _serverPosition;
    private Vector3 _predictedPosition;
    private float _lerpSpeed = 10f;

    public override void OnNetworkSpawn()
    {
        if (IsOwner)
        {
            Position.OnValueChanged += (oldVal, newVal) =>
            {
                _serverPosition = newVal;
                // 误差过大直接吸附
                if (Vector3.Distance(_predictedPosition, newVal) > 2f)
                    _predictedPosition = newVal;
            };
        }
    }

    void Update()
    {
        if (!IsOwner) return;

        // 本地预测移动
        _predictedPosition += GetInputDirection() * speed * Time.deltaTime;

        // 向服务器校正方向插值（减少预测偏差的视觉跳变）
        _predictedPosition = Vector3.Lerp(
            _predictedPosition,
            _serverPosition,
            _lerpSpeed * Time.deltaTime * 0.3f
        );

        transform.position = _predictedPosition;
    }

    private Vector3 GetInputDirection()
    {
        var dir = Vector3.zero;
        if (Input.GetKey(KeyCode.W)) dir += Vector3.forward;
        if (Input.GetKey(KeyCode.S)) dir += Vector3.back;
        if (Input.GetKey(KeyCode.A)) dir += Vector3.left;
        if (Input.GetKey(KeyCode.D)) dir += Vector3.right;
        return dir.normalized;
    }
}
```

#### 帧同步核心要点（参考）

```
帧同步循环：
1. 收集所有玩家本帧输入
2. 等到所有输入到达（或超时用空输入填充）
3. 把 (frameId, inputs) 发给所有客户端
4. 所有客户端用相同逻辑跑一帧
5. 确定性保证：使用定点数（FixedPoint），禁用 Mathf、Time.deltaTime 等
```

### ⚡ 实战经验

- **先选范式再选框架**：RTS/格斗优先帧同步，其余绝大多数游戏用状态同步更简单
- **NetworkTransform 插值模式**：默认的插值有 1~2 帧延迟，射击游戏可能需要自定义预测逻辑
- **网络对象的生命周期**：玩家断线后对象是销毁还是保留？NGO 的 `NetworkObject` 有 `DestroyWithScene` 和手动 `Despawn` 两种策略，需提前规划
- **带宽 profiling**：用 NGO 的 NetworkInspector 观察每秒消息量，`NetworkVariable` 频繁更新的数据用 `INetworkSerializable` 自定义序列化压缩

### 🔗 相关问题

- 帧同步如何保证浮点数确定性？有哪些定点数库推荐？
- 如何实现大厅匹配（Matchmaking）系统？
- 网络延迟补偿（Lag Compensation）在 FPS 中怎么做？
