---
title: "游戏帧同步与状态同步有什么区别？如何选择？"
category: "programming"
level: 3
tags: ["网络同步", "帧同步", "状态同步", "多人游戏", "架构设计"]
related: ["programming/async-coroutine-scheduling", "programming/floating-point-precision"]
hint: "核心区别在于『谁计算游戏逻辑』——客户端各自算还是服务器算？这决定了整个架构。"
---

## 参考答案

### ✅ 核心要点

1. **帧同步（Lockstep）**：服务器只转发操作指令，所有客户端各自执行相同逻辑，要求确定性模拟——相同输入必须产生相同结果，任何浮点误差、随机数不一致都会导致「不同步」。
2. **状态同步（State Sync）**：服务器是唯一权威，执行全部游戏逻辑后将结果状态广播给客户端，客户端只负责表现层渲染和插值，无需保证确定性。
3. **带宽消耗截然不同**：帧同步上行/下行数据量极小（仅操作指令，每帧几十字节）；状态同步下行数据量随实体数量线性增长，需要 Delta 压缩和 AOI（兴趣区域）裁剪来控制流量。
4. **断线重连策略完全不同**：帧同步重连需要回放从断线帧到当前帧的全部操作日志（可能上千帧）；状态同步只需拉取一次全量快照即可恢复，代价是快照本身可能较大。
5. **反作弊能力差异巨大**：帧同步中客户端掌握全部逻辑，外挂可以任意篡改本地计算结果且服务器无法验证；状态同步中服务器握有权威，客户端作弊空间被压缩到表现层（如透视）。
6. **确定性是帧同步的生死线**：浮点运算跨平台不一致、容器遍历顺序不确定、随机数未共享种子，这三类问题是帧同步项目中最致命的 bug 来源。

### 📖 深度展开

#### 1. 两种同步模型的数据流对比

```
【帧同步 Lockstep】
Client A ──┐                    ┌──→ Client A (执行)
            ├─→ Server(转发指令) ──┤
Client B ──┘                    └──→ Client B (执行)
  上行：操作指令 {unitId, action, frame}
  下行：操作指令批次（聚合多客户端同一帧的指令）
  特点：带宽极小，但要求所有端确定性一致

【状态同步 State Sync】
Client A ──┐                        ┌──→ Client A (渲染+插值)
            │  上行：操作指令          │  下行：实体状态 Delta
Client B ──┴─→ Server(执行全部逻辑) ──┴──→ Client B (渲染+插值)
  上行：操作指令（同帧同步）
  下行：实体属性变化 {entityId, pos, hp, anim, ...}
  特点：服务器权威，下行带宽随实体数增长
```

#### 2. 帧同步确定性模拟的核心代码

帧同步要求所有客户端在相同输入下产生完全一致的结果，关键在于用**定点数**替代浮点数：

```typescript
// ❌ 危险：浮点数跨平台/跨编译器结果不一致
function moveFloat(pos: number, speed: number, dt: number): number {
  return pos + speed * dt; // 0.1 + 0.2 !== 0.3 的经典问题
}

// ✅ 正确：定点数实现，整数运算保证确定性
class FixedPoint {
  static readonly SHIFT = 16;       // 16位小数精度
  static readonly FACTOR = 1 << 16; // = 65536
  readonly raw: number;             // 内部用整数存储

  constructor(value: number) {
    this.raw = Math.round(value * FixedPoint.FACTOR);
  }

  add(other: FixedPoint): FixedPoint {
    return FixedPoint.fromRaw(this.raw + other.raw);
  }

  mul(other: FixedPoint): FixedPoint {
    // 注意：乘法结果需要右移回正确精度
    const result = (this.raw * other.raw) >> FixedPoint.SHIFT;
    return FixedPoint.fromRaw(result);
  }

  toNumber(): number {
    return this.raw / FixedPoint.FACTOR;
  }

  static fromRaw(raw: number): FixedPoint {
    const fp = Object.create(FixedPoint.prototype);
    fp.raw = raw;
    return fp;
  }
}

// 确定性随机数：必须使用线性同余法，所有端共享相同种子
class DeterministicRNG {
  private seed: number;
  constructor(seed: pop) { this.seed = seed; }

  next(): number {
    // LCG 参数必须所有平台一致（C/C# 也会用同样的算法）
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff; // 归一化到 [0, 1)
  }
}
```

