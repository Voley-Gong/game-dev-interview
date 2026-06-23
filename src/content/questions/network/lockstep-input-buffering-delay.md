---
title: "帧同步的输入缓冲区如何设计？延迟帧、Input Delay 与 Stall 恢复如何调优？"
category: "network"
level: 3
tags: ["帧同步", "Lockstep", "输入缓冲", "Input Delay", "帧队列", "卡顿恢复"]
related: ["network/lockstep-implementation", "network/deterministic-physics-lockstep", "network/jitter-buffer-design"]
hint: "帧同步的输入延迟设几帧最合适？缓冲区大了手感差，小了容易卡顿——这是个延迟 vs 稳定的权衡问题。"
---

## 参考答案

### ✅ 核心要点

1. **输入缓冲区（Input Buffer）**：收集所有玩家的输入，等到某个逻辑帧的全部输入到齐后才执行模拟，是帧同步的核心同步机制
2. **Input Delay（输入延迟）**：本方输入不立即执行，而是延迟 N 帧后再提交到逻辑帧队列，用人为延迟换取等待远端输入的容错窗口
3. **Stall（停顿）**：当缓冲区内某帧的输入不完整时，模拟暂停等待，表现为游戏卡顿；需要合理缓冲策略来最小化 Stall 概率
4. **延迟校准**：根据网络 RTT 动态调整 Input Delay 帧数，在低延迟网络下减少延迟提升手感，在高延迟网络下增加缓冲防止卡顿
5. **Rollback 兜底**：当 Stall 不可避免时，配合回滚机制（先用预测输入跑，收到真实输入后回滚修正）来保持流畅度

### 📖 深度展开

#### 帧同步执行模型

```
逻辑帧队列执行流程：

  Tick 1: [P1输入✓] [P2输入✓] [P3输入✓] → 执行 Tick 1 ✓
  Tick 2: [P1输入✓] [P2输入✓] [P3输入✗] → 等待...
  Tick 3: [P1输入✓] [P2输入✗] [P3输入✗] → 等待...

  ↑ P3 的 Tick 2 输入未到达，Tick 2 Stall
  ↑ Tick 3 也被阻塞，模拟暂停

加入 Input Delay = 2 后：

  当前渲染帧 = 100
  收到输入的目标帧 = 100 + 2 = 102

  Tick 102: [P1✓] [P2✓] [P3✓] → 全部到齐，执行
  Tick 103: [P1✓] [P2✓] [P3✓] → 全部到齐，执行

  → 2 帧的容错窗口，轻微网络抖动不会导致 Stall
```

#### 缓冲区数据结构

```
┌─────────────────────────────────────────────────────────┐
│                Input Buffer（环形队列）                   │
│                                                         │
│   Tick │  P1 Input  │  P2 Input  │  P3 Input  │ Status │
│  ──────┼────────────┼────────────┼────────────┼────────│
│   100  │ Move(1,0)  │ Idle()     │ Atk(ID=7)  │ Ready  │
│   101  │ Move(1,0)  │ Jump()     │   (空)     │ Wait   │
│   102  │   (空)     │   (空)     │   (空)     │ Empty  │
│  ──────┴────────────┴────────────┴────────────┴────────│
│                                                         │
│  Head Pointer = 101 (下一个待执行帧)                     │
│  InputDelay = 2 帧                                      │
│  MaxBufferSize = 20 帧（防溢出）                         │
└─────────────────────────────────────────────────────────┘
```

#### 核心代码实现

