---
title: "观战系统与回放（Spectator & Replay）的网络架构如何设计？"
category: "network"
level: 3
tags: ["观战", "回放", "录像", "延迟观战", "网络架构"]
related: ["network/frame-vs-state-sync.md", "network/snapshot-delta-sync.md"]
hint: "实时观战 30 秒延迟、万人赛事转播、回放系统——三者底层共用什么数据结构？"
---

## 参考答案

### ✅ 核心要点

1. **观战分两类**：实时观战（Live Spectator，通常 5–30s 延迟）和赛后回放（Replay/VOD）
2. **帧同步回放**最省带宽——只需存储/转发输入序列，客户端本地重放模拟
3. **状态同步观战**需要 Snapshot 广播或多播（Multicast），带宽与观战人数成正比
4. **延迟观战缓冲区（Delay Buffer）** 是实现"赛事延迟"的核心组件，本质是环形队列
5. **回放系统 = 序列化的游戏状态 + 输入日志 + 时间轴索引**，支持快进/倒退需额外的 Checkpoint

### 📖 深度展开

#### 架构总览

```
                    ┌──────────────┐
   游戏服务器 ──────→│ 观战中继服务器 │ ──────→ 直播观众（万级）
   (Authority)      │ (Relay/CDN)  │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │  延迟缓冲区   │
                    │  (30s ring)  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ↓            ↓            ↓
         实时观战者     裁判视角     回放录制器
        (15-30s延迟)   (0延迟)     (写入文件)
```

#### 延迟缓冲区实现（环形队列）

```csharp
public class DelayBuffer<T> where T : class {
    private readonly T[] _buffer;
    private readonly float _delaySeconds;
    private readonly float _tickInterval;
    private int _writeIndex;
    private float _elapsed;
    
    public DelayBuffer(float delaySeconds, float tickRate) {
        _delaySeconds = delaySeconds;
        _tickInterval = 1f / tickRate;
        int capacity = Mathf.CeilToInt(delaySeconds / _tickInterval) + 1;
        _buffer = new T[capacity];
    }
    
    // 每个 Tick 写入当前快照
    public void Push(T snapshot) {
        _buffer[_writeIndex] = snapshot;
        _writeIndex = (_writeIndex + 1) % _buffer.Length;
    }
    
    // 读取延迟前的快照
    public T PopDelayed() {
        // _writeIndex 已经前进了 capacity 步，当前读位置就是写位置
        return _buffer[_writeIndex];
    }
}
```

#### 帧同步回放（最省存储）

```csharp
// 回放文件结构
public struct ReplayHeader {
    public uint Magic;           // "REPL"
    public uint Version;
    public uint TickRate;        // 如 30
    public uint TotalFrames;
    public uint PlayerCount;
    public uint CheckpointInterval; // 每 N 帧一个存档点
}

public struct ReplayFrame {
    public uint FrameId;
    public PlayerInput[] Inputs; // 所有玩家输入
}

public struct Checkpoint {
    public uint FrameId;
    byte[] FullState;            // 完整世界状态的序列化
}

// 回放流程
public class ReplayPlayer {
    public void Play(float speed) {
        // 1. 跳到最近 Checkpoint（快进时）
        // 2. 加载完整状态
        // 3. 逐帧重放输入，推进确定性模拟
        // 4. 支持 -2x ~ +8x 速度
    }
}
```

#### 状态同步观战的带宽优化

| 策略 | 说明 | 效果 |
|------|------|------|
| **兴趣区域过滤** | 观战者只接收视角范围内的实体 | 减少 60–80% 带宽 |
| **自由视角 + 导播视角** | 导播模式只发一个相机位置 | 极低带宽，适合万人转播 |
| **Snapshot 降频** | 观战快照频率从 30Hz 降到 10Hz | 减少 66% 带宽 |
| **Delta Compression** | 只发变化字段 | 进一步压缩 |
| **UDP Multicast** | 中继层用组播，一次发送多人接收 | 服务端出口带宽恒定 |

#### 实时观战 vs 延迟观战

| 维度 | 实时观战（0–3s） | 延迟观战（15–30s） |
|------|------------------|---------------------|
| 公平性 | 可能泄露敌方位置 | 安全（标准电竞做法） |
| 带宽 | 需要快速推送 | 可缓冲+合并 |
| 实现难度 | 低（直接转发） | 中（需延迟缓冲区） |
| 适用场景 | 裁判、好友观战 | 赛事直播、反作弊 |

### ⚡ 实战经验

- **电竞游戏务必加 15s+ 延迟观战**，否则观众可以语音泄露对手位置（俗称"上帝视角作弊"）
- **回放系统用帧同步录制最省空间**——一场 30 分钟对局，输入序列可能只有几 MB，而状态快照录像可达数百 MB
- **Checkpoint 间隔是回放快进速度的关键**——间隔太大恢复慢，间隔太小文件膨胀；一般每 5–10 秒一个 Checkpoint
- **导播模式（Director Camera）是万人赛事的标配**——服务端只发一个相机位置 + 高亮事件流，观众端本地渲染，彻底解决带宽问题

### 🔗 相关问题

- 帧同步录像如何做到跨版本兼容（游戏更新后旧录像还能播放）？
- 观战系统中如何实现"精彩时刻自动回放"？
- 如何在 MOBA 中实现 10 万人同时观战一场决赛？
