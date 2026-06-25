---
title: "网络实体的生命周期如何同步？实体创建、销毁与可见性的完整流程"
category: "network"
level: 3
tags: ["实体同步", "生命周期", "Spawn/Destroy", "AOI", "状态同步", "面试高频"]
related: ["network/snapshot-delta-sync", "network/aoi-algorithm", "network/property-replication-system"]
hint: "玩家走进视野，怪物从草丛跳出来——这些实体是何时被创建、何时被销毁的？客户端如何平滑处理实体的出现和消失？"
---

## 参考答案

### ✅ 核心要点

1. **实体同步三阶段**：Spawn（创建）→ Update（属性同步）→ Destroy（销毁），每个阶段都有独立的消息类型和可靠性要求
2. **Spawn 必须可靠**：如果创建消息丢了，后续的属性更新会引用不存在的实体 ID——所以 Spawn 走可靠通道，Destroy 同理
3. **AOI 驱动可见性**：不是所有实体都要同步给所有客户端。服务器的兴趣区域（AOI）系统决定每个客户端能看到哪些实体，进入视野才发 Spawn，离开视野发 Despawn
4. **属性更新可以不可靠**：实体创建后，每帧的位置/血量等属性同步走不可靠通道——丢了下一帧补上，不影响正确性
5. **客户端预测创建与延迟销毁**：为避免实体"闪烁"（快速进出视野导致频繁创建/销毁），客户端做 200ms 延迟销毁，服务器做 hysteresis（滞回区域）防止边界抖动

### 📖 深度展开

#### 实体同步消息体系

```
消息类型层级：

┌─────────────────────────────────────────────────────┐
│ 实体生命周期消息                                      │
├──────────────┬──────────────┬───────────────────────┤
│  Spawn        │  Update      │  Destroy              │
│  (可靠+有序)   │  (不可靠)     │  (可靠+有序)           │
├──────────────┼──────────────┼───────────────────────┤
│ - EntityId    │ - EntityId   │ - EntityId            │
│ - EntityType  │ - Property[] │ - Reason              │
│ - Position    │   (Delta)    │   (Killed/OutOfRange  │
│ - InitialState│              │    /Disconnected)     │
│ - Owner(可选) │              │                       │
└──────────────┴──────────────┴───────────────────────┘
```

#### Spawn 流程详解

```
                        服务器
                          │
    AOI检测：EntityE 进入  │
    ClientA 的视野          │
                          ▼
              ┌─────────────────────┐
              │ 构造 SpawnMsg        │
              │ - EntityId: 42       │
              │ - Type: Monster      │
              │ - Pos: (100,0,50)   │
              │ - HP: 100            │
              │ - BaselineState...   │
              └──────────┬──────────┘
                         │ 可靠通道
                         ▼
                      ClientA
              ┌─────────────────────┐
              │ 收到 SpawnMsg        │
              │ 1. 预制体加载（异步） │
              │ 2. 实例化 GameObject  │
              │ 3. 应用初始状态       │
              │ 4. 注册到 EntityMap   │
              │ 5. 播 Spawn 动画     │
              └─────────────────────┘
```

