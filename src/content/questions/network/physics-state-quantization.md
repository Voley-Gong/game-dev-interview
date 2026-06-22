---
title: "网络物理状态如何做量化与位压缩？位置、速度、旋转的最优编码方案"
category: "network"
level: 3
tags: ["序列化", "量化", "位压缩", "带宽优化", "定点数", "网络物理"]
related: ["network/serialization-compression", "network/snapshot-delta-sync", "network/rtt-jitter-packetloss"]
hint: "一个 float32 占 4 字节，但你真的需要 7 位有效数字来表示一个角色坐标吗？"
---

## 参考答案

### ✅ 核心要点

1. **量化（Quantization）是网络同步的第一道带宽防线**：将 32 位浮点数压缩到 12~16 位定点数，精度损失在亚厘米级，但带宽节省 50%~75%
2. **位置量化**：用世界包围盒 + 定点小数替代 float32，例如地图 4096m × 4096m，精度 0.0625m → 只需 16 位
3. **旋转量化**：四元数用"最小三分量"编码（丢弃最大分量，存剩余 3 个 + 2 位符号标记），从 128 位压缩到 ~48 位
4. **速度/加速度量化**：范围受限（通常 ±50 m/s），用对数量化或线性定点量化即可压缩到 12~14 位
5. **Delta 量化**：不传绝对值，传"与上一帧的变化量"，大量帧间数据是小增量 → 配合变长整数编码（Varint/ZigZag）效果倍增

### 📖 深度展开

#### 位置量化方案对比

```
方案 A: float32 原始传输
  X: 4 bytes, Y: 4 bytes, Z: 4 bytes = 12 bytes/player

方案 B: 16 位定点量化（地图 65536 × 65536，精度 1m）
  X: 2 bytes, Y: 2 bytes, Z: 2 bytes = 6 bytes/player
  节省 50%，但 1m 精度太粗

方案 C: 16 位量化 + 可选高精度模式
  近处玩家: 20 bit X + 20 bit Z + 12 bit Y = 52 bit ≈ 6.5 bytes
  远处玩家: 12 bit X + 12 bit Z + 8 bit Y = 32 bit = 4 bytes
```

#### 位置量化代码实现

```cpp
// 世界范围: [0, WORLD_SIZE]
// 量化位数: BITS
// 精度: WORLD_SIZE / (1 << BITS)

struct QuantizedPos {
    static constexpr float WORLD_SIZE = 4096.0f;  // 地图边长
    static constexpr int   BITS = 16;              // 16位量化
    static constexpr float SCALE = WORLD_SIZE / (1 << BITS);  // 0.0625m
    static constexpr float INV_SCALE = (1 << BITS) / WORLD_SIZE;

    // float → uint16
    static uint16_t Encode(float v) {
        float clamped = fmaxf(0.0f, fminf(WORLD_SIZE, v));
        return (uint16_t)(clamped * INV_SCALE + 0.5f); // 四舍五入
    }

    // uint16 → float
    static float Decode(uint16_t q) {
        return q * SCALE;
    }
};

// 完整的位置编码
struct PackedPosition {
    uint16_t x, z;   // 水平面 16bit
    uint16_t y;      // 高度 16bit
    // 总共 6 bytes，精度 6.25cm

    static PackedPosition Pack(Vector3 pos) {
        PackedPosition p;
        p.x = QuantizedPos::Encode(pos.x);
        p.y = QuantizedPos::Encode(pos.y);
        p.z = QuantizedPos::Encode(pos.z);
        return p;
    }

    Vector3 Unpack() {
        return {
            QuantizedPos::Decode(x),
            QuantizedPos::Decode(y),
            QuantizedPos::Decode(z)
        };
    }
};
```

#### 四元数量化：Smallest Three 编码

```
四元数有 4 个分量 (x, y, z, w)，但 |q| = 1
所以可以只存 3 个，第 4 个用公式恢复

关键洞察：绝对值最大的分量变化最小（导数最小）
→ 丢弃绝对值最大的分量，存剩余 3 个

编码格式 (48 bit):
┌─────────┬──────────┬──────────┬──────────┐
│ MaxIdx  │ comp1    │ comp2    │ comp3    │
│ 2 bits  │ 15 bits  │ 15 bits  │ 16 bits  │
└─────────┴──────────┴──────────┴──────────┘
  精度: ~0.005° 角度误差

总大小: 2 + 15 + 15 + 16 = 48 bit = 6 bytes
原始四元数: 16 bytes (4×float32)
节省: 62.5%
```

