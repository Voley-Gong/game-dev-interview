---
title: "Lockstep 帧同步的实现细节：确定性模拟与帧队列管理"
category: "network"
level: 4
tags: ["Lockstep", "帧同步", "确定性模拟", "帧队列", "网络同步"]
related: ["network/frame-vs-state-sync", "network/reconnect-state-recovery"]
hint: "为什么《王者荣耀》能确保所有玩家看到的团战画面完全一致？确定性模拟是帧同步的灵魂。"
---

## 参考答案

### ✅ 核心要点

1. **Lockstep 核心原理**：所有客户端在相同帧执行相同的输入集合，执行完全确定的逻辑模拟，从而保证各端状态一致
2. **确定性模拟（Deterministic Simulation）**：相同的输入 + 相同的初始状态 → 必须产生完全相同的输出，不能有任何随机性或浮点误差分歧
3. **帧队列（Input Buffer）**：每个客户端维护一个输入缓冲队列，收齐某一帧所有玩家的输入后才能执行该帧模拟
4. **延迟执行（Input Delay）**：人为延迟 N 帧执行输入，给网络传输留出缓冲窗口，避免等输入造成卡顿
5. **校验机制（Checksum / Hash）**：定期对比各端的游戏状态哈希，检测是否出现"分歧（Desync）"

### 📖 深度展开

**Lockstep 执行模型：**

```
时间轴 ──────────────────────────────────────────→

Frame N:     收集输入         执行模拟         渲染
              ┌──────┐        ┌──────┐        ┌──────┐
              │ 输入   │ ────→ │ 逻辑   │ ────→ │ 画面   │
              │ 汇集   │       │ 模拟   │       │ 渲染   │
              └──────┘        └──────┘        └──────┘

所有客户端在 Frame N 执行的输入集合 = {Player1的输入, Player2的输入, ...PlayerK的输入}
如果任何一个玩家的输入未到达 → 该帧无法执行 → 等待（卡顿）

Input Delay 方案：当前帧执行的是 N-2 帧的输入

实时输入:  N-2    N-1     N      N+1    N+2
           │      │       │       │      │
执行:     [✓执行] [缓冲]  [缓冲]  ─    ─
                   ↑
              收到的输入先存着，2帧后才执行
              给网络留出 2帧（~33ms@60fps）的传输窗口
```

**帧队列管理核心代码：**

```csharp
// Lockstep 帧同步管理器

public class LockstepManager {
    // key = 帧号, value = 该帧所有玩家的输入
    private Dictionary<int, FrameInputCollection> inputBuffer = new();

    // 当前要执行的帧号
    private int currentExecuteFrame;

    // 输入延迟帧数（通常 2-4 帧）
    private int inputDelay = 2;

    // 所有玩家 ID
    private HashSet<int> allPlayerIds;

    // 当前客户端的玩家 ID
    private int localPlayerId;

    /// <summary>
    /// 每帧由游戏主循环调用
    /// </summary>
    public void Update() {
        // 只要当前帧的输入收齐了，就执行
        while (inputBuffer.TryGetValue(currentExecuteFrame, out var collection)
               && collection.IsComplete(allPlayerIds)) {

            // 执行这一帧的逻辑模拟
            ExecuteFrame(currentExecuteFrame, collection);
            currentExecuteFrame++;
        }
        // 如果输入没收齐 → while 循环退出，等下一批输入到达
        // 此时游戏画面会"停顿"（卡帧），表现为角色不动
    }

    /// <summary>
    /// 收到其他玩家的输入（网络消息回调）
    /// </summary>
    public void OnRemoteInput(int frame, int playerId, PlayerInput input) {
        if (!inputBuffer.ContainsKey(frame)) {
            inputBuffer[frame] = new FrameInputCollection(frame);
        }
        inputBuffer[frame].SetInput(playerId, input);
    }

    /// <summary>
    /// 本地玩家输入
    /// </summary>
    public void OnLocalInput(PlayerInput input) {
        // 当前实时帧
        int realtimeFrame = currentExecuteFrame + inputDelay;

        if (!inputBuffer.ContainsKey(realtimeFrame)) {
            inputBuffer[realtimeFrame] = new FrameInputCollection(realtimeFrame);
        }
        inputBuffer[realtimeFrame].SetInput(localPlayerId, input);

        // 同时发送给其他客户端
        SendToAll(new NetFrameInput {
            frame = realtimeFrame,
            playerId = localPlayerId,
            input = input
        });
    }

    private void ExecuteFrame(int frame, FrameInputCollection inputs) {
        // 按固定顺序遍历所有玩家输入，确保各端一致
        foreach (int pid in allPlayerIds.OrderBy(x => x)) {
            var input = inputs.GetInput(pid);
            GameLogic.SimulatePlayer(pid, input);
        }

        // 帧结束后的状态校验
        uint checksum = GameLogic.ComputeStateHash();
        SendChecksum(frame, checksum);

        // 清理过期帧数据（保留最近 300 帧用于断线重连）
        if (inputBuffer.Count > 300) {
            var oldest = inputBuffer.Keys.Min();
            if (oldest < currentExecuteFrame - 300) {
                inputBuffer.Remove(oldest);
            }
        }
    }
}
```

