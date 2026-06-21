---
title: "状态同步的快照机制与增量更新（Snapshot & Delta Sync）如何实现？"
category: "network"
level: 4
tags: ["状态同步", "快照", "增量更新", "Delta Compression", "带宽优化"]
related: ["network/frame-vs-state-sync", "network/entity-interpolation", "network/serialization-compression"]
hint: "服务器每帧发送全量状态太费带宽，如何只发变化的部分？"
---

## 参考答案

### ✅ 核心要点

1. **全量快照（Full Snapshot）**：定期发送世界完整状态，作为增量同步的基准线（Baseline）
2. **增量更新（Delta Update）**：只发送相对于 Baseline 的变化部分，大幅降低带宽
3. **序列号与 ACK 机制**：每个快照带序号，客户端 ACK 确认收到，服务器据此推进 Baseline
4. **字段级 Diff**：将实体拆分为属性字段，只序列化变化的字段（位掩码标记）
5. **可靠性保障**：增量更新走可靠通道，全量快照走不可靠通道兜底

### 📖 深度展开

#### 全量快照 vs 增量更新

```
方案 A：全量快照（Naive）

  Tick 1: [Player1: pos=(10,5), hp=100] [Player2: pos=(20,8), hp=80] [Player3: ...]
  Tick 2: [Player1: pos=(11,5), hp=100] [Player2: pos=(20,8), hp=75] [Player3: ...]
  Tick 3: [Player1: pos=(12,5), hp=95 ] [Player2: pos=(21,8), hp=75] [Player3: ...]

  → 每个 Tick 都发送所有实体的所有属性，带宽爆炸 💥

方案 B：增量更新（Delta Sync）

  Tick 1 (Full):  [Player1: pos=(10,5), hp=100] [Player2: pos=(20,8), hp=80]
                  Baseline 序号 = 1

  Tick 2 (Delta): 序号=2, baseline=1
                  Player1: pos=(11,5)  ← 只有 pos 变了
                  Player2: hp=75       ← 只有 hp 变了

  Tick 3 (Delta): 序号=3, baseline=2
                  Player1: pos=(12,5), hp=95  ← pos 和 hp 变了
                  // Player2 没变化，不发！

  → 带宽降低 70-90% ✅
```

#### 实现架构

```
服务器端：
┌────────────────────────────────────────────┐
│  Game State (权威世界状态)                   │
│                                            │
│  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Snapshot     │  │ Delta Differ        │  │
│  │ Manager      │──│ (对比 baseline 和    │  │
│  │              │  │  当前状态)           │  │
│  │ - baseline   │  │                     │  │
│  │ - history    │  │ 输出: ChangedFields  │  │
│  │   ring buffer│  │       + FieldMask   │  │
│  └─────────────┘  └─────────────────────┘  │
│         │                                  │
│         ▼                                  │
│  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Packet       │  │ Reliability Layer   │  │
│  │ Builder      │  │ - Delta: 可靠通道    │  │
│  │              │  │ - Full:  不可靠通道  │  │
│  └─────────────┘  └─────────────────────┘  │
└────────────────────────────────────────────┘

客户端：
┌────────────────────────────────────────────┐
│  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Packet      │→ │ State Applier       │  │
│  │ Receiver    │  │                     │  │
│  │              │  │ Full: 直接覆盖      │  │
│  │ - ACK manager│  │ Delta: 应用 diff    │  │
│  │ - 检测缺失   │  │       重建状态      │  │
│  └─────────────┘  └─────────────────────┘  │
│                          │                 │
│                          ▼                 │
│                   ┌──────────────┐         │
│                   │ Render World │         │
│                   │ (插值平滑)    │         │
│                   └──────────────┘         │
└────────────────────────────────────────────┘
```

#### 核心代码实现

