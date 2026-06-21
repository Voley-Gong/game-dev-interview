---
title: "游戏网络序列化方案如何选型？Protobuf、FlatBuffers、BitStream 与 Delta Compression"
category: "network"
level: 3
tags: ["序列化", "Protobuf", "FlatBuffers", "Delta Compression", "网络优化"]
related: ["network/protocol-selection", "network/frame-vs-state-sync"]
hint: "一包状态同步数据从 2KB 压到 120 字节，中间发生了什么？"
---

## 参考答案

### ✅ 核心要点

1. **序列化是网络同步的底层基石**：每帧上千个实体的状态如何编码成字节流，直接决定带宽消耗和 CPU 开销
2. **Protobuf**：Google 出品，Schema 驱动，体积小、生态好，但需要编译生成代码，运行时有少量解析开销
3. **FlatBuffers**：零拷贝序列化，读取时不需要反序列化，适合高频小消息，但 Schema 灵活性不如 Protobuf
4. **BitStream / Bitpacking**：手动按位打包，极致压缩率，适合竞速/FPS 等对带宽极度敏感的场景
5. **Delta Compression（增量压缩）**：只发送"与上一次相比变化了的部分"，是 MMO/大逃杀类游戏带宽优化的核心手段

### 📖 深度展开

**序列化方案对比矩阵：**

| 维度 | Protobuf | FlatBuffers | JSON | BitStream（手写） |
|------|----------|-------------|------|-------------------|
| 体积 | 很小（varint + field号） | 较小 | 大（文本） | 极小（按位控制） |
| 解析速度 | 中（需反序列化） | 极快（零拷贝） | 慢 | 快（但需手写） |
| Schema | 强类型 .proto | 强类型 .fbs | 无 | 无（纯手写） |
| 前后兼容 | 内置支持 | 内置支持 | 天然兼容 | 需手动版本管理 |
| 开发效率 | 高（自动生成） | 高 | 极高 | 低 |
| 适用场景 | 通用游戏协议 | 高频实时消息 | 调试/Lobby | 竞速/FPS 极致优化 |

**Protobuf 示例——游戏同步消息定义：**

```protobuf
// player_sync.proto
syntax = "proto3";

message PlayerSnapshot {
    uint32 entity_id = 1;
    Vector3 position = 2;
    Vector3 velocity = 3;
    float yaw = 4;
    uint32 health = 5;
    uint32 input_seq = 6;
    // uint32 只占 1 byte 当值 < 128（varint 编码）
}

message Vector3 {
    float x = 1;
    float y = 2;
    float z = 3;
}

message WorldSnapshot {
    uint32 frame = 1;
    repeated PlayerSnapshot players = 2;
    // 一个 10 人房间每帧约 300-500 bytes
}
```

**FlatBuffers 示例——零拷贝读取：**

```csharp
// 编译 .fbs 生成代码后

// 序列化
var builder = new FlatBufferBuilder(1024);
var pos = Vec3.CreateVec3(builder, 1.5f, 0f, 3.2f);
var player = PlayerSnapshot.CreatePlayerSnapshot(builder, 42, pos.Value, 100, 1);
builder.Finish(player);

byte[] data = builder.SizedByteArray(); // 直接拿到字节流

// 反序列化 —— 零拷贝，直接从 buffer 读取
var snapshot = PlayerSnapshot.GetRootAsPlayerSnapshot(data);
float x = snapshot.Position.X; // 直接访问，无需解析整条消息
```

**BitStream 手写位打包——极致压缩：**