```csharp
// 服务器端：实体进入视野
public class SpawnManager
{
    private AOIManager _aoi;
    private ReplicationLayer _repl;

    public void OnEntityEnterView(Entity entity, int clientId)
    {
        // 构造完整的初始状态（Baseline）
        var spawnMsg = new SpawnMessage
        {
            EntityId = entity.Id,
            EntityType = entity.TypeId,
            Position = entity.Position,
            Rotation = entity.Rotation,
            Properties = entity.SerializeBaseline(), // 所有同步属性的初始值
            OwnerPlayerId = entity.OwnerId,
        };

        // Spawn 必须走可靠有序通道
        _repl.SendReliable(spawnMsg, channelId: CHANNEL_SPAWN, clientId);

        // 记录 baseline，后续 Delta 同步以此为基准
        _repl.SetBaseline(clientId, entity.Id, spawnMsg.Properties);
    }
}

// 客户端：处理 Spawn
public class ClientEntityManager
{
    private Dictionary<uint, NetworkEntity> _entities = new();

    public void OnSpawn(SpawnMessage msg)
    {
        // 防止重复 Spawn（可靠通道可能重传）
        if (_entities.ContainsKey(msg.EntityId))
        {
            // 已经存在，可能是重传，更新状态即可
            _entities[msg.EntityId].ApplyState(msg.Properties);
            return;
        }

        // 异步加载预制体（避免卡帧）
        Addressables.LoadAssetAsync<GameObject>(msg.TypeId).Completed += handle =>
        {
            if (!_entities.ContainsKey(msg.EntityId)) // 加载期间可能已 Destroy
                return;

            var go = Instantiate(handle.Result, msg.Position, msg.Rotation);
            var netEntity = go.GetComponent<NetworkEntity>();
            netEntity.Init(msg.EntityId, msg.Properties);

            _entities[msg.EntityId] = netEntity;

            // 播放出生动画
            netEntity.PlaySpawnAnimation();
        };

        // 先创建占位实体（用初始数据渲染）
        _entities[msg.EntityId] = CreatePlaceholder(msg);
    }
}
```

#### Destroy / Despawn 流程

```csharp
// 服务器端：实体离开视野或死亡
public void OnEntityLeaveView(Entity entity, int clientId, DestroyReason reason)
{
    var destroyMsg = new DestroyMessage
    {
        EntityId = entity.Id,
        Reason = reason, // Killed / OutOfRange / Disconnected
    };

    _repl.SendReliable(destroyMsg, channelId: CHANNEL_DESTROY, clientId);

    // 清除 baseline（不再给这个客户端同步这个实体）
    _repl.ClearBaseline(clientId, entity.Id);
}

// 客户端：处理 Destroy
public void OnDestroy(DestroyMessage msg)
{
    if (!_entities.TryGetValue(msg.EntityId, out var entity))
    {
        // 实体不存在，可能是 Spawn 还在路上但 Destroy 先处理了（乱序）
        // 记录 pending destroy，等 Spawn 到达后立即销毁
        _pendingDestroys.Add(msg.EntityId);
        return;
    }

    switch (msg.Reason)
    {
        case DestroyReason.Killed:
            // 播放死亡动画后再销毁
            entity.PlayDeathAnimation(() => DestroyEntity(msg.EntityId));
            break;

        case DestroyReason.OutOfRange:
            // 离开视野：淡出后销毁
            entity.FadeOut(0.3f, () => DestroyEntity(msg.EntityId));
            break;

        case DestroyReason.Disconnected:
            // 玩家断线：直接移除
            DestroyEntity(msg.EntityId);
            break;
    }
}
```

#### 可见性管理与 Hysteresis（滞回区域）

```
            ClientA 的 AOI 范围
          ┌─────────────────────────┐
          │                         │
          │    ┌─────────────┐      │
          │    │  Inner Zone │      │  ← 进入此区域：触发 Spawn
          │    │  (半径 50m)  │      │
          │    └──────┬──────┘      │
          │           │             │
          │    ┌──────┴──────┐      │
          │    │  Outer Zone │      │  ← 离开外圈才触发 Despawn
          │    │  (半径 60m)  │      │
          │    └─────────────┘      │
          │                         │
          └─────────────────────────┘

Hysteresis = OuterR - InnerR = 10m

效果：实体在边界附近来回移动时不会反复 Spawn/Destroy
```

