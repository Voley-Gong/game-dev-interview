---
title: "帧同步中的输入累积与打包发送（Input Accumulation & Batching）如何实现？"
category: "network"
level: 3
tags: ["帧同步", "输入处理", "网络同步", "Lockstep", "带宽优化"]
related: ["network/lockstep-input-buffering-delay.md", "network/deterministic-rng-lockstep.md", "network/lockstep-implementation.md"]
hint: "客户端每帧产生的输入如何高效地打包发送给服务器和其他玩家？"
---

## 参考答案

### ✅ 核心要点

1. **输入结构极简**：每帧输入编码为 2-4 字节（按键位掩码 + 摇杆量化值），绝不传输完整游戏状态
2. **输入累积桶（Accumulation Bucket）**：客户端将多帧输入累积到一个小桶中，按固定间隔（如每 50ms）批量发送，降低发包频率
3. **冗余重传机制**：每包携带最近 N 帧的历史输入，单个包丢失不会导致缺帧（接收方去重处理）
4. **服务端帧队列调度**：服务器收集所有客户端的输入，等齐后打包为"逻辑帧输入"广播给全体
5. **空帧补齐**：无输入时也发送"空输入"（全零位掩码），保持帧节奏不被打乱

### 📖 深度展开

#### 输入编码格式

帧同步的核心优势是带宽极低——每个玩家每帧只传输入，不传状态：

```
┌──────────────────────────────────────────┐
│  单帧输入 (Input Frame) — 仅 3 字节      │
├────────┬─────────────────────────────────┤
│ Byte 0 │ 按键位掩码 (Bitmask)            │
│        │ bit0=移动 bit1=攻击 bit2=跳跃   │
│        │ bit3=技能1 bit4=技能2 ...       │
├────────┼─────────────────────────────────┤
│ Byte 1 │ 摇杆X (int8, -127~127)         │
├────────┼─────────────────────────────────┤
│ Byte 2 │ 摇杆Y (int8, -127~127)         │
└────────┴─────────────────────────────────┘

│ 打包格式 (Batch Packet) ──────────────│
┌──────────┬────────────────────────────┐
│ startFrame│ uint16 — 本包起始帧号      │
│ frameCount│ uint8  — 包含多少帧输入    │
│ playerID  │ uint8  — 玩家标识          │
├──────────┴────────────────────────────┤
│ frame[0].input  (3 bytes)             │
│ frame[1].input  (3 bytes)             │
│ ...                                    │
│ frame[N-1].input (3 bytes)            │
└────────────────────────────────────────┘

│ 冗余头部 ──────────────────────────── │
┌──────────┬────────────────────────────┐
│ history  │ 最近 3 帧输入（冗余重传用） │
└──────────┴────────────────────────────┘
```

#### 客户端输入累积器实现

