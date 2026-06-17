---
title: "如何实现确定性模拟与回放系统？格斗/RTS 的锁步同步怎么做？"
category: "programming"
level: 3
tags: ["确定性", "回放系统", "锁步同步", "浮点数", "网络同步"]
related: ["programming/floating-point-precision", "programming/network-sync-game", "programming/rng-seeded-random"]
hint: "同一份输入，在任何机器上跑出完全相同的结果——确定性是回放、观战、锁步联机、录像系统的共同地基。"
---

## 参考答案

### ✅ 核心要点

1. **确定性 = 相同输入必然相同输出**：只要初始状态和每帧的输入序列一致，模拟在任何 CPU、任何时间跑出来的状态必须逐字节相同。这是回放系统、观战、确定性锁步联机（如《星际争霸》《英雄联盟》）的根本前提——录像只需存输入，不用存整局快照。
2. **浮点数是确定性的头号敌人**：IEEE 754 在"同一架构"上是确定的，但跨 x86/ARM、不同编译器优化级别（FMA 指令、x87 扩展精度）结果可能不同。要么用定点数（Fixed-Point），要么锁死编译选项并禁止 FMA，否则回放在不同手机上"漂移"。
3. **随机数必须用种子化 PRNG**：`Math.random()` 不可用（每次结果不同，且不同引擎实现不同）。用确定性 PRNG（如 xorshift、PCG）配共享种子，攻击命中、暴击、掉落全走同一个随机流，录像里重放完全一致。
4. **输入必须按帧序列化**：把每帧所有玩家的操作（移动方向、技能键）编码成紧凑的输入帧（Input Frame），录像就是 `seed + 输入帧序列`。回放时按固定逻辑帧率（如 30/60 FPS）逐步喂入，模拟器不需要任何网络数据。
5. **锁步（Lockstep）= 帧同步 + 等待**：联机时每个客户端收集本帧输入，广播给所有人，必须等所有人的输入到齐才能推进下一帧——谁慢了所有人都卡。延迟掩盖靠"输入预测 + 回滚"（GGPO 模式），而非容忍不确定性。
6. **容器迭代顺序和语言特性也要确定性**：`Map`/`Set` 的迭代顺序、`for...in` 的属性枚举顺序、对象 key 插入顺序在某些边界情况下不一致；碰撞检测里遍历实体的顺序若不确定，伤害结算顺序就不同，结果分叉。

### 📖 深度展开

**1. 回放系统的数据流**

```
录像录制（Recording）
  帧1: input={p1:{move:UP,fire:true}, p2:{move:IDLE}}
  帧2: input={p1:{move:UP},           p2:{move:LEFT}}
  ...（只存输入，每帧几十字节）
  录像文件 = seed(4B) + 帧数(4B) + 输入序列(N × 帧大小)

回放（Playback）
  ┌────────────────────────────────────────────┐
  │ 1. 重置模拟器到初始状态，喂入 seed          │
  │ 2. fixedUpdate() 按固定 60FPS 跑逻辑        │  ← 不依赖渲染帧率
  │ 3. 每帧从录像读一条 input，喂给模拟器       │
  │ 4. 渲染层只读状态、不修改状态               │  ← 渲染与逻辑分离
  │ 5. 跑完所有帧 → 录像结束                    │
  └────────────────────────────────────────────┘
  关键：渲染帧率可变（30/60/120Hz），但逻辑帧固定 → 任意设备回放一致
```

```typescript
// 确定性模拟器骨架：纯函数式，禁止任何外部状态/时间
class Sim {
  state: GameState;           // 纯数据
  rng: RNG;                   // 种子化 PRNG（非 Math.random）
  constructor(seed: number){ this.rng = new PCG(seed); this.state = initState(); }

  // fixedUpdate 必须是纯函数：同样的 input → 同样的 state 转移
  step(input: InputFrame){
    // ❌ 禁止：Date.now() / Math.random() / performance.now() / 异步
    for(const e of sortedById(this.state.entities)){   // ← 按 ID 排序保证遍历序
      e.x += input[e.id].dx * FIXED_DT;
      if(input[e.id].fire && this.rng.next() < e.critRate) e.dealCrit(); // 随机走 rng
    }
  }
}
// 录制：sim.step(recordedFrame[i])
// 回放：同一 seed 重建 sim，sim.step(replayFrame[i]) → 状态逐字节一致
```

**2. 浮点数陷阱与定点数方案**

| 场景 | 风险 | 解决方案 |
|------|------|----------|
| 跨平台回放（PC vs 手机） | x87 扩展精度 / FMA 指令差异 | 用定点数（Q格式，如 Q16.16） |
| 物理引擎积分 | 不同编译器浮点结果微差累积 | 锁编译选项 `-ffp-contract=off` 禁 FMA |
| 三角函数 `Math.sin` | 不同 libc 实现精度不同 | 查表（LUT）+ 确定性插值 |
| `NaN`/`Infinity` 传播 | 一个 NaN 污染整局录像 | 每帧断言 `Number.isFinite` |