#### 3. 帧同步 vs 状态同步选型决策矩阵

| 维度 | 帧同步（Lockstep） | 状态同步（State Sync） |
|------|-------------------|----------------------|
| 适用游戏类型 | RTS、格斗、MOBA | MMO、FPS、大世界RPG |
| 服务器计算压力 | 极低（只转发） | 高（执行全部逻辑） |
| 带宽消耗 | 低（~1KB/s） | 高（10-100KB/s，需优化） |
| 断线重连 | 慢（需回放操作） | 快（拉快照即可） |
| 反作弊能力 | 弱（客户端自治） | 强（服务器权威） |
| 开发复杂度 | 高（确定性要求苛刻） | 中（但需处理插值/预测） |
| 延迟敏感度 | 高（需要等待所有指令） | 中（可做客户端预测） |
| 回放/观战 | 天然支持（存指令即可） | 需额外记录状态快照 |
| 典型代表 | 星际争霸、王者荣耀 | 魔兽世界、CS:GO、原神联机 |

#### 4. 状态同步中的客户端预测与服务器纠正

状态同步的核心挑战是「手感延迟」——玩家操作要等服务器确认才有反馈，典型方案是 **Client Prediction + Server Reconciliation**：

```
客户端操作流程：
  Player Input → 本地立即预测移动 → 发送给服务器
                                         ↓
  服务器权威计算 → 返回确认状态 → 客户端比对
       ↓                           ↓
  若一致 → 继续              若不一致 → 回滚+重放未确认的操作
```

```typescript
class ClientPrediction {
  private pendingInputs: Map<number, PlayerInput> = new Map();
  private lastConfirmedSeq = 0;
  private localState: PlayerState;

  onPlayerInput(input: PlayerInput) {
    const seq = ++this.inputCounter;
    this.pendingInputs.set(seq, input);

    // 立即在本地执行预测，不等服务器
    this.localState = this.simulate(this.localState, input);

    // 同时发给服务器
    this.sendToServer({ seq, input });
  }

  onServerConfirm(seq: number, serverState: PlayerState) {
    // 服务器确认到 seq 为止的状态
    this.pendingInputs.delete(seq);
    this.lastConfirmedSeq = seq;

    if (!this.statesEqual(this.localState, serverState)) {
      // 预测错误：以服务器为准
      this.localState = serverState;
      // 重放所有未确认的操作（回滚再前进）
      for (const [s, input] of this.pendingInputs) {
        if (s > seq) {
          this.localState = this.simulate(this.localState, input);
        }
      }
    }
  }
}
```

### ⚡ 实战经验

- **帧同步项目 80% 的不同步 bug 来自浮点数**：某 MOBA 项目曾因某平台编译器将 `a * b + c` 优化为 FMA（融合乘加）指令，导致与另一平台结果差 1 ULP，整个对局不同步。必须用定点数或 `Math.fround()` 强制单精度。
- **随机数必须全局统一管理**：曾遇到音效系统的随机播放用了 `Math.random()`，导致客户端声音序列不一致，触发了逻辑层的隐式分支不同步。所有随机数必须走确定性 RNG 并共享种子。
- **帧同步的断线重连要设上限**：一个 30 分钟的对局，断线后回放上万帧操作可能需要 10 秒以上，必须做「关键帧快照」——每隔 N 帧存一次全量状态，重连时从最近快照开始回放，将重连时间控制在 2 秒内。
- **状态同步带宽优化是持续工程**：一个有 200 个 NPC 的场景，每帧全量同步位置需要 200 × 12B = 2.4KB，30 帧就是 72KB/s。必须做 Delta 压缩（只发变化的字段）+ AOI 裁剪（只发视野内的实体）+ 量化压缩（位置用 16 位整数而非 float32）。
- **不要混合两种模式**：见过项目试图「帧同步做战斗、状态同步做社交」，结果是两套确定性要求互相污染，调试地狱。选型时必须整体统一。

### 🔗 相关问题

- 帧同步如何实现「追帧」机制？（落后服务器的客户端如何快速追赶）
- 状态同步中如何处理「瞬移」技能的位置同步问题？
- 如何在帧同步中实现确定性物理引擎？主流方案有哪些？