```csharp
public class InputAccumulator
{
    private struct FrameInput
    {
        public ushort frameId;
        public byte keyMask;
        public sbyte axisX;
        public sbyte axisY;
    }

    private readonly Queue<FrameInput> _pendingInputs = new();
    private readonly int _batchFrameCount = 3;   // 累积 3 帧打包一次
    private readonly float _batchInterval = 0.05f; // 或 50ms 打包一次
    private float _batchTimer = 0f;
    private ushort _currentFrameId = 0;

    // 冗余窗口：每包附带最近 3 帧输入
    private readonly FrameInput[] _recentInputs = new FrameInput[3];

    /// 每帧由游戏循环调用
    public void OnLocalFrame(byte keyMask, float axisX, float axisY)
    {
        var input = new FrameInput
        {
            frameId = _currentFrameId++,
            keyMask = keyMask,
            axisX = QuantizeAxis(axisX),
            axisY = QuantizeAxis(axisY),
        };
        _pendingInputs.Enqueue(input);
    }

    /// 按网络 tick 调用，决定是否发送
    public bool TryBuildPacket(out byte[] packet)
    {
        _batchTimer += Time.deltaTime;
        if (_batchTimer < _batchInterval || _pendingInputs.Count == 0)
        {
            packet = null;
            return false;
        }

        _batchTimer = 0;
        int count = Mathf.Min(_pendingInputs.Count, _batchFrameCount);
        using var ms = new MemoryStream(6 + count * 3);
        using var writer = new BinaryWriter(ms);

        var first = _pendingInputs.Peek();
        writer.Write(first.frameId);    // startFrame
        writer.Write((byte)count);      // frameCount
        writer.Write((byte)PlayerId);   // playerID

        // 写入当前批量帧
        for (int i = 0; i < count; i++)
        {
            var inp = _pendingInputs.Dequeue();
            writer.Write(inp.keyMask);
            writer.Write(inp.axisX);
            writer.Write(inp.axisY);
            // 更新冗余窗口
            _recentInputs[i % 3] = inp;
        }

        // 写入冗余帧（最近 3 帧，即使已在上面发过也再附一次）
        for (int i = 0; i < 3; i++)
        {
            if (_recentInputs[i].frameId > 0)
            {
                writer.Write(_recentInputs[i].frameId);
                writer.Write(_recentInputs[i].keyMask);
                writer.Write(_recentInputs[i].axisX);
                writer.Write(_recentInputs[i].axisY);
            }
        }

        packet = ms.ToArray();
        return true;
    }

    private static sbyte QuantizeAxis(float v) =>
        (sbyte)Mathf.Clamp(Mathf.RoundToInt(v * 127), -127, 127);
}
```

#### 服务器端输入聚合与广播

```
  Client A ──→ [Frame 100-102 Input] ──┐
  Client B ──→ [Frame 100-102 Input] ──┤
  Client C ──→ [Frame 100-102 Input] ──┤
                                        ↓
                            ┌────────────────────┐
                            │  Server Frame       │
                            │  Aggregator         │
                            │                    │
                            │  1. 等齐所有玩家    │
                            │     的 Frame 100   │
                            │  2. 打包为逻辑帧    │
                            │  3. 广播给全体      │
                            └────────────────────┘
                                        ↓
  Client A ←── [LogicFrame 100: A↑B←C○] ────
  Client B ←── [LogicFrame 100: A↑B←C○] ────
  Client C ←── [LogicFrame 100: A↑B←C○] ────
```

#### 丢包补偿对比

| 策略 | 带宽开销 | 丢包恢复速度 | 实现复杂度 |
|------|---------|------------|-----------|
| 无冗余（纯顺序） | 最低 | 慢（需等重传） | 低 |
| 冗余 3 帧（推荐） | +30% | 快（下包自带） | 中 |
| 冗余 5 帧 | +60% | 极快 | 中 |
| FEC 冗余编码 | +40% | 快 | 高 |
| ARQ 重传 | 视丢包率 | 慢（多 RTT） | 低 |

### ⚡ 实战经验

- **摇杆量化精度很重要**：int8（-127~127）对大多数游戏够用，但赛车/格斗游戏可能需要 int16，否则方向漂移会让手感变差
- **空帧必须发**：玩家不动时也要发送空输入，否则服务器无法推进逻辑帧。可以在协议层约定"无新输入"用 1 字节标志位表示，而非完整 3 字节
- **冗余帧数要匹配网络 RTT**：如果 RTT 约等于 N 帧时间，冗余帧数应 ≥ N。例如 60fps + 100ms RTT ≈ 6 帧，冗余 3-6 帧
- **延迟帧（Input Delay）与累积桶的关系**：Input Delay 是人为延迟第一帧的执行，本质上给累积桶更多时间收集输入。两者要配合调优

### 🔗 相关问题

- 帧同步的输入缓冲区延迟（Input Delay）如何调优？
- 当某玩家持续丢包导致服务器无法推进逻辑帧怎么办？超时跳帧策略如何设计？
- Lockstep 模式下，如何处理慢速客户端导致的全局卡顿？
