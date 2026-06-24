---
title: "RPC vs 属性复制（Replicated Properties）：游戏网络通信模式如何选择？"
category: "network"
level: 3
tags: ["RPC", "属性复制", "网络通信模式", "Server RPC", "Client RPC", "Multicast", "面试高频"]
related: ["network/property-replication-system", "network/message-dispatch-handler-registry", "network/frame-vs-state-sync"]
hint: "为什么「开火」用 RPC 但「换弹」用属性复制？「播放受击动画」该用 Multicast 还是 RepNotify？"
---

## 参考答案

### ✅ 核心要点

1. **三种核心通信模式**：Server RPC（客户端→服务器）、Client RPC（服务器→特定客户端）、Multicast RPC（服务器→所有客户端）
2. **属性复制是状态同步**：持续维护权威值，适合需要持久一致性表达的数据（血量、位置、装备）
3. **RPC 是事件触发**：即发即弃（Fire-and-Forget），适合瞬时事件（开火、命中、特效播放）
4. **选择原则**：状态用 Replicated Properties，事件用 RPC，两者不可混用
5. **可靠性陷阱**：RPC 默认走可靠通道会阻塞，大量 RPC 应走不可靠通道或改用属性复制

### 📖 深度展开

#### 三种 RPC 类型对比

```
┌─────────────────────────────────────────────────────────────┐
│                    SERVER (Authority)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ Server   │  │ Client   │  │ Multicast│                  │
│  │ RPC      │  │ RPC      │  │ RPC      │                  │
│  │ (来自    │  │ (发给    │  │ (发给    │                  │
│  │  Client) │  │  Client) │  │  All)    │                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
└───────┼──────────────┼──────────────┼───────────────────────┘
        │              │              │
        ▼              ▼              ▼
   ┌─────────┐   ┌─────────┐   ┌─────────────────┐
   │ 验证+   │   │ 目标    │   │ 所有相关客户端   │
   │ 执行    │   │ 客户端  │   │ (受 Relevancy)  │
   └─────────┘   └─────────┘   └─────────────────┘
```

#### 何时用什么：决策树

```
需要同步的信息
  │
  ├── 是「状态」还是「事件」？
  │     │
  │     ├── 状态（血量、位置、装备...）
  │     │     └── Replicated Properties + RepNotify
  │     │
  │     └── 事件（开火、受击、拾取...）
  │           │
  │           ├── 谁需要知道？
  │           │     │
  │           │     ├── 服务器需要知道 → Server RPC
  │           │     ├── 特定客户端需要知道 → Client RPC
  │           │     └── 所有人需要知道 → Multicast RPC
  │           │
  │           └── 可以丢包吗？
  │                 ├── 可以（特效、音效）→ 不可靠 Multicast
  │                 └── 不可以（伤害、拾取）→ 改用属性复制
  │
  └── 是高频持续数据吗？
        └── 是（位置、速度）→ 属性复制 + 量化压缩
```

#### 代码示例：正确用法

```cpp
// ===== 正确：事件用 RPC =====
UFUNCTION(Server, Reliable, WithValidation)
void Server_Fire();  // 客户端请求开火，服务器验证

UFUNCTION(Client, Reliable)
void Client_NotifyHit(AActor* HitActor);  // 服务器通知命中

UFUNCTION(NetMulticast, Unreliable)
void Multicast_PlayFireEffect(FVector Location);  // 所有客户端播特效

// ===== 正确：状态用 Replicated Properties =====
UPROPERTY(ReplicatedUsing = OnRep_Health)
float Health;  // 血量变化驱动 UI 更新

UPROPERTY(Replicated)
FVector_NetQuantize ReplicatedLocation;  // 位置持续同步

// ===== 错误示范：用 RPC 同步状态 =====
UFUNCTION(Client, Reliable)
void Client_UpdateHealth(float NewHealth);  // ❌ 如果丢包/乱序，状态不一致
// 正确做法：UPROPERTY(Replicated)
```

#### RPC 通道与可靠性详解

| 通道类型 | 可靠性 | 顺序保证 | 适用场景 | 风险 |
|---------|--------|---------|---------|------|
| Reliable RPC | 保证到达 | 按顺序 | 关键事件（交易、任务） | 堵塞通道，堆积导致延迟 |
| Unreliable RPC | 不保证 | 无序 | 特效、音效 | 可能丢失 |
| 属性复制 | 内部可靠 | 最终一致 | 持续状态 | 自动补传机制 |

#### 面试高频：RPC 和属性复制组合模式

```cpp
// 模式1：RPC 触发 + 属性同步结果
// 客户端请求换弹 → 服务器验证 → 修改 Ammo 属性 → 所有端自动同步
UFUNCTION(Server, Reliable)
void Server_Reload() {
    if (CanReload()) {
        AmmoCount = MaxAmmo;  // Replicated 属性，自动同步
        // 不需要 Multicast_Reload，属性复制会通知所有端
    }
}

// 模式2：RPC 即时反馈 + 属性最终校正
// 客户端开火 → 服务器验证 → 属性扣弹药 + RPC 播特效
UFUNCTION(Server, Reliable, WithValidation)
void Server_Fire() {
    if (ConsumeAmmo()) {       // AmmoCount 属性自动复制
        Multicast_PlayMuzzleFlash();  // 特效用 RPC 即时播放
    }
}

// 模式3：RepNotify 替代 Multicast
UPROPERTY(ReplicatedUsing = OnRep_EquipState)
uint8 EquippedWeaponSlot;  // 变化时自动触发 OnRep_EquipState

UFUNCTION()
void OnRep_EquipState() {
    // 在客户端切换武器模型、动画
    // 比 Multicast 更安全：断线重连后也能正确同步
}
```

#### RPC vs Replicated Properties 性能对比

| 维度 | RPC | Replicated Properties |
|------|-----|----------------------|
| 带宽消耗 | 每次调用独立发包 | 增量序列化，合批发送 |
| 丢包处理 | 可靠通道重传 / 不可靠直接丢 | 内建 last-value 保证 |
| 断线重连 | 历史事件丢失 | 当前状态自动全量同步 |
| 调试难度 | 难（事件流追踪） | 易（比较属性值） |
| 延迟敏感性 | 高（丢包即丢失或延迟） | 低（持续纠正） |

### ⚡ 实战经验

- **Reliable RPC 是延迟杀手**：一个 Reliable RPC 丢包会阻塞后续所有 Reliable RPC，游戏中的"按了技能没反应"经常是这个原因。高频技能改用属性复制 + RepNotify
- **Multicast 走不可靠通道**：特效和音效用 `Unreliable` Multicast，避免因网络波动堵塞关键逻辑通道
- **Server RPC 必须做验证**：永远不信任客户端数据，Server_RPC 中必须校验冷却、弹药、位置合法性，否则就是外挂入口
- **断线重连后 RPC 事件全丢**：重连逻辑不要依赖 RPC 的"重放"，必须基于 Replicated Properties 的当前状态重建。这也是为什么核心状态永远要用属性复制

### 🔗 相关问题

- 如何设计一个高效的消息分发系统来处理 RPC 和属性更新？
- 帧同步中是否需要 RPC？Lockstep 模式下事件传递有什么不同？
- Unreal 的 FastArrayReplication 适合同步什么类型的数据？
