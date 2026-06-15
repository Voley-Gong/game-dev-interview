---
title: "游戏中的随机数生成与种子机制如何设计？"
category: "programming"
level: 3
tags: ["随机数", "PRNG", "程序化生成", "确定性"]
related: ["programming/floating-point-precision", "programming/bit-manipulation-game"]
hint: "为什么 Minecraft 同一个种子生成的世界完全一样？PRNG 算法怎么选？"
---

## 参考答案

### ✅ 核心要点

1. **伪随机（PRNG）的本质**：计算机生成的是确定性伪随机数——给定相同种子和算法，输出序列完全一致，这既是特性（可复现）也是安全隐患（不可用于加密）
2. **种子机制核心价值**：程序化生成（地形/关卡/掉落）、确定性回放、多人同步、调试复现——只需传递一个整数种子即可重建整个随机世界
3. **算法选择影响巨大**：`Math.random()` 不可控种子且统计性一般；LCG 简单但周期短；xorshift128+ / PCG 统计性优、速度快、适合游戏；Mersenne Twister 周期极长但状态大
4. **分布控制**：均匀分布不是唯一需求，游戏常需正态分布（属性随机）、加权随机（掉落表）、泊松分布（事件触发频率）等，需在 PRNG 基础上叠加分布变换
5. **多流随机**：同一关卡内不同子系统（地形生成、AI 行为、掉落）应使用独立随机流（不同种子），避免修改一处影响全局可复现性

### 📖 深度展开

**1. xorshift128+ 实现（游戏推荐）**

```typescript
// xorshift128+：速度快、统计性优秀、状态仅 128bit
// 被V8引擎用于 Math.random() 的底层实现
class XorShift128Plus {
  private state: [bigint, bigint];

  constructor(seed: number) {
    // 用 SplitMix64 将单种子扩展为两个128bit状态
    const s = this.splitMix64(BigInt(seed));
    this.state = [s, this.splitMix64(s)];
    // 保证非全零初始状态
    if (this.state[0] === 0n && this.state[1] === 0n) {
      this.state[0] = 1n;
    }
  }

  private splitMix64(seed: bigint): bigint {
    let z = (seed + 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFn;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & 0xFFFFFFFFFFFFFFFFn;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & 0xFFFFFFFFFFFFFFFFn;
    return z ^ (z >> 31n);
  }

  next(): bigint {
    let [s1, s0] = this.state;
    this.state[0] = s0;
    s1 ^= (s1 << 23n) & 0xFFFFFFFFFFFFFFFFn;
    s1 ^= (s1 >> 17n) ^ s0 ^ (s0 >> 26n);
    this.state[1] = s1;
    return (s0 + s1) & 0xFFFFFFFFFFFFFFFFn;
  }

  // 返回 [0, 1) 浮点数
  nextFloat(): number {
    // 取高53位转为浮点
    return Number(this.next() >> 11n) / Number(2n ** 53n);
  }

  // 返回 [min, max] 整数（无模偏差）
  nextInt(min: number, max: number): number {
    const range = max - min + 1;
    // 拒绝采样消除模运算偏差
    const limit = Math.floor(0x100000000 / range) * range;
    let r: number;
    do {
      r = Number(this.next() & 0xFFFFFFFFn);
    } while (r >= limit);
    return min + (r % range);
  }
}
```

**2. 种子化世界生成流程**

```
玩家输入种子: "20240116"
      │
      ▼
  哈希展开 (SplitMix64)
      │
      ├── 地形流 Seed_A → XorShift(Seed_A)
      │     ├── 高度图噪声 (Perlin/Simplex + 流随机种子)
      │     ├── 生物群系分布
      │     └── 矿物分布
      │
      ├── 建筑流 Seed_B → XorShift(Seed_B)
      │     ├── 城镇位置
      │     └── 地牢布局
      │
      └── 掉落流 Seed_C → XorShift(Seed_C)
            ├── 怪物掉落表
            └── 宝箱内容

✓ 同一种子 → 完全相同的世界（可分享种子给好友）
✓ 修改地形生成逻辑不影响掉落结果（流隔离）
```

**3. PRNG 算法对比**

```typescript
// LCG（线性同余生成器）：最简单的PRNG
class LCG {
  private state: number;
  constructor(seed: number) { this.state = seed; }
  next(): number {
    // 参数来自 Numerical Recipes
    this.state = (this.state * 1664525 + 1013904223) | 0;
    return (this.state >>> 0) / 4294967296;
  }
}
```

| 算法 | 速度 | 周期 | 状态大小 | 统计质量 | 游戏适用性 |
|------|------|------|---------|---------|-----------|
| LCG | 极快 | 2³² | 4B | 差（低位有规律） | 仅简单场景 |
| xorshift128+ | 极快 | 2¹²⁸⁻¹ | 16B | 优 | ⭐ 首选 |
| PCG32 | 快 | 2⁶⁴ | 8B | 极优 | ⭐ 首选 |
| Mersenne Twister | 中 | 2¹⁹⁹³⁷⁻¹ | 2.5KB | 极优 | 过重，状态太大 |
| Math.random() | 快 | 引擎决定 | 不透明 | 良 | 不可控种子 |

**4. 游戏常见分布变换**

```typescript
class GameRandom {
  private rng: XorShift128Plus;

  constructor(seed: number) { this.rng = new XorShift128Plus(seed); }

  // 加权随机：掉落表
  weightedPick<T>(items: { value: T; weight: number }[]): T {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = this.rng.nextFloat() * total;
    for (const item of items) {
      r -= item.weight;
      if (r <= 0) return item.value;
    }
    return items[items.length - 1].value;
  }

  // 正态分布（Box-Muller 变换）：属性随机生成
  normalFloat(mean: number, stddev: number): number {
    const u1 = this.rng.nextFloat() || 0.0001;
    const u2 = this.rng.nextFloat();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * stddev;
  }

  // 洗牌算法（Fisher-Yates）：卡牌抽取
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.rng.nextInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
```

### ⚡ 实战经验

- **永远不要用 Math.random() 做核心逻辑**：它的种子不可控，无法复现 Bug、无法做种子分享、无法网络同步。项目应全局封装一个可注入种子的 Random 实例
- **整数随机的模偏差**：`rng() % range` 在 range 不能整除随机数范围时会产生偏差（小数出现概率更高），用拒绝采样或 `Math.floor(rng() * range)` 处理
- **种子可复现是调试利器**：记录每局游戏的种子到日志，出现 Bug 时用相同种子+相同输入可 100% 复现，无需反复试错
- **不要复用同一随机流**：曾有一个项目地形生成和 AI 随机共用一个 RNG，改了地形生成代码后 AI 行为也变了，排查了一天。务必给每个子系统独立随机流
- **存档中的随机状态**：如果要支持"读档后继续随机生成"，必须将 RNG 的内部状态序列化存入存档，而不只是存种子（种子只能重建初始序列）

### 🔗 相关问题

- 如何实现"网络同步的随机数"——所有客户端看到相同的随机序列？
- 加密安全的 CSPRNG（如 crypto.getRandomValues）与游戏 PRNG 有何区别？什么时候必须用 CSPRNG？
- Perlin Noise 和 Simplex Noise 与 PRNG 的关系是什么？如何结合种子使用？