```typescript
// 定点数 Q16.16：用整数模拟小数，跨平台位级一致
const FRAC = 16;
const ONE  = 1 << FRAC;            // 1.0 表示成 65536
function toFixed(x: number){ return Math.round(x * ONE) | 0; }
function fromFixed(x: number){ return x / ONE; }
function fmul(a:number,b:number){  // 定点乘法
  return ((a * b) >> FRAC) | 0;    // 纯整数运算，无浮点歧义
}
// 坐标、速度全用定点数，渲染时再 fromFixed 转回浮点给 GPU
// 代价：精度受限（Q16.16 范围 ±32767，精度 1/65536），但对 2D 格斗/RTS 足够
```

**3. 锁步联机与 GGPO 回滚**

```
传统 Lockstep（严格同步）
  客户端A 本地输入 ──┐
                    ├─► 汇集所有输入 ─► 各自 step ─► 下一帧
  客户端B 本地输入 ──┘
  问题：任一玩家延迟 → 全体卡顿（"等齐才推进"）

GGPO 回滚模式（延迟掩盖）
  帧 N：
   1. 本地预测：用"猜测的对手输入"先跑几帧（玩家无感）
   2. 真实输入到达 → 若与猜测不同 → 回滚到分歧点 → 重新模拟 → 快进到当前
   3. 渲染层在回滚后"瞬切"，配合 1-2 帧渲染延迟掩盖闪烁
  优势：本地操作零延迟；代价：CPU 要能在一帧内重算多帧 → 对确定性要求更苛刻
```

```typescript
// 回滚核心：保存定期快照 + 可从任意点重放
class RollbackNetcode {
  states: Map<number, GameState> = new Map();   // 帧号 → 快照
  inputs:  Map<number, InputFrame> = new Map(); // 帧号 → 已确认输入

  onRemoteInput(frame:number, input:InputFrame){
    if(this.inputs.get(frame) && !eqInput(this.inputs.get(frame)!,input)){
      // 预测错了：回滚到 frame-1 的快照，重放到当前
      const snap = this.states.get(frame-1)!;
      const sim = new Sim(snap.seed); sim.state = deepCopy(snap);
      for(let f=frame; f<=this.currentFrame; f++){
        sim.step(this.inputs.get(f)!);           // 用真实输入重放
      }
      this.state = sim.state;                     // 修正当前状态
    }
    this.inputs.set(frame, input);
  }
  checkpoint(){ this.states.set(this.currentFrame, deepCopy(this.state)); }
}
```

### ⚡ 实战经验

- **`Math.random()` 混进模拟器 = 录像必坏**：暴击判定一时图省事用了 `Math.random()`，回放时同一段操作暴击结果完全不同，录像废了。全工程用 eslint 规则禁用 `Math.random`，统一走注入的 `sim.rng.next()`，PRNG 用 PCG（周期长、分布均匀）。
- **实体遍历顺序不定导致伤害结算分叉**：两个敌人同时打中玩家，谁先结算决定了谁拿最后一击，用 `Map.values()` 迭代在不同 V8 版本顺序不同。所有模拟内遍历都先 `entities.sort((a,b)=>a.id-b.id)`，看似浪费实则杜绝了跨版本录像不兼容。
- **手机端 FMA 让 PC 录像对不上**：PC 上用 x86 FMA 加速的物理积分，在 ARM 手机回放时浮点末位不同，3 分钟后角色位置差了几个像素，碰撞结果分叉。要么全平台禁 FMA（`-ffp-contract=off`），要么 2D 游戏直接上定点数——后者最稳。
- **录像用 JSON 存输入 → 体积爆炸**：一局 20 分钟对局，JSON 存每帧输入到了 8MB。改成二进制位打包（方向 2bit + 6 个按键各 1bit = 1 字节/玩家/帧），同样对局缩到 120KB，还能服务端压缩传输。
- **GGPO 回滚没限预测帧数 → CPU 飙满**：网络抖动时预测了 15 帧后真实输入到达，一帧内重算 15 帧 step 把 16ms 预算吃光，画面卡死。限制最大预测帧（通常 7-9 帧），超过就主动"卡一下等输入"，比卡死强。

### 🔗 相关问题

1. 为什么《魔兽争霸3》《星际2》的录像文件只有几百 KB？它们存的是状态还是输入？这种录像为什么不能"快进"只能"加速"？
2. 定点数 Q16.16 的精度（1/65536）对大地图坐标够用吗？该怎么分层管理（区块坐标用整数、块内坐标用定点）？
3. 客户端预测和服务端权威（如《CS:GO》《守望先锋》）相比确定性锁步（GGPO），各自适合什么类型的游戏？为什么 FPS 几乎不用锁步？