**确定性模拟的敌人——浮点不一致：**

```
问题根源：
  不同平台（x86, ARM）、不同编译器、不同数学库对 float 运算的舍入行为可能不同
  
  Client A (PC/x86):     sin(0.123456) = 0.12313678
  Client B (Mobile/ARM): sin(0.123456) = 0.12313679
                                    ↑ 差 1 个 ULP
  
  一帧差一点 → 1000帧后蝴蝶效应 → 两端角色位置差了几百米 → Desync
```

```csharp
// ============ 确定性数学库要点 ============

// ❌ 绝对禁止的操作
float damage = Mathf.Sin(angle) * attackPower;       // Sin/Cos/Sqrt 实现不确定
float result = a / b;                                 // 如果 b 很小，不同平台结果不同
System.Random rng = new System.Random();              // 系统 Random 不是确定性的
GameObject.transform.position = physicsResult;        // 物理引擎不确定

// ✅ 正确做法

// 1. 使用定点数（Fixed Point）替代浮点数
public struct FFixed {
    public int rawValue; // 底层是整数运算，完全确定
    public const int FRACTIONAL_BITS = 16; // Q16.16 定点格式

    public static FFixed FromFloat(float f) =>
        new FFixed { rawValue = (int)(f * (1 << FRACTIONAL_BITS)) };

    public static FFixed operator +(FFixed a, FFixed b) =>
        new FFixed { rawValue = a.rawValue + b.rawValue };

    public static FFixed operator *(FFixed a, FFixed b) =>
        new FFixed { rawValue = (int)((long)a.rawValue * b.rawValue >> FRACTIONAL_BITS) };

    // 使用查表实现确定性的三角函数
    private static FFixed[] sinTable = BuildSinTable();
    private static FFixed[] BuildSinTable() {
        var table = new FFixed[65536]; // 2^16 个采样点
        for (int i = 0; i < 65536; i++) {
            double angle = (double)i / 65536.0 * Math.PI * 2;
            double sinVal = Math.Sin(angle); // 在构建时用高精度计算
            table[i] = FFixed.FromFloat((float)sinVal);
        }
        return table;
    }
    public static FFixed Sin(FFixed angle) {
        int idx = (angle.rawValue >> 8) & 0xFFFF; // 映射到表索引
        return sinTable[idx];
    }
}

// 2. 使用确定性随机数生成器（LCG 线性同余）
public struct DRng {
    private uint state;
    public DRng(uint seed) { state = seed; }
    public uint Next() {
        // 确定性公式：相同的 state 一定产生相同结果
        state = state * 1103515245 + 12345;
        return (state >> 16) & 0x7FFF;
    }
}

// 3. 禁用物理引擎，自己写确定性碰撞检测
//    Unity Physics / Box2D 都不保证跨平台确定性
```

**Desync 检测与处理：**

```
每 N 帧（通常 10-30 帧），各客户端发送自己的状态哈希给服务器

Server 收集各端 Frame 1000 的哈希：
  Client A: 0xA3F2B1C4
  Client B: 0xA3F2B1C4  ← 一致
  Client C: 0x5E8D9012  ← 不一致！Desync！

服务器判定 Client C 发生了 Desync → 通知其重新同步全量状态
（但帧同步通常无法"修复" Desync，只能让该客户端从断点重新追帧）
```

| Desync 原因 | 预防方式 |
|-------------|---------|
| 浮点不一致 | 全程使用定点数 |
| 随机数不确定 | 确定性 PRNG + 帧种子 |
| 物理引擎差异 | 禁用引擎物理，自写碰撞 |
| 容器遍历顺序 | 禁用 HashSet/Dict 遍历逻辑，用排序数组 |
| GC 导致时序错乱 | 逻辑帧中禁止分配堆内存 |

### ⚡ 实战经验

- **Input Delay 的调参是体验关键**：2 帧（33ms）延迟几乎无感知但容易因抖动卡顿，4 帧（66ms）流畅度好但操作有迟滞。竞技游戏通常设 2-3 帧，休闲游戏可以设 3-4 帧
- **乐观帧（Optimistic Lockstep）可以减少卡顿**：输入没收齐时先用空输入或预测输入执行，等真实输入到了再回滚纠正。类似 GGPO 的 Rollback Netcode，但实现复杂度大幅增加
- **Desync 发生时最快的修复是"重连追帧"**：让 Desync 的客户端断开重连，从最近的校验通过帧开始追帧。自研修复逻辑通常不值得
- **开发期一定要做 Desync 日志**：每次校验哈希不一致时，dump 当帧所有实体的状态到日志文件，对比两端差异。否则 Desync 调试只能靠"肉眼找不同"——这在一个 5v5 游戏中几乎不可能

### 🔗 相关问题

- GGPO 的 Rollback Netcode 与传统 Lockstep 有什么区别？
- 如何在帧同步中实现"观战"功能？
- 定点数数学库的精度损失对游戏手感有什么影响？
