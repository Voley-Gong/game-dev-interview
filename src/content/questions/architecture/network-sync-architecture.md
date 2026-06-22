---
title: "网络游戏同步架构：状态同步和帧同步怎么选？如何保证一致性？"
category: "architecture"
level: 4
tags: ["网络同步", "帧同步", "状态同步", "Lockstep", "架构设计"]
related: ["architecture/game-loop-subsystem", "architecture/save-system-architecture", "architecture/fsm-behavior-tree"]
hint: "帧同步传'操作'靠确定性跑出相同结果，状态同步传'结果'靠服务器权威。选型的关键不是谁更好，而是玩法类型、反作弊要求、断线重连成本三者如何取舍。"
---

## 参考答案

### ✅ 核心要点

1. **两种本质区别**：帧同步（Lockstep）只广播玩家**操作输入**，各端按相同逻辑帧独立演算、靠"确定性"保证结果一致；状态同步（State Sync）由服务器演算并广播**权威状态快照**，客户端只负责表现层插值。
2. **帧同步的生命线是确定性**：相同输入必须产生完全相同的输出——不能用浮点数、不能依赖随机数种子外的随机源、遍历顺序必须稳定、逻辑帧必须和渲染帧分离。
3. **状态同步的生命线是服务器权威**：所有关键数据（位置/血量/伤害）以服务端为准，客户端发操作请求、收状态快照做插值（Interpolation）和预测（Prediction）+ 回滚（Reconciliation）。
4. **断线重连成本相反**：帧同步重连要补跑所有历史帧（或存检查点），时间长但数据小；状态同步重连只需拉一份最新全量状态，快但单包大。
5. **选型看玩法**：RTS/MOBA/格斗（单位多、操作密集、公平性强）多用帧同步；MMO/射击/开放世界（大世界、持久化、强反作弊）多用状态同步；很多项目是混合（战斗帧同步 + 大厅状态同步）。

### 📖 深度展开

**两种同步架构对比：**

```
帧同步（Lockstep / Deterministic）
  客户端A ──操作──┐
  客户端B ──操作──┼─→ 服务器(转发/收集) ──本帧所有操作──→ 各客户端
  客户端C ──操作──┘                                       ↓
                                              各自独立演算（确定性），结果应完全一致
  传输量：小（只有输入）  |  服务端压力：低（只转发）  |  反作弊：弱（逻辑在客户端）

状态同步（Server Authoritative）
  客户端A ──操作请求──┐
  客户端B ──操作请求──┼─→ 服务器（权威演算）──状态快照/增量──→ 各客户端表现层
  客户端C ──操作请求──┘
  传输量：大（状态数据）|  服务端压力：高（跑全部逻辑）|  反作弊：强（服务端说了算）
```

**帧同步核心：逻辑帧 + 操作收集 + 确定性演算**

```csharp
// 1. 客户端把本帧操作上报，服务器收集所有客户端操作后按帧广播
public struct FrameInput {
    public int frameId;        // 逻辑帧号
    public int playerId;
    public uint inputMask;     // 用位掩码编码：移动/攻击/技能
}

// 2. 每个客户端收到某帧的全部输入后，执行一次确定性更新
public void TickFrame(FrameInput[] inputsOfThisFrame) {
    // 关键：按固定 playerId 顺序处理，保证各端遍历顺序一致
    foreach (var input in inputsOfThisFrame.OrderBy(p => p.playerId)) {
        ApplyInput(input);     // 只能用整数/定点数运算
    }
    LogicWorld.Step(FIXED_DT); // 逻辑帧固定步长，与渲染帧解耦
}

// 3. 渲染层只读取逻辑世界状态做插值，不参与同步判定
public void Render(float interpolation) {
    foreach (var unit in LogicWorld.Units)
        view.SetPosition(Lerp(unit.PrevPos, unit.CurPos, interpolation));
}
```

**状态同步核心：快照 + 增量 + 预测回滚**

```csharp
// 服务器：定期广播状态快照（带序列号，用于增量/丢包处理）
public struct StateSnapshot {
    public int seq;            // 快照序列号
    public int lastAckSeq;     // 客户端最近确认的序列号（算增量基准）
    public EntityState[] states; // 全量或增量状态
}

// 客户端：收到快照后做插值表现 + 预测校正
public void OnSnapshot(StateSnapshot snap) {
    // 插值：用 100ms 前的快照平滑表现，掩盖网络抖动
    renderBuffer.Add(snap, serverTime - INTERP_DELAY);
    // 预测校正：本地预测的位置和服务端权威位置不一致时回滚重放
    if (Vector3.Distance(myPredPos, snap.myPos) > THRESHOLD) {
        myPredPos = snap.myPos;        // 以服务端为准（橡皮筋回拉）
        ReplayPendingInputs();          // 重放未确认的本地输入
    }
}
```

**选型决策矩阵：**

| 维度 | 帧同步 | 状态同步 |
|------|--------|----------|
| 传输内容 | 玩家输入 | 实体状态快照 |
| 带宽（单位多时） | 优势明显 | 随单位数线性增长 |
| 服务端计算 | 几乎不计算（只转发） | 跑全部游戏逻辑 |
| 反作弊 | 弱（需录像校验/服务端抽检） | 强（服务端权威） |
| 确定性要求 | 极高（跨语言/跨平台也要一致） | 不要求 |
| 断线重连 | 补跑历史帧或检查点，慢 | 拉全量状态，快 |
| 实现难度 | 确定性调试极痛苦 | 状态插值/预测较成熟 |
| 典型场景 | RTS、格斗、MOBA 战斗 | MMO、FPS、开放世界 |

### ⚡ 实战经验

- **帧同步的浮点数是定时炸弹**：不同 CPU/编译器对浮点运算的舍入可能不同，跨平台（PC vs 手机）会出现"漂移"。要么全程定点数，要么锁定平台并用确定性数学库，上线前必须做长时间的双端录像 diff。
- **逻辑帧必须和渲染帧彻底分离**：逻辑帧固定步长（如 20fps），渲染帧随意（60/120fps），中间用插值平滑。直接在 Update 里跑同步逻辑会因为帧率不同导致各端演算不一致。
- **状态同步别让客户端直接改血量**：所有伤害结算走服务端，客户端打了人只发"我请求攻击"——否则外挂改本地内存就能秒杀。代价是有延迟，用"命中确认 + 表现先行（受击动画立刻播）"弥补手感。
- **混合架构越来越主流**：大厅/经济/社交用状态同步（需持久化、防作弊），战斗房间用帧同步（公平、低带宽）。两套同步用房间进入/退出做切换，注意切换时状态要同步对齐，否则进战斗时位置错乱。

### 🔗 相关问题

1. 帧同步中如何做"乐观帧步进"（不等慢玩家就推进）来降低延迟？掉队玩家怎么补偿？
2. 状态同步的"客户端预测 + 服务端回滚"具体如何实现，如何避免频繁的橡皮筋回拉？
3. 网络延迟抖动严重时，如何设计一个平滑的插值缓冲区（jitter buffer）？