```csharp
// 普通做法：一个 float 占 4 字节（32 bit）
// 但游戏中有大量"不需要全精度"的数据

public class BitWriter {
    private byte[] buffer;
    private int bitOffset;

    public void WriteFloat(float value, float min, float max, int bits) {
        // 将 [min, max] 范围的 float 量化为 bits 位的整数
        float normalized = (value - min) / (max - min);
        uint quantized = (uint)(normalized * ((1u << bits) - 1));
        WriteBits(quantized, bits);
    }

    // 位置坐标：地图范围 [-500, 500]，12位精度 ≈ 0.24m 误差
    // 速度方向：0-360度，9位精度 ≈ 0.7度 误差
    // 朝向yaw：0-360度，8位即可
}

// 对比：一个玩家完整状态
// | 字段     | 原始(float×N) | BitStream      |
// |----------|---------------|----------------|
// | position | 96 bit (3×32) | 36 bit (3×12)  |
// | velocity | 96 bit        | 36 bit         |
// | yaw      | 32 bit        | 8 bit          |
// | health   | 32 bit        | 7 bit (0-127)  |
// |----------|---------------|----------------|
// | 总计     | 256 bit = 32B | 87 bit ≈ 11B   |
```

**Delta Compression（增量压缩）核心原理：**

```
全量快照（Full Snapshot）——每帧发送完整状态：
  Frame 100: [Player1完整状态] [Player2完整状态] ... [PlayerN完整状态]
  Frame 101: [Player1完整状态] [Player2完整状态] ... [PlayerN完整状态]
  // 带宽 = O(N × EntitySize × FrameRate)，完全不可持续

增量快照（Delta Snapshot）——只发送变化部分：
  Frame 100: [Player1 全量] [Player2 全量] ... [PlayerN 全量]   ← Baseline
  Frame 101: [Player2 position变化] [Player5 health变化]         ← 只发 diff
  Frame 102: [无变化] ← 空包或心跳
  Frame 103: [Player1 position变化]
  // 带宽 ≈ O(ChangedEntities × DeltaSize × Rate)，大幅降低
```

```csharp
// Delta Compression 实现要点

struct EntityDelta {
    public uint entityId;
    public uint changedFieldsMask; // 位掩码：哪些字段变了
    public FieldData[] changedFields;
}

void BuildDeltaSnapshot(EntitySnapshot current, EntitySnapshot baseline, out EntityDelta delta) {
    uint mask = 0;

    if (current.position != baseline.position) mask |= 0x01;  // bit 0 = position
    if (current.health != baseline.health)     mask |= 0x02;  // bit 1 = health
    if (current.animation != baseline.animation) mask |= 0x04; // bit 2 = anim
    if (current.yaw != baseline.yaw)           mask |= 0x08;  // bit 3 = yaw

    delta.entityId = current.entityId;
    delta.changedFieldsMask = mask;
    // 只序列化 mask 中标记为 1 的字段
}

// 客户端收到后：用 baseline + delta = 还原当前完整状态
// 如果 baseline 丢失（丢包）→ 需要请求全量快照（Full Snapshot）
```

### ⚡ 实战经验

- **不要过早优化**：项目初期用 Protobuf 就够了，等到带宽成为瓶颈再上 BitStream 或 Delta。过早的手写序列化会严重拖慢迭代速度
- **Delta Compression 的隐性成本是状态管理**：服务器需要为每个客户端维护一份"上次确认的全量快照"作为 baseline，客户端丢包后 baseline 不一致会导致状态错乱，需要引入 ACK 机制
- **浮点数量化要测视觉效果**：12 位量化的位置在远处角色身上肉眼看不出，但近处高速移动时可能出现像素抖动。建议根据距离做自适应精度——远处 10 位，近处 16 位
- **Protobuf 的 repeated 字段在小消息场景开销不可忽视**：一个只有 2 个字段的 message，Protobuf 的 field tag 开销可能占总数据量的 30% 以上，这种场景考虑直接用 FlatBuffers 或手写

### 🔗 相关问题

- 如何设计一个兼顾带宽效率和前后兼容的协议格式？
- 状态同步中如何处理 Delta 压缩导致的丢包雪崩？
- 为什么很多游戏引擎不用 Protobuf 而是自己实现序列化？
