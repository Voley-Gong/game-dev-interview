---
title: "Rollback Netcode（回滚网络代码）是怎样的同步方案？GGPO 原理与实现"
category: "network"
level: 4
tags: ["Rollback", "GGPO", "格斗游戏", "同步策略", "延迟优化", "预测回滚"]
related: ["network/lockstep-implementation", "network/client-side-prediction", "network/frame-vs-state-sync"]
hint: "格斗游戏为什么感觉零延迟？秘密在于'先执行再回滚'——猜错了就倒带重来。"
---

## 参考答案

### ✅ 核心要点

1. **核心思想：乐观执行 + 检测到不一致时回滚重演**。本地输入立刻应用到游戏状态，不等远程输入到达——体感零延迟
2. **GGPO（Good Game Peace Out）** 是 rollback netcode 的经典开源实现，由 Tony Cannon（街机格斗社区）开发，现已被 Capcom、SNK 等正式采用
3. **回滚窗口（Rollback Window）**：通常保存过去 7~15 帧的状态快照，当远程输入到达后，从最早的分歧帧重新模拟（re-simulate）到当前帧
4. **状态序列化与恢复**：每帧需要能快速保存/恢复完整游戏状态（Savestate），要求游戏逻辑高度确定性
5. **与 Lockstep 的关键区别**：Lockstep 必须等所有输入到齐才推进（延迟高），Rollback 先跑再修正（延迟低但 CPU 开销大）

### 📖 深度展开

#### Rollback 执行流程

```
时间轴 (帧):    1    2    3    4    5    6    7
本地输入:      ✓    ✓    ✓    ✓    ✓    ✓    ✓
远程输入(预测): ?    ?    ?    ?    ✓    ✓    ✓  ← 前4帧用预测值

阶段1 - 乐观执行:
  帧1~4: 本地输入 + 预测远程输入 → 正常模拟前进
  帧5~7: 远程真实输入到达 → 正常模拟

阶段2 - 当帧4的远程真实输入到达时:
  发现预测 ≠ 真实输入！
  ① 保存当前状态 (帧7)
  ② 回滚到帧4的 Savestate
  ③ 用真实输入重新模拟 帧4 → 5 → 6 → 7
  ④ 对比新状态与旧状态，如有差异 → 触发画面修正

阶段3 - 渲染修正:
  在下一帧 VSync 前完成 re-simulation
  玩家看到的画面"闪"一下修正到正确状态
  (如果实现好，闪烁几乎不可见)
```

#### Lockstep vs Rollback vs CSP 对比

| 维度 | Lockstep（帧同步） | Rollback（回滚） | CSP（客户端预测） |
|------|-------------------|------------------|------------------|
| 等待远程输入 | ✅ 必须等 | ❌ 不等，先跑 | ❌ 不等 |
| 延迟体感 | 高（等最慢玩家） | 极低（本地即刻响应） | 低 |
| CPU 开销 | 低（只算一次） | 高（回滚后重算多帧） | 中 |
| 实现复杂度 | 中 | 非常高 | 高 |
| 适用类型 | RTS、回合制 | 格斗、动作格斗 | FPS、MOBA |
| 状态要求 | 确定性模拟 | 确定性 + 可快存快恢 | 服务器权威 |

#### GGPO 核心代码结构（伪代码）

```cpp
// GGPO Session 主循环
void GGPOSession::Update() {
    // 1. 从网络层拉取远程输入
    NetworkInput remoteInput = PollRemoteInput();

    // 2. 检查是否有更早的远程输入到达（验证过去的预测）
    if (remoteInput.frame < currentFrame) {
        // 预测错误！需要回滚
        int rollbackFrames = currentFrame - remoteInput.frame;

        // 保存当前状态
        SaveCurrentState();

        // 回滚到分歧帧
        RestoreState(remoteInput.frame);

        // 用正确的远程输入重新模拟到当前帧
        for (int f = remoteInput.frame; f <= currentFrame; f++) {
            AddRemoteInput(f, remoteInput);
            gameSim->Step(f);  // 确定性模拟一步
        }

        // 现在 currentFrame 的状态是正确的
    }

    // 3. 本地输入立即应用
    LocalInput local = GetLocalInput();
    AddLocalInput(currentFrame, local);

    // 4. 如果没有远程输入，用预测值
    if (!HasRemoteInput(currentFrame)) {
        PredictRemoteInput(currentFrame);  // 通常复制上一帧
    }

    // 5. 推进模拟
    gameSim->Step(currentFrame);
    SaveStateForRollback(currentFrame);  // 存快照供将来回滚

    currentFrame++;
}
```

#### 状态快照的工程挑战

```cpp
// 必须能序列化整个游戏状态
struct GameState {
    int frame;
    Fighter fighters[2];
    // 命中框、位移、血量、super槽、场景边界...
};

// 要求：
// 1. 每帧保存（环形缓冲区，存最近 N 帧）
// 2. 保存/恢复极快（目标 <1ms per save）
// 3. 高度确定性（重演结果一致）

class RollbackStateBuffer {
    RingBuffer<GameState, MAX_ROLLBACK_FRAMES> states; // 通常 7~15 帧

    void SaveFrame(int frame) {
        states[frame % MAX_ROLLBACK_FRAMES] = SerializeCurrentState();
    }

    void RestoreFrame(int frame) {
        RestoreFromState(states[frame % MAX_ROLLBACK_FRAMES]);
    }
};
```

#### 延迟优化技巧：Input Delay

```
无 Input Delay:
  帧 N: 玩家按下 → 帧 N 立即执行
  但如果远程输入在帧 N 到达且不同，需要从帧 N 回滚

有 2 帧 Input Delay:
  帧 N: 玩家按下 → 缓存，帧 N+2 才执行
  好处：多了 2 帧窗口等远程输入，减少回滚概率
  代价：本地操作有 2 帧延迟（~33ms@60fps，几乎不可感知）
```

### ⚡ 实战经验

1. **格斗游戏的 state save 必须覆盖所有可变状态**——漏掉一个变量（比如 hitstop 计数器、屏幕震动帧数）就会导致回滚后画面"抽搐"，这类 bug 极难排查
2. **回滚帧数要设上限**（通常 7~9 帧）。网络极端恶劣时，与其回滚 30 帧导致卡死，不如判定 desync 断线重连
3. **渲染层要配合做"平滑过渡"**：回滚后角色位置突变时，不要直接跳变，用 1~2 帧插值平滑过渡（叫做 "Rollback Smoothing"），否则玩家会看到"闪现"
4. **GGPO 的 `ggpo_backend.h` 接口设计精妙**——它把网络层和游戏模拟完全解耦，游戏只需要实现 `advance_frame()`、`save_game_state()`、`load_game_state()`、`get_game_inputs()` 四个回调。如果项目要集成 rollback，先抄这个接口设计

### 🔗 相关问题

- 帧同步（Lockstep）和回滚网络代码在实现上有什么具体差异？
- 如何为非确定性游戏（含物理引擎、随机数）实现 rollback？
- Rollback Netcode 在 4 人乱斗游戏（如《任天堂明星大乱斗》）中如何处理多端预测？