```csharp
public class VisibilityManager
{
    private const float INNER_RADIUS = 50f;   // 进入视野
    private const float OUTER_RADIUS = 60f;   // 离开视野
    // 差值就是滞回区域，防止边界抖动

    private Dictionary<int, HashSet<uint>> _clientVisibleEntities = new();

    public void UpdateVisibility(Entity entity, List<int> clientIds)
    {
        foreach (int clientId in clientIds)
        {
            var visible = _clientVisibleEntities.GetOrAdd(clientId);
            float dist = Vector3.Distance(entity.Position, GetClientPosition(clientId));
            bool wasVisible = visible.Contains(entity.Id);

            if (!wasVisible && dist <= INNER_RADIUS)
            {
                // 进入视野
                visible.Add(entity.Id);
                OnEntityEnterView?.Invoke(entity, clientId);
            }
            else if (wasVisible && dist > OUTER_RADIUS)
            {
                // 离开视野（注意是严格大于 Outer，不是 Inner）
                visible.Remove(entity.Id);
                OnEntityLeaveView?.Invoke(entity, clientId, DestroyReason.OutOfRange);
            }
            // 在滞回区域 [InnerR, OuterR] 内：保持原状态不变
        }
    }
}
```

#### Spawn/Update/Destroy 的通道设计

| 消息类型 | 通道 | 可靠性 | 有序性 | 原因 |
|---------|------|--------|--------|------|
| Spawn | CH_SPAWN | 可靠 | 有序 | 丢了会导致后续 Update 无实体可更新 |
| Destroy | CH_DESTROY | 可靠 | 有序 | 丢了会导致幽灵实体残留在客户端 |
| Update | CH_STATE | 不可靠 | 无序 | 丢了下一帧补上即可 |
| RPC | CH_RPC | 可靠 | 有序 | 操作不能丢失或乱序 |

**有序性保证**：Spawn 必须在 Update 之前被处理。如果 Spawn 和 Update 在同一通道且有序，则天然保证。但如果在不同通道，则需要版本号或时间戳来保证跨通道顺序。

#### 完整生命周期状态图

```
         ┌─────────── 服务器端 Entity 生命周期 ───────────┐
         │                                               │
         │  Created ──→ Active ──→ Dying ──→ Destroyed   │
         │     │           │           │                  │
         │     │           │           │                  │
         │  SendSpawn  SendUpdates  SendDestroy            │
         │     │           │           │                  │
         ▼     ▼           ▼           ▼                  │
       Client: Spawn    Client: Update  Client: Destroy   │
         │                                               │
         │  ┌───────── 客户端 Entity 状态机 ─────────┐    │
         │  │                                       │    │
         │  │  Pending ──→ Loading ──→ Active       │    │
         │  │                │              │       │    │
         │  │                │         FadingOut    │    │
         │  │                │              │       │    │
         │  │                ▼              ▼       │    │
         │  │            Unloaded      Removed       │    │
         │  └───────────────────────────────────────┘    │
         └───────────────────────────────────────────────┘
```

### ⚡ 实战经验

1. **Spawn 消息体积是带宽大头**：一条完整的 Spawn 包含所有初始属性（位置、血量、装备、Buff...），可能几百字节。如果 10 个玩家同时进入视野，就是几 KB 的突发流量。优化方向：Baseline 压缩（只发与"默认模板"的差异部分）、分批发送（一帧最多发 N 个 Spawn）
2. **乱序问题：Destroy 先于 Update 到达**：Spawn 走可靠通道，Update 走不可靠通道。如果 Spawn 延迟了（等待重传），Update 已经到了，客户端找不到实体 ID。解决方案：Update 缓存机制——收到的 Update 如果找不到实体，缓存 200ms，等 Spawn 到达后回放
3. **玩家自己的实体不应走网络 Spawn**：本地玩家的实体是客户端创建的（或者用特殊的 Local Spawn 消息），不需要等网络包确认。否则玩家进入游戏时会有一段"看不见自己"的真空期
4. **实体池（Entity Pool）复用**：频繁 Spawn/Destroy 的实体（如子弹、特效）应该用对象池复用，避免频繁实例化/销毁 GameObject 造成 GC 峰值。但注意 EntityId 每次必须是新的，不能复用 ID（防止老消息错误应用到新实体）

### 🔗 相关问题

- AOI（Area of Interest）系统如何高效确定哪些实体在视野内？
- Delta 同步的 Baseline 机制如何工作？实体重入视野时需要全量还是增量？
- 大量 NPC 同时进入视野时如何做流量削峰？
