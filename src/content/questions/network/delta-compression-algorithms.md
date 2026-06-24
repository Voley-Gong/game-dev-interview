---
title: "游戏网络同步中的增量压缩（Delta Compression）算法原理是什么？"
category: "network"
level: 3
tags: ["增量压缩", "Delta Compression", "带宽优化", "序列化"]
related: ["network/snapshot-delta-sync", "network/field-level-delta-encoding", "network/serialization-compression"]
hint: "全量快照太大传不起——如何只传'变化的部分'？Delta Compression 的核心思路是什么？"
---

## 参考答案

### ✅ 核心要点

1. **基准快照（Baseline）**：客户端和服务器共同维护一份「最后确认收到的完整状态」，增量基于它计算
2. **Diff 计算**：服务器比较当前快照与基准快照，只序列化发生变化的字段
3. **基准推进**：客户端确认收到增量包后，将基准推进到新版本，服务器也随之推进
4. **全量回退**：当增量包丢失或基准不一致时，回退到发送全量快照重建基准
5. **压缩链叠加**：Delta Compression 通常与位打包（Bit Packing）、Zstd/LZ4 通用压缩叠加使用

### 📖 深度展开

#### 为什么需要 Delta Compression？

一个 MMO 战场场景中，100 个实体 × 每实体 20 个同步字段 = 2000 个字段。如果每帧全量同步：

```
全量快照大小（粗算）：
  100 实体 × 20 字段 × 平均 4 字节 = 8,000 bytes / 帧
  30 fps 网络帧 = 240,000 bytes/s ≈ 240 KB/s ≈ 1.92 Mbps

增量同步（通常只有 5%~15% 字段变化）：
  100 实体 × 3 变化字段 × 4 字节 = 1,200 bytes / 帧
  30 fps = 36,000 bytes/s ≈ 36 KB/s ≈ 0.29 Mbps

→ 带宽降低约 85%
```

#### Delta Compression 的核心数据流

```
服务器端                                    客户端
  │                                           │
  │  Baseline[client=5] = Snapshot_v5         │  Baseline = Snapshot_v5
  │                                           │
  │  Current = Snapshot_v12                   │
  │                                           │
  │  Step 1: Diff(Baseline_v5, Current_v12)   │
  │  → 变化字段集合 {entity3.pos, entity7.hp} │
  │                                           │
  │  Step 2: 序列化增量包                     │
  │  DeltaPacket {                            │
  │    baseSeq: 5,                            │
  │    newSeq: 12,                            │
  │    changes: [                             │
  │      {eid:3, field:pos, val:(1.2,0,3.4)},│
  │      {eid:7, field:hp, val:87}           │
  │    ]                                      │
  │  }                                        │
  │                                           │
  ├─────── 可靠/不可靠通道发送 ──────────────→│
  │                                           │
  │                              Step 3: 应用增量
  │                              如果 baseSeq == 客户端 Baseline
  │                                → 成功应用，更新 Baseline 到 v12
  │                              如果 baseSeq != Baseline
  │                                → 请求全量快照（Resend）
  │                                           │
  │←──────── Ack(seq=12) ────────────────────┤
  │                                           │
  │  Step 4: 推进 Baseline[client] = v12      │
  │                                           │
```

#### 三种 Delta 策略对比

**策略一：字段级 Delta（Dirty Flag）**

```csharp
// 最简单的 Delta：基于 Dirty Flag 标记变化字段
public class SyncEntity {
    public uint EntityId;

    [SyncField] public Vector3 Position;
    [SyncField] public Vector3 Velocity;
    [SyncField] public float Health;
    [SyncField] public int AnimationState;

    // Dirty flags（位掩码）
    private uint dirtyMask;

    public void SetPosition(Vector3 newPos) {
        if (Vector3.Distance(newPos, Position) > EPSILON) {
            Position = newPos;
            dirtyMask |= 0x01;  // bit 0 = position
        }
    }

    public void SetHealth(float hp) {
        if (Math.Abs(hp - Health) > 0.01f) {
            Health = hp;
            dirtyMask |= 0x04;  // bit 2 = health
        }
    }

    public void SerializeDelta(BitWriter writer) {
        writer.WriteBits(dirtyMask, 4);  // 4 bit mask
        if ((dirtyMask & 0x01) != 0) WriteVector3(writer, Position);
        if ((dirtyMask & 0x02) != 0) WriteVector3(writer, Velocity);
        if ((dirtyMask & 0x04) != 0) writer.WriteFloat16(Health);
        if ((dirtyMask & 0x08) != 0) writer.WriteBits(AnimationState, 6);

        dirtyMask = 0;  // 清除 dirty
    }
}
```

**策略二：量化压缩 Delta**

