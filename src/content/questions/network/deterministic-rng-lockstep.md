---
title: "帧同步中如何保证确定性随机数（Deterministic RNG）的一致性？"
category: "network"
level: 3
tags: ["帧同步", "确定性", "随机数", "Lockstep", "反作弊"]
related: ["network/lockstep-implementation", "network/deterministic-physics-lockstep", "network/frame-vs-state-sync"]
hint: "帧同步中所有客户端必须产生完全相同的随机数序列——一旦某个客户端的 RNG 哪怕偏差一次，整个模拟就会雪崩式崩溃。"
---

## 参考答案

### ✅ 核心要点

1. **确定性 PRNG 算法**：必须使用跨平台一致算法（如 LCG、XorShift、PCG），绝不能用 `Math.random()` 或 `std::rand()`
2. **统一随机种子**：所有客户端在帧开始时使用同一 seed，通常来自服务器下发的帧指令
3. **严格的调用顺序**：RNG 的调用顺序在所有客户端必须完全一致，否则序列会偏移
4. **浮点数跨平台陷阱**：不同 CPU/编译器的浮点实现存在微小差异，必须用定点数或查表法规避
5. **反作弊验证**：服务器或旁观者运行参考模拟，比对 RNG 输出，检测篡改客户端

### 📖 深度展开

#### 为什么 `Math.random()` 不能用？

```
Math.random() / std::rand() 的问题：
┌──────────────────────────────────────────────┐
│ ❌ 实现依赖运行时（V8 / SpiderMonkey / libc） │
│ ❌ 种子不可控（通常用系统时间 / 熵源）         │
│ ❌ 跨平台结果不同                              │
│ ❌ 引擎升级后算法可能变化                      │
└──────────────────────────────────────────────┘

帧同步的要求：
┌──────────────────────────────────────────────┐
│ ✅ 相同种子 → 相同序列 → 相同状态             │
│ ✅ 跨平台位级一致                              │
│ ✅ 算法实现固定，不随引擎版本变                │
└──────────────────────────────────────────────┘
```

#### 常用确定性 PRNG 算法对比

| 算法 | 周期 | 性能 | 一致性 | 适用场景 |
|------|------|------|--------|----------|
| **LCG（线性同余）** | 2^31 | 极快 | 好（需固定位宽） | C/C++ 老项目，简单场景 |
| **XorShift32/128** | 2^32 / 2^128 | 极快 | 优秀 | 大多数帧同步游戏首选 |
| **PCG32** | 2^64 | 快 | 优秀 | 统计性质好，推荐 |
| **Mersenne Twister** | 2^19937 | 较慢 | 优秀 | 需要超长周期 |
| **查表法（LUT）** | 固定 | 最快 | 完美 | 极端性能要求，内存换速度 |

#### 核心实现代码（C# 示例）

```csharp
// XorShift128 — 帧同步专用确定性 RNG
public struct DeterministicRNG
{
    private uint _s0, _s1, _s2, _s3;

    // 从服务器下发的帧种子初始化
    public DeterministicRNG(uint seed)
    {
        // SplitMix32 展开种子，避免相近种子产生相似序列
        _s0 = SplitMix32(seed);
        _s1 = SplitMix32(_s0);
        _s2 = SplitMix32(_s1);
        _s3 = SplitMix32(_s2);
    }

    private static uint SplitMix32(uint x)
    {
        x += 0x9E3779B9;          // 黄金分割常数
        x = (x ^ (x >> 16)) * 0x85EBCA6B;
        x = (x ^ (x >> 13)) * 0xC2B2AE35;
        return x ^ (x >> 16);
    }

    public uint NextUInt()
    {
        uint t = _s0 ^ (_s0 << 11);
        _s0 = _s1; _s1 = _s2; _s2 = _s3;
        _s3 = _s3 ^ (_s3 >> 19) ^ (t ^ (t >> 8));
        return _s3;
    }

    // [0, 1) 定点数 —— 用整数避免浮点差异
    public int NextRange(int min, int max)
    {
        // 定点数映射：将 uint 映射到 [min, max)
        return min + (int)(NextUInt() % (uint)(max - min));
    }

    // 概率判定（千分比）
    public bool CheckProbability(int perMille)
    {
        return NextUInt() % 1000u < (uint)perMille;
    }
}
```

#### 帧同步中的 RNG 使用流程

```
服务器帧指令到达
    │
    ├── Frame N: seed = 0xA3B2C1D0
    │
    ▼
所有客户端初始化 RNG
    rng = new DeterministicRNG(seed)
    │
    ▼
逐条执行操作指令
    ├── Player A 攻击 → rng.CheckProbability(250) → 暴击? → true
    │   └── 所有客户端得到相同结果：true
    ├── Player B 拾取 → rng.NextRange(0, 100) → drop = 73
    │   └── 所有客户端掉落相同物品
    └── NPC AI → rng.NextUInt() → 选择行为
    │
    ▼
帧结束时验证（可选）
    └── 将 rng 当前状态作为帧校验码上报
        ┌────────────────────────────┐
        │ Client A: checksum = 0x..F3 │
        │ Client B: checksum = 0x..F3 │ ← 一致！
        │ Client C: checksum = 0x..7A │ ← 不一致！可能有 bug 或作弊
        └────────────────────────────┘
```

#### 浮点数跨平台陷阱

```csharp
// ❌ 危险！不同平台浮点结果可能不同
float hitChance = rng.NextUInt() / 4294967296.0f;  // uint -> [0,1) float
// x86: 0.12345678f
// ARM: 0.12345679f  ← 最后一位不同！

// ✅ 安全：定点数或整数运算
int hitRoll = (int)(rng.NextUInt() % 10000);       // [0, 9999]
int threshold = (int)(hitChancePerMille * 10);
bool hit = hitRoll < threshold;
```

#### 种子管理策略

| 策略 | 描述 | 优缺点 |
|------|------|--------|
| **每帧种子** | 服务器每帧下发新种子 | ✅ 快速定位不同步帧；❌ 带宽开销 |
| **全局种子** | 对局开始时一次性下发 | ✅ 零额外带宽；❌ 出错难定位 |
| **链式种子** | seed_N = hash(seed_{N-1} + frame_input) | ✅ 自验证；❌ 任何帧出错后续全错 |
| **分段种子** | 每个逻辑系统独立 RNG | ✅ 系统间互不干扰；❌ 管理复杂 |

### ⚡ 实战经验

- **务必隔离逻辑 RNG 和表现 RNG**：UI 粒子效果、摄像机抖动等表现层不要使用确定性 RNG，否则表现需求一旦改变，逻辑序列就全变了。用两套 RNG 实例
- **JS 引擎陷阱**：`Math.imul()` 是确定性的，但位移运算在 JS 中对 32 位整数是安全的——务必测试目标平台。TypeScript 项目推荐用 `Uint32Array` 操作
- **C# .NET Core 陷阱**：`Random` 类在不同 .NET 版本算法不同！.NET Framework 和 .NET Core 6+ 的 `Random` 结果完全不同。帧同步项目必须自己实现 PRNG
- **调试工具**：实现帧回放系统——把每帧的 RNG seed 和所有 API 调用序列记录到文件，当不同步发生时 diff 两个客户端的调用日志，快速定位是哪次 RNG 调用偏离了

### 🔗 相关问题

- 帧同步的确定性物理引擎如何实现碰撞检测一致？
- 如何在帧同步游戏中实现伪随机掉落系统（PRD）？
- 多线程环境下确定性 RNG 如何保证调用顺序？
