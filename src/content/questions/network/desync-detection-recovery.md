---
title: "如何检测和恢复网络游戏中的状态失同步（Desync Detection & Recovery）？"
category: "network"
level: 4
tags: ["失同步", "Desync", "一致性校验", "状态恢复", "帧同步", "状态同步"]
related: ["network/state-convergence-conflict-resolution", "network/deterministic-rng-lockstep", "network/reconnect-state-recovery"]
hint: "帧同步的噩梦是静默 Desync——玩家还在玩，但两端看到的已经不一样了。如何尽早发现？"
---

## 参考答案

### ✅ 核心要点

1. **Desync 定义**：不同客户端/服务器的游戏状态产生分歧，且持续扩大无法自愈
2. **帧同步检测**：每帧/每 N 帧计算状态哈希（checksum），通过服务器比对所有客户端哈希
3. **状态同步检测**：服务器权威模型下，持续监控客户端状态与服务器快照的偏差是否超阈值
4. **恢复策略**：轻量级（增量纠正包）→ 中量级（状态快照重放）→ 重量级（全量重新同步）
5. **预防优于治疗**：确定性模拟、输入验证、浮点一致性是帧同步防 Desync 的根基

### 📖 深度展开

#### 帧同步中的 Desync 检测（Checksum 方案）

```
每帧执行流程:
  1. 所有客户端执行相同逻辑帧
  2. 计算当前世界状态的 CRC32 / Hash
  3. 将 hash 发给服务器（或 host）
  4. 服务器比对所有客户端 hash

           Frame 100
  Client A: hash=0xAB12  ──►  Server
  Client B: hash=0xAB12  ──►  ✓ Match
  Client C: hash=0xCD34  ──►  ✗ DESYNC DETECTED!
```

```cpp
// 状态哈希计算（需要覆盖所有影响确定性的状态）
uint32_t ComputeStateHash(const GameState& state) {
    CRC32 crc;
    // 遍历所有实体
    for (auto& entity : state.entities) {
        crc.Update(entity.id);
        crc.Update(entity.position.x);  // 必须是定点数！
        crc.Update(entity.position.y);
        crc.Update(entity.health);
        crc.Update(entity.stateFlags);
    }
    // 全局状态
    crc.Update(state.frameCount);
    crc.Update(state.randomSeed);  // RNG 状态
    return crc.Finalize();
}

// 定期检测（不必每帧，每 10-30 帧即可）
void CheckDesync(int frame, uint32_t localHash) {
    if (frame % CHECK_INTERVAL == 0) {
        network.SendDesyncCheck(frame, localHash);
    }
}
```

#### 状态哈希的采样策略

| 策略 | 频率 | 优点 | 缺点 |
|------|------|------|------|
| 每帧哈希 | 每帧 | 最快发现 | CPU 开销大 |
| 定期哈希 | 每 10-30 帧 | 开销小 | 发现延迟 |
| 关键事件哈希 | 触发时 | 零额外开销 | 可能漏检 |
| 混合方案 | 定期 + 关键事件 | 平衡 | 实现稍复杂 |

#### Desync 恢复策略

```
┌──────────────────────────────────────────────────┐
│              Desync 严重程度分级                   │
├──────────────────────────────────────────────────┤
│                                                  │
│  Level 1: 轻微偏差（位置差 < 阈值）               │
│  → 发送状态纠正包（State Correction Packet）      │
│  → 客户端 Snap 到正确状态                        │
│                                                  │
│  Level 2: 中等偏差（逻辑不一致）                   │
│  → 发送增量快照（Delta Snapshot）                │
│  → 客户端重放最近 N 帧的输入                      │
│                                                  │
│  Level 3: 严重偏差（哈希完全不同）                 │
│  → 发送全量状态快照                              │
│  → 客户端清空本地状态，从快照重建                  │
│  → 短暂卡顿（可显示"正在同步..."）               │
│                                                  │
│  Level 4: 不可恢复                               │
│  → 强制断线重连                                  │
│                                                  │
└──────────────────────────────────────────────────┘
```

#### 帧同步的回滚恢复（Rollback Recovery）

```cpp
// 客户端收到 Desync 通知后的恢复流程
void OnDesyncDetected(int desyncFrame, Snapshot& correctState) {
    // 1. 回滚到 desyncFrame 之前的状态
    stateRestore.RestoreToFrame(desyncFrame - 1);
    
    // 2. 应用服务器发来的正确状态
    ApplySnapshot(correctState);
    
    // 3. 重放本地输入缓冲区中 desyncFrame 之后的所有输入
    for (int f = desyncFrame; f <= currentFrame; f++) {
        auto& inputs = inputBuffer.GetInputs(f);
        SimulateFrame(f, inputs);
    }
    
    // 4. 如果重放后哈希仍然不匹配，升级到 Level 3
    if (ComputeStateHash(state) != correctState.hash) {
        RequestFullSnapshot();
    }
}
```

#### 状态同步中的偏差检测

```cpp
// 服务器持续监控客户端状态偏差
void Server::CheckClientDeviation(ClientId client, ClientStateReport& report) {
    const ServerEntity& serverEntity = GetEntity(report.entityId);
    
    float positionError = 
        Distance(serverEntity.position, report.position);
    
    if (positionError > SOFT_THRESHOLD) {
        // 发送纠正包，温和纠正
        SendCorrection(client, serverEntity);
    } 
    else if (positionError > HARD_THRESHOLD) {
        // 强制重置客户端状态
        SendForcedReset(client, serverEntity);
        LogWarning("Client %d desync: pos error %.1f", 
                   client, positionError);
    }
}
```

#### 测试与调试

```
Desync 调试工具链:
  ├── 录制系统：每帧保存状态 + 输入（用于事后回放）
  ├── 差异可视化：将两个客户端状态并排渲染，高亮差异
  ├── 确定性验证：AI vs AI 无网络运行，验证哈希一致性
  └── 最小复现：二分法找到第一个产生分歧的帧
```

### ⚡ 实战经验

- **浮点是帧同步 Desync 的头号杀手**：不同 CPU 架构的浮点结果可能不同（FPU vs SSE vs NEON），帧同步游戏必须用定点数或软件浮点库
- **哈希不要遗漏 RNG 状态**：随机数生成器的内部状态是隐藏的 Desync 源，务必把 RNG seed/state 纳入哈希
- **Desync 发现越早恢复成本越低**：在 100 帧后发现 vs 在 5 帧后发现，恢复体验天差地别，建议检测间隔不超过 30 帧
- **保留输入日志用于根因分析**：Desync 的根因往往是一个未处理好的边界条件，有输入日志才能复现和修复

### 🔗 相关问题

- 帧同步中如何保证浮点运算的跨平台确定性？
- 断线重连后如何快速恢复到当前游戏状态？
- 如何设计状态快照使恢复时的卡顿最小化？
