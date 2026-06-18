---
title: "备忘录模式如何实现游戏的存档、回放和撤销系统？"
category: "programming"
level: 2
tags: ["设计模式", "备忘录模式", "存档系统", "回放", "撤销重做"]
related: ["programming/command-pattern-undo-redo", "programming/serialization-save-system", "programming/state-pattern-game"]
hint: "不破坏封装地『快照对象内部状态』——存档、战斗回放、无限撤销都靠它，关键是区分可撤销与不可逆操作。"
---

## 参考答案

### ✅ 核心要点

1. **备忘录模式的核心是"在不破坏封装的前提下捕获并外部化对象内部状态"**：发起人（Originator，如游戏角色）创建一个备忘录（Memento）保存自己某一时刻的全部状态，由管理者（Caretaker，如存档系统）保管，需要时把备忘录还给发起人恢复状态。关键约束是备忘录对管理者**不透明**——管理者不能读取或修改备忘录内部，只能整体存取，这保证了状态封装不被破坏。
2. **它解决的根本问题是"时间维度的状态回滚"**：普通对象只能反映"当前状态"，备忘录让它能回到"历史任一时刻"。游戏的存档（回到保存点）、战斗回放（重现整场战斗每一步）、无限撤销（编辑器里 Ctrl+Z 几十步）本质上都是这个能力——区别只在于快照的粒度（全量 vs 增量）和保留的份数。
3. **全量快照 vs 增量快照是核心权衡**：全量快照（每次存整个对象树）实现简单、恢复 O(1)，但内存随快照数线性增长——存 100 个快照就是 100 倍内存。增量快照（只存变化的部分，类似 git diff）省内存但恢复要重放历史、实现复杂。关卡存档用全量（频率低），帧回放/撤销用增量（频率高）。
4. **可序列化是存档和回放的前提**：备忘录要能写入磁盘（存档）或通过网络发送（联机回放），其内容必须是可序列化的纯数据（不能含函数、循环引用、引擎对象引用）。游戏状态要先"拍扁"成 JSON/二进制结构再放进备忘录，恢复时再"展开"回对象图——这一步的深拷贝和引用重建是最容易出 bug 的地方。
5. **区分"可撤销操作"与"不可逆操作"至关重要**：撤销系统里，移动、属性修改是可逆的（存旧值即可恢复）；但"销毁了某个实体""花掉了一笔钱触发购买"涉及外部副作用（音效已播、网络请求已发、真实付款）不可逆。备忘录只能恢复对象内部状态，无法撤销外部世界的副作用——设计撤销系统时必须把不可逆操作排除，或用"补偿操作"近似撤销。
6. **回放系统需要确定性和输入录制**：战斗回放如果用"每帧存全量状态"内存爆炸（60fps × 60 秒 × 10KB/帧 = 36MB/分钟）。正确做法是录制"玩家输入序列"（每帧的操作只有几十字节），回放时从初始状态出发用相同逻辑重演——这要求游戏逻辑是确定性的（同样输入必产生同样结果，参见帧同步）。这是备忘录模式在高频场景的进阶形态。

### 📖 深度展开

#### 1. 备忘录模式的三角色结构

```typescript
// 备忘录：不可变的纯数据快照，对 Caretaker 不透明
class CharacterMemento {
  constructor(
    public readonly hp: number,
    public readonly mp: number,
    public readonly x: number,
    public readonly y: number,
    public readonly inventory: readonly string[],   // 只读，防篡改
    public readonly timestamp: number,
  ) {}
}

// 发起人：创建快照、从快照恢复
class Character {
  constructor(public hp: number, public mp: number, public x: number, public y: number,
              public inventory: string[] = []) {}

  save(): CharacterMemento {
    return new CharacterMemento(this.hp, this.mp, this.x, this.y,
      [...this.inventory], Date.now());   // ⚠️ 深拷贝 inventory，否则快照会被后续修改污染
  }

  restore(m: CharacterMemento): void {
    this.hp = m.hp; this.mp = m.mp; this.x = m.x; this.y = m.y;
    this.inventory = [...m.inventory];     // 恢复时也要拷贝，保持快照不可变
  }
}

// 管理者：保管快照栈，只负责存取不解读内容
class SaveSlot {
  private stack: CharacterMemento[] = [];
  private maxSlots: number;

  constructor(maxSlots = 20) { this.maxSlots = maxSlots; }

  save(m: CharacterMemento): void {
    this.stack.push(m);
    if (this.stack.length > this.maxSlots) this.stack.shift();  // 超限丢弃最旧
  }
  pop(): CharacterMemento | undefined { return this.stack.pop(); }
  peek(): CharacterMemento | undefined { return this.stack[this.stack.length - 1]; }
}

// 用法：编辑器撤销
const hero = new Character(100, 50, 0, 0, ['sword']);
const history = new SaveSlot(20);
history.save(hero.save());              // 存档点1
hero.hp -= 30; hero.inventory.push('potion');
history.save(hero.save());              // 存档点2
hero.restore(history.pop()!);           // 撤销：回到 hp=70, inventory=['sword','potion']？❌
// 注意：save() 在修改后调用，所以存的是修改后状态。撤销顺序要正确设计
```

#### 2. 全量快照 vs 增量快照 vs 输入录制

```
状态历史:  S0 --op1--> S1 --op2--> S2 --op3--> S3 (当前)

全量快照 (存每个完整状态):                    内存: O(N × |S|)   恢复: O(1)
  存档: [S0][S1][S2][S3]                       适用: 关卡存档（频率低，份数少）

增量快照 (只存每次操作的变化):                内存: O(N × |Δ|)   恢复: O(N) 重放
  存档: [S0][Δ1][Δ2][Δ3]                       适用: 撤销系统（频率高，|Δ| << |S|）

输入录制 (只存操作，从初始态重演):            内存: O(N × |input|) 恢复: O(N) 全程重算
  存档: [S0][op1][op2][op3]                    适用: 战斗回放（|input| 极小，需确定性）
```