```cpp
struct QuantizedQuat {
    // 每个分量映射到 [-1/√2, 1/√2] → 16 bit signed
    static constexpr float RANGE = 0.707107f; // 1/√2
    static constexpr float SCALE = 32767.0f / RANGE;

    static uint64_t Pack(const Quat& q) {
        // 1. 找到绝对值最大的分量
        float absVals[4] = {fabsf(q.x), fabsf(q.y), fabsf(q.z), fabsf(q.w)};
        int maxIdx = 0;
        for (int i = 1; i < 4; i++)
            if (absVals[i] > absVals[maxIdx]) maxIdx = i;

        // 2. 存剩余三个分量，并恢复最大分量
        float comp[3];
        int ci = 0;
        for (int i = 0; i < 4; i++) {
            if (i != maxIdx) comp[ci++] = q[i];
        }

        // 3. 量化
        int16_t q0 = (int16_t)(comp[0] * SCALE);
        int16_t q1 = (int16_t)(comp[1] * SCALE);
        int16_t q2 = (int16_t)(comp[2] * SCALE);

        return (uint64_t)maxIdx | ((uint64_t)q0 << 2) |
               ((uint64_t)q1 << 18) | ((uint64_t)q2 << 34);
    }
};
```

#### Delta 编码 + ZigZag Varint

```
帧 N 位置: (1038.50, 256.00,  512.25)
帧 N+1 位置: (1038.56, 256.00, 512.31)
绝对值量化: 每帧 6 bytes
Delta 量化: Δ = (0.06, 0.00, 0.06)

ZigZag 编码小整数:
  0 → 0,  -1 → 1,  1 → 2,  -2 → 3,  2 → 4 ...
  小变化值只需要 1~2 字节 Varint

综合方案: 绝对量化(基准) + Delta量化(增量帧)
  关键帧 (每 30 帧): 发 6 bytes 绝对位置
  增量帧: 发 1~3 bytes Delta
  平均带宽: ~2 bytes/frame vs 12 bytes/frame (float32 原始)
```

#### 带宽对比表（100 人同屏，20 Hz 更新）

| 编码方案 | 单帧/玩家 | 100 人总带宽 | 年节省 |
|---------|----------|-------------|--------|
| float32 原始 (12B pos + 16B quat) | 28 bytes | 56 KB/s | — |
| 16bit 量化 (6B + 6B) | 12 bytes | 24 KB/s | 57% |
| Delta + Varint (平均 4B + 3B) | 7 bytes | 14 KB/s | 75% |
| Delta + BitStream 紧凑打包 | ~5 bytes | 10 KB/s | 82% |

### ⚡ 实战经验

1. **量化精度要和视觉体感匹配**：角色位置 6cm 精度人眼几乎看不出，但狙击枪瞄准镜下的远距离目标可能需要更高精度——做分级量化，近距离高精度、远距离低精度
2. **量化必须做往返测试（Round-trip Test）**：Encode→Decode 后的误差要在可接受范围内。建议写自动化测试：随机生成位置，量化→反量化，统计最大误差和 P99 误差
3. **位打包（BitStream）比字节对齐结构体更省**：不要每个字段按 byte 对齐，用 BitWriter 按 bit 写入。例如 3 个 11-bit 字段 = 33 bit（4 bytes 多 1 bit），比按 short 对齐省 2 bytes
4. **Don't over-optimize before profiling**：量化、压缩都增加 CPU 开销。先测量原始带宽是否真的是瓶颈，再决定压缩层数。有些项目三层压缩套娃，解码 CPU 反而成为瓶颈

### 🔗 相关问题

- Protobuf / FlatBuffers 等序列化框架内置的量化能力够用吗？什么时候需要手写 BitStream？
- Delta Compression 和 Delta Quantization 有什么区别？如何在同一系统中组合使用？
- 如何处理量化边界问题（角色站在地图边缘时坐标溢出）？
