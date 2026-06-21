---
title: "客户端预测与服务端调和（Client-Side Prediction & Server Reconciliation）如何实现？"
category: "network"
level: 4
tags: ["客户端预测", "服务端调和", "延迟补偿", "网络同步"]
related: ["network/frame-vs-state-sync", "network/lag-compensation"]
hint: "为什么在 100ms 延迟下 FPS 游戏依然感觉流畅？答案藏在预测与纠正的博弈中。"
---

## 参考答案

### ✅ 核心要点

1. **客户端预测**：玩家输入后客户端立即本地模拟，不等服务器返回，消除操作延迟感
2. **服务器权威**：服务器拥有最终裁决权，客户端预测只是"乐观估计"
3. **调和机制**：服务器返回权威结果后，客户端比对预测是否正确，不一致则回滚重演
4. **输入序列号**：每个操作携带递增序号，服务器用它确定哪些输入已被处理
5. **回滚重演（Rollback & Replay）**：纠正时回到错误发生点，用正确状态重放之后的所有输入

### 📖 深度展开

**为什么需要预测？**

```
无预测的 naive 方案（100ms RTT）：

玩家按下W键 → 发送服务器 → 等待100ms → 服务器返回新位置 → 客户端渲染
                                        ↑
                            玩家感受到100ms操作延迟，完全不可接受

有预测的方案：

玩家按下W键 → 客户端立即移动 → 同时发送服务器
                                ↓ 100ms后
              ← 服务器返回权威位置 ←
              ↓
         客户端比对：预测对了吗？
              ↓
         对 → 无感知，继续
         错 → 回滚到服务器位置，重演期间的输入
```

**核心实现代码（伪代码）：**

```csharp
// ============ 客户端 ============

struct PlayerState {
    public Vector3 position;
    public Vector3 velocity;
    public int sequenceNumber;  // 输入序列号
}

// 本地预测的状态缓冲（环形缓冲区）
private CircularBuffer<PlayerState> predictionBuffer = new(1024);
private int currentSeq = 0;

void OnPlayerInput(InputFrame input) {
    currentSeq++;

    // 1. 立即在客户端模拟
    ApplyInput(ref predictedState, input);
    predictedState.sequenceNumber = currentSeq;

    // 2. 存入预测缓冲，供后续调和使用
    predictionBuffer.Add(predictedState);

    // 3. 发送给服务器（不等回复）
    SendToServer(new NetInput {
        seq = currentSeq,
        input = input,
        timestamp = GetTime()
    });

    // 4. 立即渲染预测状态（零延迟反馈）
    Render(predictedState);
}

void OnServerReconciliation(ServerSnapshot snapshot) {
    // 服务器返回了 lastProcessedSeq 时的权威状态
    int serverSeq = snapshot.lastProcessedSeq;
    PlayerState serverState = snapshot.playerState;

    // 从缓冲区取出客户端在同一序列的预测
    var predicted = predictionBuffer.Get(serverSeq);

    if (predicted == null) return; // 太旧的快照，丢弃

    // 计算误差
    float error = Vector3.Distance(predicted.position, serverState.position);

    if (error < 0.01f) {
        // 预测正确，无需纠正
        return;
    }

    // 预测错误！需要回滚重演
    // 1. 回滚到服务器权威状态
    predictedState = serverState;

    // 2. 取出 serverSeq 之后的所有未确认输入，重新模拟
    for (int seq = serverSeq + 1; seq <= currentSeq; seq++) {
        var input = predictionBuffer.Get(seq);
        if (input != null) {
            ApplyInput(ref predictedState, input.input);
        }
    }

    // 3. 渲染纠正后的状态
    // 可以做平滑插值避免视觉跳变
    SmoothToPosition(predictedState.position);
}

// ============ 服务器 ============

int lastProcessedSeq = 0;
PlayerState authoritativeState;

void OnClientInput(NetInput netInput) {
    // 只处理最新序列的输入（丢弃过期的）
    if (netInput.seq <= lastProcessedSeq) return;

    lastProcessedSeq = netInput.seq;

    // 权威模拟
    ApplyInput(ref authoritativeState, netInput.input);

    // 定期发送快照（包含最新状态 + 已处理序列号）
    BroadcastSnapshot(new ServerSnapshot {
        playerState = authoritativeState,
        lastProcessedSeq = lastProcessedSeq
    });
}
```

**调和流程图：**

```
时间轴 ──────────────────────────────────────────────→

客户端  [输入#1] [输入#2] [输入#3] [输入#4] [输入#5]
         预测P1   预测P2   预测P3   预测P4   预测P5
                                              ↓
                                         收到服务器
                                         快照(seq=3)
                                         权威状态S3
                                              ↓
                                    比对 P3 vs S3
                                         ↓
                              ┌── 误差 < 阈值 ──→ 无需纠正
                              │
                              └── 误差 ≥ 阈值 ──→ 回滚到S3
                                                  重演 #4 #5
                                                  得到新P5'
                                                  平滑过渡
```

**平滑处理——避免视觉跳变：**

```csharp
// 纠正时的平滑过渡，避免角色"瞬移"
IEnumerator SmoothCorrection(Vector3 from, Vector3 to) {
    float duration = 0.1f;  // 100ms平滑
    float elapsed = 0f;

    while (elapsed < duration) {
        elapsed += Time.deltaTime;
        float t = elapsed / duration;

        // 使用 ease-out 曲线，开始快、结束慢
        float eased = 1f - Mathf.Pow(1f - t, 3f);
        transform.position = Vector3.Lerp(from, to, eased);
        yield return null;
    }

    transform.position = to;
}
```

### ⚡ 实战经验

- **预测窗口不宜过长**：超过 200ms 的预测会导致回滚时大幅跳变，体感很差。如果 RTT 超过 200ms，考虑降低模拟频率或增加插值缓冲
- **物理模拟的预测尤其困难**：涉及碰撞、物理引擎的预测容易和服务器产生分歧。建议客户端只预测简单的位移，物理碰撞由服务器裁决
- **其他玩家的移动绝不能预测**：只能对本地玩家做预测，其他玩家使用实体插值（Entity Interpolation）。预测别人的行为等于瞎猜
- **序列号溢出**：uint32 理论上够用，但长时间运行的 MMO 需要考虑回绕处理
- **调试利器**：开发时画一条预测轨迹线（红色）和服务器确认轨迹线（绿色），重合表示预测正确，偏离则直观可见

### 🔗 相关问题

- 延迟补偿（Lag Compensation）如何实现命中判定？
- 帧同步中的回滚（Rollback Netcode）与此有什么区别？
- 如何选择预测的模拟频率和渲染频率？
