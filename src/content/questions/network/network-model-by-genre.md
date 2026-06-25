---
title: "不同游戏类型（FPS/MOBA/RTS/格斗/MMO）的网络同步模型有何区别？如何选型？"
category: "network"
level: 3
tags: ["同步模型", "游戏类型", "FPS", "MOBA", "RTS", "格斗", "MMO", "架构选型"]
related: ["network/frame-vs-state-sync", "network/rollback-netcode", "network/server-authority-vs-client-trust", "network/client-side-prediction"]
hint: "FPS 用状态同步+延迟补偿，MOBA 用状态同步+客户端预测，RTS 用锁步帧同步，格斗用回滚网络——为什么不能统一用一种？"
---

## 参考答案

### ✅ 核心要点

1. **FPS（CS/Valorant）**：服务器权威状态同步 + Client-Side Prediction + Lag Compensation，强调命中准确
2. **MOBA（LOL/Dota2）**：服务器权威状态同步 + 客户端平滑插值，低频率（10-30Hz）但高一致性
3. **RTS（星际/帝国时代）**：Lockstep 帧同步，只传输入指令（每帧几字节），所有客户端独立模拟
4. **格斗（街霸/GGPO）**：Rollback Netcode（回滚网络），先本地预测执行，收到远端输入后回滚修正
5. **MMO（WOW/Final Fantasy XIV）**：Zone Server 分区 + 状态同步 + AOI 兴趣区域过滤，容忍高延迟

### 📖 深度展开

#### 五大类型同步模型对比

```
延迟容忍度：格斗(16ms) < FPS(50ms) < MOBA(100ms) < RTS(150ms) < MMO(200ms+)
带宽压力：  RTS(低) < 格斗(低) < MOBA(中) < FPS(高) < MMO(极高)
作弊容忍度：MMO(中) < MOBA(低) < FPS(极低) < 格斗(P2P无服务)
```

| 维度 | FPS | MOBA | RTS | 格斗 | MMO |
|------|-----|------|-----|------|-----|
| 同步模型 | 状态同步 | 状态同步 | Lockstep 帧同步 | Rollback 帧同步 | 状态同步 |
| 服务器权威 | ✅ 必须 | ✅ 必须 | ❌ P2P/中继 | ⚠️ 可选 | ✅ Zone Server |
| 同步频率 | 30-64 Hz | 10-30 Hz | 固定逻辑帧 | 每帧(60Hz) | 5-15 Hz |
| 单包大小 | 中(位置+状态) | 中(全实体快照) | 极小(输入指令) | 小(输入帧) | 大(但 AOI 过滤后小) |
| 预测/回滚 | CSP + Reconcile | 轻量预测 | 无预测 | 回滚重模拟 | 几乎无预测 |
| 反作弊重点 | 命中验证/透视检测 | 地图全亮检测 | 地图作弊(困难) | 输入注入检测 | 速度/数值校验 |
| 典型延迟预算 | 50-100ms | 80-150ms | 100-250ms | 16-80ms | 150-300ms |

#### FPS：状态同步 + 延迟补偿

```
客户端操作流程：
1. 玩家开枪 → Client 本地立刻播放动画（预测）
2. 开枪指令发服务器 → Server 验证命中（Lag Compensation）
3. Server 回传结果 → Client 修正（Reconciliation）

为什么不用帧同步？
- FPS 60Hz 全实体状态太重（大地图100+实体）
- 延迟补偿需要服务器权威，P2P 无法防作弊
- 客户端预测能让本地操作零延迟，体验好
```

#### RTS：Lockstep 帧同步

```
所有客户端执行完全相同的指令序列：
Turn 1: [Player A: Build Barracks, Player B: Scout]
Turn 2: [Player A: Train 5 Marines, Player B: Retreat]
Turn 3: [Player A: Attack-move, Player B: Build Tower]

核心约束：
- 确定性模拟（同输入→同输出）
- 浮点数禁止（用定点数）
- 容器遍历顺序固定（用有序容器）
- 随机数统一种子 + 统一消费序列
```

```csharp
// RTS 帧同步核心循环
void FixedUpdate() {
    // 1. 收集本帧本地输入
    var myInput = CollectLocalInput();

    // 2. 发给所有其他客户端
    SendInputToPeers(currentTurn, myInput);

    // 3. 等待所有玩家的本帧输入到达
    if (!AllInputsReceived(currentTurn)) {
        // 暂停等待（Stall）——帧同步的核心特征
        return;
    }

    // 4. 合并输入，确定性执行
    var allInputs = GetMergedInputs(currentTurn);
    deterministicSimulator.Simulate(allInputs);

    // 5. 推进到下一帧
    currentTurn++;
}
```

#### 格斗：Rollback Netcode（回滚）

```
原理：预测→执行→回滚→重模拟

Turn N: 本地输入已知，远端输入未知
  → 先用上帧远端输入做预测，本地立即执行
Turn N+1: 收到远端 Turn N 真实输入
  → 检查是否与预测一致
  → 不一致：回滚到 Turn N，用正确输入重新模拟 Turn N 和 N+1
  → 一致：无需回滚
```

#### MOBA：状态同步的折中设计

```
MOBA 特殊需求：
- 10 个玩家 + 100+ 小兵/野怪/技能
- 不能用帧同步（确定性太脆弱，崩溃=所有人掉线）
- 不能用纯 FPS 方案（实体太多，带宽爆炸）

折中方案：
- 服务器权威状态同步（10-20Hz 快照）
- 客户端做死 reckoning 平滑插值
- 技能命中由服务器判定（反作弊）
- 视野系统（Fog of War）大幅减少同步量
```

#### MMO：分区 + 兴趣过滤

```
MMO 特殊约束：
- 数千同屏玩家（城市/副本）
- 100ms+ 延迟可接受
- 持久化世界，不能丢状态

架构：Gateway → Zone Server 集群
- AOI 只同步附近 50m 内的实体
- 热点区域动态分 Zone
- 客户端只接收过滤后的增量快照
```

### ⚡ 实战经验

- **不要跨类型照搬方案**：见过把 FPS 的状态同步直接搬到 RTS 上的项目——每个单位的位置旋转全同步，100 个单位 × 30Hz = 3000 条位置/秒，带宽直接爆炸
- **MOBA 的视野同步是隐藏的大头**：小兵的可见/不可见切换频繁，视野变化包量可能比移动同步还多，需要做视野差量编码
- **RTS 转帧同步前先做确定性测试**：写一个 headless 模式，同样的输入跑 1 万帧，对比两次的哈希值，不一致就说明有非确定性代码
- **格斗游戏的回滚帧数限制**：通常设最大回滚 7 帧（约 116ms），超过就显示延迟等待（Stall）；回滚帧数越大，网络容错越好但 CPU 开关越高

### 🔗 相关问题

- 为什么 MOBA 不用帧同步？确定性模拟在大型项目中的维护成本有多高？
- 大逃杀（Battle Royale）算 FPS 还是 MMO？100 人同局如何做网络架构？
- 跨平台（PC/手机/主机）混匹配时，不同输入延迟如何公平处理？
