---
title: "帧同步中客户端掉线重连后如何快进追帧（Catch-Up Resync）？"
category: "network"
level: 4
tags: ["帧同步", "断线重连", "快进追帧", "确定性模拟", "Lockstep", "面试中高频率"]
related: ["network/lockstep-implementation", "network/reconnect-state-recovery", "network/deterministic-rng-lockstep"]
hint: "帧同步游戏断线 10 秒后重连——怎么在不影响其他玩家的前提下追回几百帧？"
---

## 参考答案

### ✅ 核心要点

1. **核心思路：服务端发送关键帧快照 + 输入日志，客户端在"加速模式"下重演到当前帧**
2. **追帧速度受限于确定性模拟的执行性能**：纯逻辑模拟可以 10x+ 加速，但有 UI/渲染参与时会变慢
3. **追帧期间冻结玩家输入**：重连客户端在追帧期间不接受用户操作，追上后才恢复
4. **带宽优化：只发送缺失帧的输入差量 + 最近一个关键帧快照**，而非全部历史
5. **追帧完成检测**：客户端追到服务端当前帧号后，发 `RESYNC_COMPLETE`，服务端将其状态标记为活跃

### 📖 深度展开

#### 追帧流程全图

```
客户端掉线 (Frame 500)
      |
      v
[断线 10秒]                    服务端继续推进
      |                         Frame 500 → 501 → ... → 700
      v
客户端重连 (Frame 500)
      |
      v
发送 RESYNC_REQUEST (lastFrame=500)
      |
      v
服务端响应:
  ├── 关键帧快照 @ Frame 500 (或最近的关键帧)
  ├── 输入日志 Frame 501~700
  └── 当前帧号 Frame 700
      |
      v
客户端进入"追帧模式":
  ├── 加载快照 @ Frame 500
  ├── 关闭渲染（或低频渲染）
  ├── 关闭音效
  ├── 以 maxSpeed 执行确定性模拟:
  │     for (f = 501; f <= 700; f++) {
  │         loadInputs(inputLog[f]);
  │         simulateOneFrame();  // 纯逻辑，无渲染
  │     }
  └── 追完 → 发 RESYNC_COMPLETE
      |
      v
服务端: 将客户端标记为活跃，开始正常推帧
客户端: 恢复渲染/音效/输入，正常游戏
```

#### 快照 + 输入日志的序列化

```cpp
struct ResyncPacket {
    uint32_t snapshotFrame;      // 快照对应帧号
    uint32_t currentFrame;       // 服务端当前帧号
    Snapshot  snapshot;          // 关键帧完整状态
    // 输入日志：每帧每个玩家的操作
    InputEntry inputLog[];       // [snapshotFrame+1, currentFrame]
};

struct InputEntry {
    uint32_t frame;
    uint8_t  playerMask;         // 哪些玩家有输入
    uint32_t inputs[];           // 每个 mask 位的输入编码
};
```

#### 追帧性能优化策略

| 策略 | 说明 | 加速效果 |
|------|------|----------|
| 跳过渲染 | 追帧期间不调用渲染管线 | 5-10x |
| 跳过音效 | 不触发音频播放 | 1.2x |
| 跳过动画 | 不更新动画状态机（纯逻辑不需要表现） | 1.5x |
| 倍速物理 | 禁用物理 debug 绘制，关闭碰撞回调 | 1.3x |
| 预编译快照 | 快照直接 memcpy 到模拟状态，避免逐字段反序列化 | 减少追帧启动延迟 |
| 分帧追帧 | 每帧追 50 帧 → 14 帧追完 700 帧，不阻塞主线程 | 平滑体验 |

```cpp
// 分帧追帧：避免一次追 700 帧导致卡顿
void ResyncController::update() {
    if (state_ != RESYNC_CATCHING_UP) return;

    int framesThisTick = 0;
    const int MAX_FRAMES_PER_TICK = 50;

    while (targetFrame_ > currentFrame_ &&
           framesThisTick < MAX_FRAMES_PER_TICK) {
        auto& inputs = inputLog_[currentFrame_ + 1];
        simulation_->step(inputs);
        currentFrame_++;
        framesThisTick++;
    }

    if (currentFrame_ >= targetFrame_) {
        state_ = RESYNC_COMPLETE;
        sendResyncComplete();
        restoreRendering();
    }
}
```

#### 关键帧（Keyframe）间隔的权衡

- **间隔太小（如每 30 帧）**：快照占用带宽大，但追帧快
- **间隔太大（如每 600 帧）**：追帧要从很久之前重演，耗时久
- **推荐值**：每 100-200 帧存一个关键帧（约 2-3 秒），平衡带宽和追帧速度

```
关键帧间隔 vs 追帧时间（假设 60fps，追帧速度 300fps）：

间隔 100帧(1.7s):  最多追 100帧 → 0.33s    带宽: ~50KB/snapshot
间隔 300帧(5s):    最多追 300帧 → 1.0s     带宽: ~17KB/snapshot(均摊)
间隔 600帧(10s):   最多追 600帧 → 2.0s     带宽: ~8KB/snapshot(均摊)
```

#### 边界情况处理

```
情况1: 断线时间过长（> 60秒）
  → 放弃追帧，直接加载最新快照，告知玩家"你已被旁观"
  → 可能需要重生逻辑（实体已被销毁）

情况2: 追帧过程中又收到新的帧输入
  → 追帧目标帧号需要持续更新：targetFrame = serverCurrentFrame
  → 如果追帧速度 < 服务端推帧速度，永远追不上
  → 解决：追帧期间不接收实时帧，追完后再接

情况3: 多人同时断线重连
  → 服务端需要为每个重连客户端维护独立的输入日志窗口
  → 限制同时重连的客户端数量，避免输入日志广播风暴
```

### ⚡ 实战经验

- **确定性是追帧正确的前提**：如果追帧后状态和服务端不一致，说明确定性被破坏了（浮点数、随机数、遍历顺序）。在追帧模式下加入状态校验，发现不一致立刻报错
- **追帧期间的内存管理**：200 帧的输入日志可能很小，但如果快照包含大量实体状态，内存会暴涨。考虑流式加载快照
- **用户体验**：追帧时显示"正在同步游戏状态... 进度 45%"，比直接卡屏好很多。大型比赛场景下，追帧超过 5 秒应考虑给玩家观战选项
- **输入日志压缩**：用 BitStream 编码输入（每玩家每帧通常只有几 bit），200 帧输入日志通常不到 1KB

### 🔗 相关问题

- 如何保证帧同步的确定性模拟严格一致？
- 断线重连时如何处理实体生命周期变化（新生/死亡）？
- 追帧过程中如果服务端又断线了怎么处理？