```csharp
// 将 float 位置量化到固定精度，减少位数
public void WriteQuantizedPosition(BitWriter writer, Vector3 pos, Vector3 origin, float range) {
    // 将世界坐标量化到 0.01m 精度
    // 范围 ±500m → 需要 100,000 个值 → 17 bits
    const float QUANTIZE_STEP = 0.01f;
    const int QUANTIZE_BITS = 17;

    int qx = (int)((pos.x - origin.x + range) / QUANTIZE_STEP);
    int qy = (int)((pos.y - origin.y + range) / QUANTIZE_STEP);
    int qz = (int)((pos.z - origin.z + range) / QUANTIZE_STEP);

    writer.WriteBits(qx, QUANTIZE_BITS);  // 17 bits vs 32 bits float
    writer.WriteBits(qy, QUANTIZE_BITS);
    writer.WriteBits(qz, QUANTIZE_BITS);
    // 总计: 51 bits vs 96 bits → 节省 47%
}
```

**策略三：基准 Delta（状态差值编码）**

```csharp
// 针对高频连续变化的值（如位置），发送相对于基准的增量
public void WriteDeltaPosition(BitWriter writer, Vector3 current, Vector3 baseline) {
    Vector3 delta = current - baseline;

    // 小位移：用少量 bits 编码
    if (delta.magnitude < 1.0f) {
        writer.WriteBit(false);  // flag: small delta
        writer.WriteFloat8(delta.x);  // 8-bit fixed point (-1~1m)
        writer.WriteFloat8(delta.y);
        writer.WriteFloat8(delta.z);
        // 3 + 24 = 27 bits
    }
    // 大位移：直接写完整坐标
    else {
        writer.WriteBit(true);  // flag: full position
        WriteQuantizedPosition(writer, current, ...);
        // 1 + 51 = 52 bits
    }
}
```

#### 增量包可靠性问题

增量包依赖有序到达和基准一致。但 UDP 不保证可靠性，会出现：

```
场景：包乱序导致基准不一致

  服务器发送顺序: Delta(5→6), Delta(6→7), Delta(7→8)
  客户端收到顺序: Delta(5→6), [Delta(6→7) 丢失], Delta(7→8)

  客户端应用 Delta(5→6): Baseline = 6 ✅
  客户端收到 Delta(7→8): baseSeq=7 ≠ Baseline=6 ❌

  → 客户端发送 NAK(7) 请求重传
  → 或请求全量快照 (FullSnapshot)
```

解决方案对比：

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| 可靠有序通道 | 保证 Delta 包按序到达 | 永远不会出现基准不一致 | 队头阻塞，高延迟 |
| 多版本 Delta | 每个 Delta 包携带最近 N 个基准版本 | 容忍乱序 | 包体积增大 |
| 全量回退 | 检测基准不一致时请求全量快照 | 简单可靠 | 突发带宽峰值 |
| 快速重传 | 客户端检测缺口后 NAK | 恢复快 | 额外 RTT 开销 |

#### 实际项目中的 Delta 压缩管线

```
原始状态
    │
    ↓
┌─────────────────┐
│ Step 1: Dirty Flag 收集 │  → 只选变化字段
└────────┬────────┘
         ↓
┌─────────────────┐
│ Step 2: 量化压缩       │  → float → int16/int8
└────────┬────────┘
         ↓
┌─────────────────┐
│ Step 3: 增量编码       │  → 相对 Baseline 的 diff
└────────┬────────┘
         ↓
┌─────────────────┐
│ Step 4: 位打包         │  → BitWriter 紧凑排列
└────────┬────────┘
         ↓
┌─────────────────┐
│ Step 5: Zstd/LZ4 压缩  │  → 通用无损压缩
└────────┬────────┘
         ↓
    最终网络包
```

### ⚡ 实战经验

- **不要过度压缩高频位置**：位置每帧都在变化，Delta 空间很小。有时候直接发量化坐标 + Zstd 压缩，效果比复杂 Delta 逻辑更好且更简单
- **监控 Delta 命中率**：在 QA 阶段统计「变化字段数 / 总字段数」的比值。如果 Delta 命中率长期 >50%，说明场景变化太剧烈，Delta 压缩收益不大，应该考虑降低同步频率
- **基准同步陷阱**：玩家断线重连后基准已过期，必须先发一个全量快照重建基准。很多 bug 来源于重连后直接发增量包导致状态混乱
- **增量 vs 全量的动态切换**：当增量包大小超过全量包的 70% 时，直接发全量更划算。设置动态切换阈值

### 🔗 相关问题

- 快照增量同步（Snapshot Delta Sync）和帧同步的增量机制有什么区别？
- 如何设计一个高效的位打包（Bit Packing）序列化层？
- 在什么场景下应该使用 Protobuf / FlatBuffers 而非自定义 BitStream？
