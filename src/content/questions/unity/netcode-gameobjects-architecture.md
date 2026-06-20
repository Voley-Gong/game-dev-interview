---
title: "Unity Netcode for GameObjects (NGO) 的核心架构是怎样的？"
category: "unity"
level: 3
tags: ["网络", "Netcode", "NGO", "多人游戏", "RPC"]
related: ["unity/network-sync", "unity/monobehaviour-lifecycle"]
hint: "NetworkObject、NetworkBehaviour、RPC、NetworkTransform 之间的关系是什么？"
---

## 参考答案

### ✅ 核心要点

1. **NGO 是 Unity 官方的多人游戏网络框架**，基于 Server-Authoritative 架构，支持 Host / Server / Client 三种模式
2. **NetworkObject 是网络对象的基类**：挂载后该 GameObject 在客户端间同步存在性（Spawn / Despawn）
3. **NetworkBehaviour 是网络行为的基类**：继承自 MonoBehaviour，提供 RPC 调用、网络变量同步、网络生命周期回调
4. **通信三通道**：RPC（一次性事件）、NetworkVariable（持续状态同步）、NetworkTransform（位置/旋转/缩放插值同步）
5. **场景管理**：通过 `NetworkSceneManager` 管理客户端场景加载，支持 Synchronize 模式确保所有客户端场景一致

### 📖 深度展开

#### NGO 架构全景

```
┌─────────────────────────────────────────────────┐
│              NetworkManager (单例)                │
│  ┌─────────────┐  ┌──────────────┐              │
│  │ Transport    │  │ Prefab Handler│             │
│  │ (UnityTransport│ │ (NetworkPrefab)│            │
│  │  / 自定义)    │  │              │             │
│  └──────┬───────┘  └──────────────┘             │
│         │                                        │
│  ┌──────▼───────────────────────────────┐       │
│  │      MessageBus (消息总线)             │       │
│  │  ┌──────────┐ ┌───────────────────┐   │       │
│  │  │ RPC 系统  │ │ NetworkVariable   │   │       │
│  │  │ (Server/  │ │ (状态同步)         │   │       │
│  │  │ Client/  │ │                   │   │       │
│  │  │ Reliable) │ │                   │   │       │
│  │  └──────────┘ └───────────────────┘   │       │
│  └───────────────────────────────────────┘       │
│                                                   │
│  ┌─────────────┐  ┌──────────────────────┐      │
│  │ Network     │  │ NetworkSceneManager  │      │
│  │ Object Pool │  │ (场景同步)            │      │
│  └─────────────┘  └──────────────────────┘      │
└─────────────────────────────────────────────────┘
```

#### NetworkObject 与 NetworkBehaviour

```csharp
// NetworkObject：挂载在 prefab 上，使其成为"网络对象"
// 必须通过 NetworkManager.Spawn() 生成，不能直接 Instantiate
var obj = Instantiate(networkPrefab);
obj.GetComponent<NetworkObject>().Spawn(serverRpcParams: default);

// NetworkBehaviour：网络行为逻辑
public class PlayerNetworkController : NetworkBehaviour
{
    // 网络变量：自动同步到所有客户端（Server-Authoritative）
    public NetworkVariable<int> Health = new(
        value: 100,
        readPerm: NetworkVariableReadPermission.Everyone,
        writePerm: NetworkVariableWritePermission.Server
    );

    public NetworkVariable<Vector3> Position = new();

    public override void OnNetworkSpawn()
    {
        // 网络对象在该客户端生成时调用
        // 比 Awake/Start 更可靠的网络初始化时机
        if (IsOwner)
        {
            // 只有本地玩家执行输入逻辑
            SetupLocalPlayer();
        }
    }

    public override void OnNetworkDespawn()
    {
        // 网络对象销毁时调用
    }
}
```

#### 三种 RPC 类型

```csharp
public class CombatSystem : NetworkBehaviour
{
    // Server RPC：客户端 → 服务器（请求操作）
    [ServerRpc]
    public void RequestFireServerRpc(Vector3 direction, ServerRpcParams parms = default)
    {
        if (!IsServer) return;
        // 服务器验证并执行
        PerformHitScan(direction);
        // 服务器再广播给所有客户端
        PlayFireVfxClientRpc(direction);
    }

    // Client RPC：服务器 → 客户端（广播结果）
    [ClientRpc]
    private void PlayFireVfxClientRpc(Vector3 direction)
    {
        // 所有客户端播放开火特效
        Instantiate(muzzleFlashPrefab, direction, Quaternion.identity);
    }

    // RPC 参数可指定 delivery 策略
    [ClientRpc(Delivery = RpcDelivery.Unreliable)]
    private void SyncPositionClientRpc(Vector3 pos)
    {
        // 高频位置同步用 unreliable，丢包不重传
    }
}
```

#### NetworkVariable 同步机制

| 特性 | NetworkVariable | RPC |
|------|----------------|-----|
| 同步方式 | 状态（持续） | 事件（一次性） |
| 写权限 | 可配置（Server / Owner） | 发起方决定 |
| 晚加入同步 | ✅ 自动同步当前值 | ❌ 不补发历史 |
| 网络开销 | 低（仅变化时发送） | 每次调用都发送 |
| 适用场景 | 血量、分数、状态 | 开火、受击、聊天 |

#### NetworkTransform 插值同步

```csharp
// 挂载 NetworkTransform 组件实现位置自动同步
// 支持配置：同步轴、插值、外推
[RequireComponent(typeof(NetworkTransform))]
public class NetworkPlayer : NetworkBehaviour
{
    void Update()
    {
        if (!IsOwner) return;
        // 只有 Owner 移动，NetworkTransform 自动同步
        transform.position += GetInputVector() * speed * Time.deltaTime;
    }
}
```

### ⚡ 实战经验

1. **不要在 `Awake` / `Start` 中访问网络状态**：此时 NetworkObject 可能还没 Spawn，正确时机是 `OnNetworkSpawn` 回调；在 `Start` 里取 `IsOwner` 会得到 `false`
2. **Server-Authoritative 是默认安全模型**：客户端不能直接写 NetworkVariable，必须通过 ServerRPC 请求；如果偷懒用 `NetworkVariableWritePermission.Owner`，要自己防作弊
3. **对象池必须用 NetworkObjectPool**：直接 `Destroy` 网络对象会触发 Despawn 消息，频繁创建销毁会导致网络抖动；使用 NGO 内置的对象池或自建 `NetworkPoolManager`
4. **NetworkTransform 的插值配置很关键**：移动端 TickRate 低（20-30Hz），如果不开启插值会明显卡顿；但开启外推（Extrapolate）在高速移动时会导致预测偏差

### 🔗 相关问题

- NGO 与 Mirror、Photon Fusion 的选型区别是什么？
- 如何实现 NPC 的状态同步与 AI 逻辑分离？
- NGO 的 TickRate 如何影响网络性能？