```csharp
// ============ 实体属性定义 ============
public class NetworkEntity
{
    public uint EntityId;
    // 属性位掩码：每位对应一个属性
    public const int FIELD_POS_X = 0;
    public const int FIELD_POS_Y = 1;
    public const int FIELD_POS_Z = 2;
    public const int FIELD_HP    = 3;
    public const int FIELD_ROT   = 4;
    public const int FIELD_ANIM  = 5;
    public const int FIELD_COUNT = 6;

    public Vector3 Position;
    public float Rotation;
    public int HP;
    public int AnimState;

    // 序列化为 BitStream，只写变化的字段
    public void SerializeDelta(BitWriter writer, NetworkEntity baseline, out uint mask)
    {
        mask = 0;

        if (Position.x != baseline.Position.x)
        {
            mask |= 1u << FIELD_POS_X;
            writer.WriteFloat(Position.x);
        }
        if (Position.y != baseline.Position.y)
        {
            mask |= 1u << FIELD_POS_Y;
            writer.WriteFloat(Position.y);
        }
        // ... 其他字段同理
        if (HP != baseline.HP)
        {
            mask |= 1u << FIELD_HP;
            writer.WriteInt32(HP);
        }
    }
}

// ============ 服务器端：构建 Delta 包 ============
public class SnapshotManager
{
    // 每个客户端的最近 ACK 快照（作为 baseline）
    private Dictionary<int, WorldSnapshot> _baselines = new();

    // 快照历史环形缓冲（用于重传）
    private WorldSnapshot[] _history = new WorldSnapshot[64];
    private int _historyHead;

    public byte[] BuildPacket(int clientId, WorldState current, int tick)
    {
        var baseline = _baselines.GetValueOrDefault(clientId);
        var writer = new BitWriter();

        if (baseline == null || tick - baseline.Tick >= FULL_SNAPSHOT_INTERVAL)
        {
            // 全量快照
            writer.WriteBool(true); // isFull = true
            writer.WriteInt32(tick);
            foreach (var entity in current.Entities)
            {
                writer.WriteUInt32(entity.EntityId);
                SerializeFull(writer, entity);
            }
            writer.WriteUInt32(0); // 结束标记
        }
        else
        {
            // 增量更新
            writer.WriteBool(false); // isFull = false
            writer.WriteInt32(tick);
            writer.WriteInt32(baseline.Tick); // baseline tick

            foreach (var entity in current.Entities)
            {
                var baselineEntity = baseline.GetEntity(entity.EntityId);
                if (baselineEntity == null || entity.HasChanged(baselineEntity))
                {
                    writer.WriteUInt32(entity.EntityId);
                    entity.SerializeDelta(writer, baselineEntity, out uint mask);
                    writer.WriteUInt32(mask);
                }
            }
            writer.WriteUInt32(0); // 结束标记
        }

        return writer.ToArray();
    }
}

// ============ 客户端：应用快照 ============
public class StateApplier
{
    private WorldState _world;
    private int _lastAppliedTick;

    public void ApplyPacket(byte[] data)
    {
        var reader = new BitReader(data);
        bool isFull = reader.ReadBool();
        int tick = reader.ReadInt32();

        if (!isFull)
        {
            int baselineTick = reader.ReadInt32();
            // 检查 baseline 是否连续
            if (baselineTick > _lastAppliedTick + 1)
            {
                // 缺少中间快照，跳过此 Delta，等全量快照
                Log.Warn($"Delta gap: baseline={baselineTick}, last={_lastAppliedTick}");
                return;
            }
        }

        while (true)
        {
            uint entityId = reader.ReadUInt32();
            if (entityId == 0) break;

            var entity = _world.GetOrCreateEntity(entityId);
            if (isFull)
            {
                DeserializeFull(reader, entity);
            }
            else
            {
                uint mask = reader.ReadUInt32();
                entity.ApplyDelta(reader, mask);
            }
        }

        _lastAppliedTick = tick;
        // 发送 ACK 给服务器
        SendAck(tick);
    }
}
```

#### 带宽优化技巧

| 技巧 | 节省量 | 说明 |
|------|--------|------|
| 字段级 Delta | 50-80% | 只发变化的属性 |
| 定点数替代浮点 | 30-50% | 位置用 16-bit 定点而非 32-bit 浮点 |
| 属性优先级分级 | 20-40% | 位置每帧发，HP 变化时发，动画状态插值 |
| 量化压缩 | 40-60% | 角度用 8-bit（256级），速度用 4-bit |
| 全量快照降频 | 30-50% | 每 10-20 个 Delta 后才发一次 Full |
| 前后帧差值编码 | 20-30% | 只发与前帧的 delta 而非绝对值 |

```
带宽计算示例（MOBA，10 个玩家，20Hz 同步）：

全量方案：
  每实体 ~200 bytes × 10 实体 × 20 次/秒 = 40,000 bytes/s ≈ 312 kbps

Delta 方案（优化后）：
  均每实体 ~20 bytes × 10 实体 × 20 次/秒 = 4,000 bytes/s ≈ 32 kbps
  全量快照（每 2 秒一次）：~2000 bytes/2s = 1000 bytes/s ≈ 8 kbps

  总计 ≈ 40 kbps（节省 87%）
```

### ⚡ 实战经验

- **全量快照的频率要足够高**：如果全量快照间隔过长（如 30 秒），新加入观众或断线重连的玩家需要等很久才能建立 baseline，通常 1-3 秒发一次全量快照比较合理
- **Delta 链断裂是最棘手的问题**：客户端丢了一个 Delta 包，后续所有 Delta 都基于未收到的 baseline，需要立即回退到上一个已确认的 baseline 或等待全量快照。**Ack 机制必须在 Delta 同步中是可靠的**
- **属性变化阈值很重要**：位置变化 0.001m 也触发 Delta？加一个最小变化阈值（如位移 > 0.1m 才同步），避免微抖动刷屏
- **优先级与带宽分配**：重要实体（玩家自己、附近敌人）每帧同步全属性；次要实体（远处玩家、NPC）降频同步或只同步位置；不在视野内的实体不同步

### 🔗 相关问题

- 帧同步中是否需要 Delta Sync？为什么帧同步的带宽通常更稳定？
- 如何处理 Delta 包到达顺序乱序问题？
- 在 AOI（兴趣区域）边缘进出时，如何平滑切换实体同步状态？
