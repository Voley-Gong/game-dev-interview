---
title: "帧同步中的确定性物理模拟如何实现？定点数、浮点一致性与会车漂移问题"
category: "network"
level: 4
tags: ["帧同步", "确定性模拟", "定点数", "物理引擎", "浮点一致性", "Lockstep"]
related: ["network/lockstep-implementation", "network/frame-vs-state-sync"]
hint: "为什么同样一段代码，在不同手机上车祸回放结果不同？浮点数不是确定性的吗？"
---

## 参考答案

### ✅ 核心要点

1. **确定性是帧同步的根基**：所有客户端在相同输入下必须产出完全相同的输出，差一个 bit 就会"蝴蝶效应式"地导致整局不同步
2. **IEEE 754 浮点数 ≠ 跨平台确定**：不同 CPU 架构、编译器优化级别、FMA 指令都会导致浮点运算结果的微小差异
3. **定点数（Fixed-Point）是主流解法**：用整数运算替代浮点，保证所有平台位精确一致
4. **确定性物理引擎需要从零构建**：Unity PhysX / Box2D 原生不具备跨平台确定性，需自研或使用 Lockstep-Box2D 等专用库
5. **运算顺序和溢出处理必须严格规范**：连 `a + b + c` vs `a + c + b` 的精度差异都要纳入控制

### 📖 深度展开

#### 浮点不确定性的根源

```csharp
// 你以为这段代码在所有设备上结果一样？错！
float a = 0.1f;
float b = 0.2f;
float c = a + b;

// PC x86:       c = 0.30000001192092896
// ARM 手机:     c = 0.30000001192092896  // 多数情况一致
// 但配合 FMA:   c = 0.300000012          // 编译器融合乘加后精度变了！
// 模拟器:       可能走 x87 80bit 精度，结果又不同
```

**导致浮点不确定的因素：**

| 因素 | 影响 | 示例 |
|------|------|------|
| FMA / Fused Multiply-Add | 硬件级精度提升，中间结果不截断 | `a * b + c` 被编译器融合 |
| 编译器优化 `-ffast-math` | 允许重排运算顺序 | 加法结合律被改变 |
| x87 vs SSE | 80bit 扩展精度 vs 32bit | 旧代码路径精度不同 |
| 不同架构端序 | ARM big-endian 罕见但存在 | 嵌入式设备 |

#### 定点数实现方案

```csharp
// Q格式定点数：用整数模拟小数
// Q16.16 = 16位整数 + 16位小数，总32位

public struct FInt  // Fixed-point Integer
{
    private const int SHIFT = 16;
    private const long ONE = 1L << SHIFT;

    private long rawValue;

    public static FInt FromInt(int v) => new FInt { rawValue = (long)v << SHIFT };
    public static FInt FromFloat(float v) => new FInt { rawValue = (long)(v * ONE) };

    public float ToFloat() => (float)rawValue / ONE;

    // 加法：直接相加，确定性保证
    public static FInt operator +(FInt a, FInt b) =>
        new FInt { rawValue = a.rawValue + b.rawValue };

    // 乘法：中间用 64bit 防溢出，最后右移
    public static FInt operator *(FInt a, FInt b) =>
        new FInt { rawValue = (a.rawValue * b.rawValue) >> SHIFT };

    // 除法：先左移再除，保留精度
    public static FInt operator /(FInt a, FInt b) =>
        new FInt { rawValue = (a.rawValue << SHIFT) / b.rawValue };

    // 平方根：牛顿迭代法或查表
    public FInt Sqrt()
    {
        if (rawValue <= 0) return new FInt { rawValue = 0 };
        long x = rawValue;
        for (int i = 0; i < 16; i++)
            x = (x + (rawValue << SHIFT) / x) >> 1;
        return new FInt { rawValue = x };
    }
}
```

#### 确定性物理引擎核心模块

```
确定性物理引擎架构
├── 数学库 (FInt)
│   ├── 向量 FVector2 / FVector3
│   ├── 矩阵 FMatrix
│   └── 三角函数查表 (Sin/Cos 精度到 Q16.16)
├── 碰撞检测
│   ├── AABB (轴对齐包围盒)
│   ├── 圆形/球形碰撞
│   ├── SAT (分离轴定理) — 多边形
│   └── 碰撞响应 (冲量解算)
├── 物理模拟
│   ├── 积分器 (显式 Euler 或 Verlet)
│   ├── 重力 / 摩擦力 / 弹力
│   └── 约束求解 (距离约束、角度约束)
└── 确定性保证
    ├── 运算顺序固定 (禁止编译器重排)
    ├── 整数溢出回绕规则统一
    └── 查表数据全平台一致
```

#### 确定性验证流程

```csharp
// 每帧将关键状态做哈希，用于校验同步
public uint ComputeStateHash()
{
    uint hash = 0;
    foreach (var entity in entities)
    {
        // 位置、速度、角度的定点数原始值
        hash ^= (uint)(entity.position.x.rawValue);
        hash = (hash << 5) | (hash >> 27);  // rotate hash
        hash ^= (uint)(entity.position.y.rawValue);
        hash = (hash << 5) | (hash >> 27);
        hash ^= (uint)(entity.velocity.x.rawValue);
        hash = (hash << 5) | (hash >> 27);
    }
    return hash;
}

// 各客户端每隔 N 帧上报 hash，服务器比对
// 发现不一致 → 标记 desync → 触发全量快照恢复
```

### ⚡ 实战经验

- **不要信任引擎自带物理**：Unity PhysX 内部使用 SIMD 和多线程，运算顺序不固定，同一场景同一帧都可能不同步。帧同步游戏必须自研或采购确定性物理引擎（如 Lockstep Physics）
- **`Mathf.Sin` 也不能用**：不同数学库的三角函数实现不同，必须用统一的查表方案，精度到定点数级别
- **序列化陷阱**：存档/回放/断线重连时，确保所有状态用定点数的整数原始值序列化，不要转成 `float` 再转回来——精度会丢
- **Debug 版和 Release 版可能不同步**：编译器优化级别不同可能导致浮点行为不同（尤其 `-O2` vs `-O0`）。建议 CI 流程中增加跨平台确定性哈希校验测试

### 🔗 相关问题

- 帧同步的帧队列和锁定机制如何设计？（→ lockstep-implementation）
- 不同步检测到之后，全量状态快照恢复还是回滚重演？各自的开销？
- 如何在 Unity 中禁用 PhysX 并替换为确定性物理？