```csharp
// ============ 输入缓冲区管理器 ============
public class LockstepInputBuffer
{
    // 每帧每个玩家的输入
    private struct FrameInputs
    {
        public int Tick;
        public Dictionary<int, PlayerInput> Inputs; // playerId → input
        public bool IsComplete(MaxPlayers) => Inputs.Count >= MaxPlayers;
    }

    private readonly int _maxPlayers;
    private readonly int _inputDelay;           // 人为延迟帧数
    private readonly int _maxBufferFrames = 20;  // 缓冲上限

    // 环形缓冲：tick → FrameInputs
    private readonly Dictionary<int, FrameInputs> _buffer = new();
    private int _executedTick;   // 已执行到的帧
    private int _latestLocalTick; // 本地最新提交帧

    // 提交本地输入（延迟 inputDelay 帧后生效）
    public void SubmitLocalInput(PlayerInput input, int currentRenderTick)
    {
        int targetTick = currentRenderTick + _inputDelay;
        if (!_buffer.ContainsKey(targetTick))
            _buffer[targetTick] = new FrameInputs { Tick = targetTick, Inputs = new() };

        _buffer[targetTick].Inputs[LocalPlayerId] = input;
        // 同时发送给服务器（或 P2P 广播）
        Network.Send(new InputPacket(targetTick, LocalPlayerId, input));

        _latestLocalTick = Math.Max(_latestLocalTick, targetTick);
    }

    // 接收远端输入
    public void ReceiveRemoteInput(int tick, int playerId, PlayerInput input)
    {
        if (tick <= _executedTick)
        {
            // 过期输入：已执行过该帧，需要 Rollback
            TriggerRollback(tick, playerId, input);
            return;
        }

        if (!_buffer.ContainsKey(tick))
            _buffer[tick] = new FrameInputs { Tick = tick, Inputs = new() };

        _buffer[tick].Inputs[playerId] = input;
    }

    // 每帧调用：尝试推进模拟
    public bool TryStep(out int tickToExecute)
    {
        int nextTick = _executedTick + 1;
        tickToExecute = nextTick;

        if (_buffer.TryGetValue(nextTick, out var frame) && frame.IsComplete(_maxPlayers))
        {
            _executedTick = nextTick;
            // 清理过旧缓冲
            CleanupOldFrames(nextTick - _maxBufferFrames);
            return true;
        }

        // Stall：输入不完整，无法推进
        return false;
    }

    // 自适应延迟调整
    public int CalculateOptimalDelay(float rttMs, int tickRate)
    {
        float tickIntervalMs = 1000f / tickRate;
        // RTT 一半 = 单程延迟；需要覆盖单程 + 1 帧抖动余量
        int delay = Mathf.CeilToInt((rttMs * 0.5f) / tickIntervalMs) + 1;
        return Mathf.Clamp(delay, 1, 6); // 通常 1~6 帧
    }
}

// ============ 主循环集成 ============
public class LockstepGameLoop : MonoBehaviour
{
    private LockstepInputBuffer _inputBuffer;
    private DeterministicSimulator _simulator;
    private float _accumulator;
    private float _fixedDt = 1f / 30f; // 30Hz 逻辑帧

    void Update()
    {
        _accumulator += Time.deltaTime;

        // 提交本地输入
        if (Input.anyKey)
        {
            _inputBuffer.SubmitLocalInput(CaptureInput(), _simulator.CurrentTick);
        }

        // 固定步长推进
        while (_accumulator >= _fixedDt)
        {
            _accumulator -= _fixedDt;

            if (_inputBuffer.TryStep(out int tick))
            {
                // 输入齐全，执行确定性模拟
                var inputs = _inputBuffer.GetInputs(tick);
                _simulator.Step(_fixedDt, inputs);
            }
            else
            {
                // Stall！可选策略：
                // A. 等待（卡顿但保证确定性）
                // B. 用上帧输入预测（需 Rollback 机制配合）
                OnStall(tick);
                break; // 跳出 while，等下一帧再试
            }
        }
    }
}
```

#### Input Delay 与 RTT 的关系

| RTT 范围 | 推荐 Input Delay（30Hz） | 效果 |
|----------|------------------------|------|
| < 33ms（LAN） | 1 帧 | 极佳手感 |
| 33-66ms | 2 帧 | 良好 |
| 66-100ms | 3 帧 | 可接受 |
| 100-150ms | 4-5 帧 | 有明显延迟感 |
| > 150ms | 不建议帧同步 | 考虑切状态同步 |

#### Stall 恢复策略对比

| 策略 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **Wait（纯等待）** | 输入不齐就不跑 | 100% 确定性 | 卡顿明显 |
| **Repeat Last（重复上帧）** | 用上一帧输入预测 | 无卡顿 | 预测错误需 Rollback |
| **Extrapolate（外推）** | 根据历史输入趋势预测 | 较流畅 | 复杂输入容易错 |
| **GGPO Rollback** | 先预测跑，收到后回滚修正 | 最佳手感 | 回滚有开销 |

### ⚡ 实战经验

- **Input Delay 宁可多 1 帧也不要少**：少 1 帧的延迟对玩家感知影响极小，但 Stall 一次的卡顿感非常明显。在 RTT 波动 ±20ms 的网络中，多 1 帧缓冲是值得的保险
- **动态调整 Input Delay 是双刃剑**：RTT 突然变大时增加 delay 容易理解，但 RTT 恢复后减少 delay 时，已经在缓冲区中的旧 delay 帧怎么处理？实践中通常只在比赛/回合开始时固定 delay，中途不调
- **观众/回放模式不需要 Input Delay**：因为所有输入已经确定，直接顺序执行即可。别在观战系统里也套 Input Delay
- **断线玩家的输入处理要特殊对待**：约定断线玩家使用"空闲输入"（不操作），等待 5-10 帧后仍未重连则冻结该玩家或触发 AI 接管。不要因为一个断线玩家 Stall 整局游戏

### 🔗 相关问题

- GGPO Rollback 是如何将 Stall 概率降到最低的？回滚深度怎么设？
- 帧同步中如何处理玩家掉线后的模拟继续？
- 不同玩家 RTT 差异很大时，Input Delay 取最大值还是平均值？
