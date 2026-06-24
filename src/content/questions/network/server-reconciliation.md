---
title: "客户端预测中的服务器和解（Server Reconciliation）是如何工作的？"
category: "network"
level: 3
tags: ["服务器和解", "客户端预测", "状态同步", "延迟补偿"]
related: ["network/client-side-prediction", "network/entity-interpolation", "network/lag-compensation"]
hint: "预测不可避免会有误差，服务器如何'纠正'客户端而不让玩家感受到跳变？"
---

## 参考答案

### ✅ 核心要点

1. **预测-确认循环**：客户端执行输入预测，服务器返回权威结果，客户端比对并修正差异
2. **序列号机制**：每个输入包携带递增序列号，服务器回执中包含已处理到的序列号
3. **回滚-重放（Rollback & Replay）**：发现差异时，将状态回滚到上一个确认帧，用缓冲的输入重新模拟
4. **阈值平滑**：微小误差用插值修正，大误差才做硬修正，避免视觉跳变
5. **抖动控制**：通过平滑因子和速度匹配让修正过程对玩家不可见

### 📖 深度展开

#### 为什么需要 Server Reconciliation？

在服务器权威架构下，客户端发送输入到服务器、服务器计算结果再返回，至少经历一个 RTT 的延迟。如果客户端等服务器结果才更新画面，玩家会明显感受到操作滞后。

**Client-Side Prediction（CSP）** 让客户端在发送输入后立即本地模拟预测结果。但预测可能出错（其他玩家交互、服务器修正逻辑等），所以需要 **Server Reconciliation** 来纠正偏差。

#### 完整数据流

```
客户端                          服务器
  │                               │
  ├─ Input(seq=42) ──────────────→│
  │  本地预测模拟                   │ 权威模拟
  │  state_predicted[42]          │ state_authoritative[42]
  │                               │
  │←── Snapshot(lastAckedSeq=42)──┤
  │                               │
  │ 1. 比较 state_predicted[42]    │
  │    vs state_authoritative[42] │
  │                               │
  │ 2. 如果一致 → 预测正确 ✅      │
  │    如果不一致 → 执行和解       │
  │                               │
  │ 3. 回滚到 seq=41（已确认帧）  │
  │ 4. 重放 seq=42 的输入          │
  │ 5. 重新模拟到当前帧            │
  │ 6. 平滑过渡到新状态            │
  └───────────────────────────────┘
```

#### 序列号与输入缓冲

```csharp
// 客户端：输入缓冲 + 序列号管理
public class ClientPrediction {
    private uint currentSeq;           // 当前输入序列号
    private Dictionary<uint, InputState> pendingInputs = new();  // 未确认的输入
    private Dictionary<uint, SimulationState> predictedStates = new();  // 预测状态

    public void SendInput(InputState input) {
        currentSeq++;
        input.Seq = currentSeq;
        pendingInputs[currentSeq] = input;

        // 立即执行预测模拟
        var predicted = Simulate(GetCurrentState(), input);
        predictedStates[currentSeq] = predicted;
        SetCurrentState(predicted);

        // 发送到服务器（可靠通道）
        SendToServer(input);
    }

    public void OnServerSnapshot(Snapshot snap) {
        uint ackedSeq = snap.LastProcessedSeq;

        // 移除已确认的输入
        // pendingInputs 中 seq <= ackedSeq 的都是已处理过的

        // 比较预测状态和权威状态
        if (predictedStates.TryGetValue(ackedSeq, out var predState)) {
            float error = ComputeError(predState, snap.State);

            if (error > RECONCILE_THRESHOLD) {
                // 预测出错了，需要和解
                Reconcile(ackedSeq, snap.State);
            } else {
                // 微小误差，平滑修正
                SmoothCorrect(snap.State);
            }
        }
    }

    private void Reconcile(uint ackedSeq, SimulationState authoritative) {
        // 1. 重置到权威状态
        SetCurrentState(authoritative);

        // 2. 重放所有未确认的输入（seq > ackedSeq）
        var inputsToReplay = pendingInputs
            .Where(kv => kv.Key > ackedSeq)
            .OrderBy(kv => kv.Key)
            .ToList();

        foreach (var kv in inputsToReplay) {
            var state = Simulate(GetCurrentState(), kv.Value);
            predictedStates[kv.Key] = state;
            SetCurrentState(state);
        }
    }

    private float ComputeError(SimulationState a, SimulationState b) {
        // 位置误差（单位：米）
        float posError = Vector3.Distance(a.Position, b.Position);
        // 速度误差
        float velError = Vector3.Distance(a.Velocity, b.Velocity);
        return posError + velError * 0.5f;
    }
}
```

#### 误差修正策略对比

| 策略 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| 硬修正（Snap） | 大位移偏差（>2m） | 立即正确 | 玩家可见跳变 |
| 线性插值修正 | 中等偏差（0.2~2m） | 平滑过渡 | 修正周期内仍有偏差 |
| 速度匹配修正 | 小偏差（<0.2m） | 几乎不可见 | 收敛速度慢 |
| 弹簧修正（Spring） | 通用 | 自然平滑 | 需要调参 |

#### 和解抖动（Reconciliation Jitter）问题

当服务器频繁返回微小的修正，客户端画面会出现不自然的抖动。常见解决方案：

```
// 伪代码：基于弹簧的平滑修正
function SmoothReconcile(currentState, serverState, dt):
    posDiff = serverState.pos - currentState.pos
    velDiff = serverState.vel - currentState.vel

    // 弹簧-阻尼系统
    stiffness = 10.0    // 刚度：越大收敛越快
    damping = 0.85      // 阻尼：越大振荡越小

    correctionForce = posDiff * stiffness
    currentState.vel += correctionForce * dt
    currentState.vel *= damping

    // 限制最大修正速度，避免突然弹射
    maxCorrectSpeed = 5.0  // m/s
    if length(currentState.vel) > maxCorrectSpeed:
        currentState.vel = normalize(currentState.vel) * maxCorrectSpeed
```

### ⚡ 实战经验

- **序列号溢出**：`uint` 序列号在长时间运行后会溢出，用 `uint` 而非 `int`，并在比较时处理回绕（wrap-around），或者周期性地做全量状态同步来重置序列号
- **输入缓冲膨胀**：高延迟下 `pendingInputs` 会积累大量未确认输入，重放成本很高。限制最大重放帧数（如 30 帧），超过则直接硬修正
- **确定性模拟**：和解的前提是客户端和服务器跑相同的模拟逻辑。如果客户端用了物理引擎（如 PhysX/Box2D），浮点不确定性会导致预测永远不一致——考虑定点数或逻辑帧分离
- **混合策略**：实际项目中通常对位置用平滑修正、对生命值等离散值用硬修正。不要对所有状态用同一种修正策略

### 🔗 相关问题

- 客户端预测（CSP）的实现要点是什么？如何减少预测错误率？
- 帧同步模式需要 Server Reconciliation 吗？为什么？
- 如何在物理引擎驱动的游戏中实现确定性模拟以保证和解正确性？
