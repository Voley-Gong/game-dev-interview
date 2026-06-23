---
title: "游戏回放系统怎么设计？输入录制和状态快照各有什么优缺点？"
category: "architecture"
level: 4
tags: ["回放系统", "确定性模拟", "网络同步", "架构设计", "帧同步"]
related: ["architecture/network-sync-architecture", "architecture/fsm-behavior-tree"]
hint: "核心是「确定性模拟 + 输入录制」或「状态快照 + 差值插值」，两者各有取舍。"
---

## 参考答案

### ✅ 核心要点

1. **两种基本范式**：输入录制（Input Recording / Lockstep）和状态快照（State Snapshot）
2. **确定性模拟**：输入录制要求逻辑代码在相同输入下产生完全一致的输出——浮点数、随机数、遍历顺序都必须确定
3. **状态快照**：周期性保存游戏世界全量或增量状态，回放时直接恢复，不依赖逻辑确定性
4. **混合方案**：关键帧快照 + 帧间输入流，兼顾存储效率与容错性
5. **带宽与存储优化**：差分压缩（Delta）、关键帧间隔（Keyframe Interval）、事件去重

### 📖 深度展开

**两种回放范式对比：**

```
方案 A：输入录制（Lockstep / 确定性回放）
  录制：每帧记录所有玩家输入 → [Frame1: {P1:↑, P2:→}, Frame2: {...}, ...]
  回放：从头开始模拟，逐帧喂入录制的输入 → 逻辑重新跑一遍
  优点：文件极小（每帧几十字节），完美还原
  缺点：要求严格确定性，一个 float 误差就导致"蝴蝶效应"不同步

方案 B：状态快照（Snapshot / 状态回放）
  录制：每隔 N 帧保存世界状态快照 → [Snapshot@F0, Snapshot@F30, ...]
  回放：加载快照，直接恢复到对应时刻
  优点：不要求确定性，可跳转任意时间点
  缺点：存储大（单帧快照可能 KB~MB 级），需要序列化全部状态
```

**输入录制回放的核心实现：**

```csharp
// —— 录制阶段 ——
public struct FrameInput {
    public int Frame;           // 帧号
    public int PlayerId;        // 玩家 ID
    public uint InputMask;      // 输入位掩码（方向键/攻击/技能 bit 打包）
}

public class ReplayRecorder {
    private readonly List<FrameInput> _inputs = new();
    private int _frame = 0;

    public void Record(int playerId, uint inputMask) {
        _inputs.Add(new FrameInput {
            Frame = _frame, PlayerId = playerId, InputMask = inputMask
        });
    }

    public void Tick() => _frame++;

    public byte[] Serialize() {
        // 差分编码：只存 (frameDelta, playerId, inputMask)
        // 相邻帧的 frameDelta 通常为 0 或 1，可用变长整数压缩
        using var ms = new MemoryStream();
        using var bw = new BinaryWriter(ms);
        bw.Write(_inputs.Count);
        int prevFrame = 0;
        foreach (var inp in _inputs) {
            bw.Write7BitEncodedInt(inp.Frame - prevFrame); // 帧差
            bw.Write((byte)inp.PlayerId);
            bw.Write(inp.InputMask);
            prevFrame = inp.Frame;
        }
        return ms.ToArray();
    }
}

// —— 回放阶段 ——
public class ReplayPlayer {
    private Queue<FrameInput> _pending;
    private int _currentFrame = 0;

    public void Tick(IGameWorld world) {
        // 取出当前帧的所有输入，喂给游戏逻辑
        while (_pending.Count > 0 && _pending.Peek().Frame == _currentFrame) {
            var inp = _pending.Dequeue();
            world.InjectInput(inp.PlayerId, inp.InputMask);
        }
        world.FixedUpdate();  // 用与录制时完全相同的逻辑步进
        _currentFrame++;
    }
}
```

**状态快照回放的核心实现：**

```csharp
public class SnapshotReplay {
    // 关键帧间隔：每 30 帧存一个全量快照，中间帧存增量
    private const int KEYFRAME_INTERVAL = 30;

    public void SaveSnapshot(IGameWorld world, int frame) {
        bool isKeyframe = (frame % KEYFRAME_INTERVAL == 0);
        if (isKeyframe) {
            // 全量快照：序列化所有实体、组件、状态
            var snapshot = world.SerializeFull();
            Storage.WriteKeyframe(frame, snapshot);
        } else {
            // 增量快照：只存自上一帧以来的变化
            var delta = world.SerializeDelta();
            Storage.WriteDelta(frame, delta);
        }
    }

    public IGameWorld LoadAtFrame(int targetFrame) {
        // 1. 找到 <= targetFrame 的最近关键帧
        int keyframe = Storage.FindNearestKeyframe(targetFrame);
        var world = Storage.LoadKeyframe(keyframe);
        // 2. 从关键帧开始，逐帧 Apply Delta 直到目标帧
        for (int f = keyframe + 1; f <= targetFrame; f++) {
            var delta = Storage.LoadDelta(f);
            world.ApplyDelta(delta);
        }
        return world;
    }
}
```

**确定性模拟的注意事项：**

| 维度 | 非确定性行为 | 确定性解决方案 |
|------|-------------|---------------|
| 浮点运算 | 不同 CPU/编译器结果不同 | 使用定点数（Fixed-point）或统一 IEEE 754 编译选项 |
| 随机数 | `Random` 种子不确定 | 自实现线性同余 PRNG，全局共享种子 |
| 容器遍历 | `Dictionary` / `HashSet` 顺序不定 | 用有序容器（`List` / `SortedList`） |
| 物理引擎 | Havok/PhysX 不同平台结果不同 | 自研定点数物理或锁定引擎版本 |
| 时间步 | `Time.deltaTime` 浮动 | 固定逻辑帧率（如 30fps FixedTick） |

**适用场景选择：**

```
竞技游戏（MOBA / RTS / 格斗）→ 输入录制 + 确定性
  · 文件小，适合长时间录像
  · 但开发成本高，需要全链路确定性

休闲 / 单机 / 观战系统 → 状态快照
  · 开发简单，不需要改造游戏逻辑
  · 文件较大，但可配合压缩
  · 支持时间轴跳转、倍速、倒放
```

### ⚡ 实战经验

- **浮点数是确定性回放的头号杀手**：即使同一份代码，x86 和 ARM 的浮点结果也可能不同；如果必须用浮点，锁定编译器的浮点模型（如 `/fp:strict`），并禁止 FMA 指令
- **先建"确定性验证工具"再开发**：写一个跑两遍模拟并自动 Diff 世界状态的测试工具，在开发阶段就暴露非确定性代码，而不是到联调时才发现不同步
- **关键帧间隔是存储与加载速度的调节阀**：间隔太大会导致跳转时重放很久，太小则存储爆炸；通常 0.5~2 秒（30fps 下 15~60 帧）是甜点区
- **回放文件别忘了版本号**：游戏更新后旧录像可能无法正确回放，用版本号 + 向前兼容策略（如忽略未知字段）处理

### 🔗 相关问题

- 帧同步（Lockstep）和状态同步在网络游戏中有什么区别？
- 如何实现一个支持倍速和拖拽跳转的回放时间轴？
- 回放系统中如何处理随机数和 AI 决策的确定性？
