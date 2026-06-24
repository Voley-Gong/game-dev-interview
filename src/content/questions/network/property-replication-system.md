---
title: "游戏网络属性复制系统（Property Replication）如何设计？Ghost/Puppet 模型与优先级同步"
category: "network"
level: 3
tags: ["属性复制", "Property Replication", "Ghost", "Puppet", "状态同步", "UE Replication", "网络架构"]
related: ["network/dirty-flag-sync-system", "network/server-authority-vs-client-trust", "network/snapshot-delta-sync"]
hint: "Unreal 的属性复制系统为什么能在 64 人对战游戏中把带宽压到 50KB/s？关键在 Net Priority、Relevancy 和条件复制。"
---

## 参考答案

### ✅ 核心要点

1. **Ghost / Puppet 模型**：服务器维护权威实体（Ghost），客户端持有影子副本（Puppet），服务器按规则推送属性变更
2. **属性标记（Property Flag）**：每个可复制属性标记 Replicated/RepNotify，引擎自动追踪变更并触发客户端回调
3. **网络相关性（Network Relevancy）**：距离 / 视锥 / AOI 过滤，不可见实体不占用带宽
4. **优先级调度（Net Priority）**：基于距离、朝向、最近更新时间计算优先级，重要实体先同步
5. **条件复制（Conditional Replication）**：根据角色、状态、距离决定是否发送某属性，粒度到字段级别

### 📖 深度展开

#### 整体架构

```
Server Authority Layer
├── Replicated Properties (标记了 Replicated 的字段)
│   ├── Health (REP_NOTIFY → 客户端 OnRep_Health)
│   ├── Position (每帧检测变化)
│   ├── Weapon (条件复制: 仅 Owner 可见 ammo count)
│   └── Animation State (量化压缩后发送)
├── Dirty Tracker (脏标记追踪)
│   ├── Per-property dirty flag (位标记)
│   └── Per-connection dirty flag (每个连接独立)
├── Relevancy Checker (相关性检测)
│   ├── Distance culling
│   ├── Frustum check
│   └── Custom logic (如队友始终相关)
├── Priority Scheduler (优先级调度)
│   ├── Score = BasePriority × DistanceFactor × TimeSinceLastRep
│   └── 按 Score 降序填充带宽预算
└── Serializer (序列化)
    ├── Delta encoding (相对上一帧的变化)
    └── Quantization (浮点→定点压缩)

Client Puppet Layer
├── Property Cache (上次收到的值)
├── RepNotify Callbacks (变化时触发)
├── Interpolation Engine (位置/旋转平滑)
└── Prediction Correction (本地预测与服务器校正)
```

#### 属性变更检测与打包

```cpp
// UE 风格的属性复制声明
class ACharacter : public AActor {
    UPROPERTY(ReplicatedUsing = OnRep_Health)
    float Health;                    // 复制属性，变化时回调

    UPROPERTY(Replicated)
    FVector ReplicatedMovement;      // 每帧复制位置

    // 条件复制：只有 Owner 能看到子弹数
    UPROPERTY(Replicated)
    int32 AmmoCount;                 // GetLifetimeReplicatedProps 中设 COND_OwnerOnly

    UFUNCTION()
    void OnRep_Health();             // 客户端回调
};

// 服务器端：每帧检测脏属性
void UNetDriver::TickReplication(float DeltaSeconds) {
    for (auto& Actor : RelevantActors) {
        // 1. 相关性过滤
        if (!IsRelevantTo(Connection, Actor)) continue;

        // 2. 收集脏属性（位标记比对）
        uint64 DirtyBits = Actor->GetDirtyBits();
        if (DirtyBits == 0) continue;

        // 3. 计算优先级
        float Priority = CalcNetPriority(Actor, Connection);

        // 4. 加入待发送队列
        ReplicationQueue.Add({Actor, DirtyBits, Priority});
    }

    // 5. 按优先级排序，在带宽预算内发送
    ReplicationQueue.SortByPriority();
    int32 RemainingBudget = Connection->GetOutgoingBudget(); // bytes
    for (auto& Item : ReplicationQueue) {
        int32 Size = EstimateSerializeSize(Item);
        if (Size > RemainingBudget) continue; // 预算不够，跳过
        SerializeAndSend(Item);
        RemainingBudget -= Size;
    }
}
```

#### 优先级计算公式

```
Priority = Actor.NetPriority
         × (1.0 / max(Distance, 1.0))     // 距离越近优先级越高
         × (TimeSinceLastReplication + 1.0) // 越久没更新越紧急
         × ViewDotProduct                  // 在视野内加分
         × (bRecentlyReplicated ? 0.8 : 1.0) // 刚复制过的稍微降权
```

#### 条件复制标记对比

| 条件标记 | 含义 | 典型用途 |
|---------|------|---------|
| `COND_InitialOnly` | 仅初始同步 | 角色名、外观配置 |
| `COND_OwnerOnly` | 仅 Owner 可见 | 弹药量、技能 CD、瞄准镜状态 |
| `COND_SkipOwner` | Owner 不可见 | 第三人称模型信息（Owner 用第一人称） |
| `COND_SimulatedOnly` | 仅模拟端可见 | 位置插值数据 |
| `COND_AutonomousOnly` | 仅自治端可见 | 输入确认、本地预测变量 |
| `COND_Custom` | 自定义条件 | 组队可见、同区域可见 |

#### Ghost/Puppet 与状态同步的关系

| 维度 | 传统状态同步 | Property Replication |
|------|------------|---------------------|
| 同步粒度 | 整个实体快照 | 单个属性字段 |
| 变更检测 | 全量比对 | 位标记（DirtyBits） |
| 带宽控制 | 固定频率发送 | 优先级 + 预算调度 |
| 条件控制 | 实体级别 | 字段级别（COND_xxx） |
| 客户端响应 | 设置属性值 | RepNotify 回调驱动逻辑 |

### ⚡ 实战经验

- **不要 Replicated 所有属性**：每增加一个复制属性都增加带宽，用 `COND_` 标记过滤无关端，尤其 OwnerOnly 能省大量字节
- **位置同步单独处理**：位置变化频率最高（每帧），建议自定义量化精度（如 mm 级定点）而非直接发 float，3 个 float = 12 bytes，量化到 2 bytes/轴 = 6 bytes，省 50%
- **Net Priority 需要调参**：角色默认 1.0，投射物设 5.0（速度快、生命短），背景 NPC 设 0.1，避免低优先级实体长期饥饿导致"瞬移"
- **带宽预算是硬约束**：64 人对战、20 tick/s、每连接 50KB/s 上行 → 每帧 2.5KB 预算，一个完整角色快照 ~200 bytes，最多 12 个角色/帧，必须靠优先级裁剪

### 🔗 相关问题

- 状态同步的脏标记系统如何设计？→ 脏标记位运算与连接级追踪
- 如何在 MMO 中实现百万级属性的高效复制？→ 分区服务器 + AOI + 属性分组
- Unreal Engine 的 NetSerialization 和 FastArrayReplication 适合什么场景？