| 方案 | 单次快照大小 | 恢复速度 | 实现复杂度 | 内存随帧数增长 | 典型场景 |
|------|------------|---------|----------|--------------|---------|
| **全量快照** | 大（整个状态树） | ⚡ O(1) 直接读 | 低 | 快（线性 × 大常数） | 关卡存档（10-50 份） |
| **增量快照** | 小（仅 diff） | 中 O(N) 重放历史 | 中（需 diff 算法） | 慢（线性 × 小常数） | 撤销重做（100+ 步） |
| **输入录制** | 极小（几十字节） | 慢 O(N) 全程重算 | 高（需确定性逻辑） | 最慢 | **战斗回放、帧同步录像** |
| **周期全量 + 增量** | 混合 | 中 | 高 | 折中 | 大型回放（关键帧 + 补间） |

#### 3. 实战：战斗回放的"关键帧 + 输入流"混合方案

```typescript
// 纯输入录制回放 60 秒战斗需从头重算 3600 帧，跳转/拖拽进度条体验差
// 混合方案：每 2 秒存一个全量"关键帧"，关键帧之间只存输入 → 跳转最多重算 120 帧

interface ReplayFrame {
  tick: number;
  fullState?: Uint8Array;     // 关键帧：全量状态（每 120 tick 存一次）
  inputs: PlayerInput[];      // 本帧的玩家输入（增量）
}

class BattleReplay {
  private frames: ReplayFrame[] = [];
  private keyframeInterval = 120;   // 每 120 帧（2秒@60fps）一个关键帧

  record(tick: number, state: Uint8Array, inputs: PlayerInput[]): void {
    const isKeyframe = tick % this.keyframeInterval === 0;
    this.frames.push({
      tick,
      fullState: isKeyframe ? new Uint8Array(state) : undefined,  // 关键帧才存全量
      inputs,
    });
  }

  // 跳转到任意 tick：找最近的关键帧，从那里重演
  seek(targetTick: number, simulator: Simulator): void {
    // 找 targetTick 之前最近的关键帧
    let keyframeIdx = 0;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].fullState && this.frames[i].tick <= targetTick) {
        keyframeIdx = i; break;
      }
    }
    // 从关键帧恢复全量状态
    simulator.loadState(this.frames[keyframeIdx].fullState!);
    // 重演关键帧到 targetTick 之间的输入（最多 120 帧，~2ms）
    for (let i = keyframeIdx + 1; i < this.frames.length && this.frames[i].tick <= targetTick; i++) {
      simulator.step(this.frames[i].inputs);
    }
  }
}
// 内存对比（60秒战斗，状态 5KB/帧，输入 20 字节/帧）：
//   纯全量: 3600 × 5KB = 18MB
//   纯输入: 3600 × 20B = 72KB（但 seek 要重算 3600 帧，卡 60ms）
//   混合:   30关键帧×5KB + 3600×20B = 222KB，seek 最多重算 120 帧 ~2ms ✅
```

### ⚡ 实战经验

- **深拷贝遗漏导致快照被后续修改污染**：`save()` 里 `inventory: this.inventory` 直接存了数组引用，之后角色又 `push` 了一个物品，结果所有历史快照里都多了那个物品——撤销毫无效果。备忘录的每份数据都必须深拷贝（或用 `Object.freeze` + 结构共享的不可变结构），这是备忘录模式排名第一的 bug 来源。
- **撤销栈无限增长吃光内存**：地图编辑器允许无限撤销，每次操作存全量地图状态（2MB/次），操作 500 次后内存 1GB 崩溃。解法是设上限（保留最近 50 步）或改增量快照（只存 diff，500 步可能才几 MB）。撤销深度要根据单步快照大小和操作频率动态设上限。
- **不可逆操作混入撤销栈导致状态不一致**：撤销"购买物品"操作时，物品退回背包了，但真实付款已经完成（外部支付系统），金币也没退——玩家白嫖了物品。备忘录只能恢复内部状态，凡涉及真实世界副作用的操作（支付、发奖励、网络调用）必须标记为不可撤销或设计补偿事务。
- **回放系统的确定性破坏让录像失真**：录制时用了 `Math.random()`（非确定性），回放时随机数序列不同，导致原本暴击的攻击变成未命中，整场战斗走向完全不同。回放/帧同步必须用**带种子的确定性随机数生成器**（参见 rng-seeded-random），且禁止用 `Date.now()`、`performance.now()` 等非确定时间源驱动逻辑。
- **备忘录序列化遇到循环引用直接崩溃**：角色持有"所在队伍"引用，队伍又持有"成员列表"含该角色 —— `JSON.stringify` 遇到循环引用抛异常。解法是序列化时用 ID 引用替代对象引用（拍扁成 `{teamId: 5}` 而非 `{team: {...}}`），恢复时按 ID 重建引用图。这正是序列化系统的核心难题（参见 serialization-save-system）。

### 🔗 相关问题

1. 备忘录模式和命令模式（command-pattern-undo-redo）都能实现撤销，二者有何本质区别？什么场景该用哪个，能否结合使用？
2. ECS 架构下实体状态分散在多个 Component 中，如何高效地为整个世界做快照？是按实体存还是按 Component 存？
3. 云存档系统如何处理"本地快照"与"服务器权威状态"的冲突？当玩家在两台设备上同时游玩时，备忘录合并策略该怎么设计？
