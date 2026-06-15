---
title: "游戏中的浮点数精度：为什么 0.1 + 0.2 ≠ 0.3？帧同步怎么保证确定性？"
category: "programming"
level: 3
tags: ["浮点数", "IEEE 754", "精度问题", "帧同步", "定点数"]
related: ["programming/async-coroutine-scheduling", "programming/bit-manipulation-game"]
hint: "浮点数不是实数——累加误差、平台差异、NaN 传染，帧同步对战用 float 保证不了确定性，必须上定点数。"
---

## 参考答案

### ✅ 核心要点

1. **IEEE 754 浮点数是近似值**：`0.1` 在二进制中是无限循环小数（类似十进制中 `1/3`），存进 `float` 时被截断，所以 `0.1 + 0.2 === 0.3` 结果是 `false`。这不是 Bug 而是浮点数的本质——所有编程语言都一样。理解这一点才能解释为什么角色走了一万步后位置开始偏移。
2. **累加误差是隐形杀手**：每帧 `position += velocity * dt`，`dt` 本身有精度损失，累加 1 万帧后误差积累到 0.01-0.1 个像素级别。在平台跳跃游戏中表现为角色「卡在墙缝里」或「落到地面以下」——根因不是碰撞检测写错了，是浮点累加偏了。
3. **浮点比较永远用 epsilon**：`if (a === b)` 对浮点数几乎永远不成立。正确做法是 `if (Math.abs(a - b) < EPSILON)`，`EPSILON` 根据场景选 `1e-6`（位置）到 `1e-3`（UI 坐标）。但 epsilon 的选择本身就是个深坑——太小没用，太大导致逻辑提前触发。
4. **帧同步（Lockstep）必须用定点数**：不同 CPU 架构（x86 / ARM）、不同编译器的浮点运算中间精度不同（x87 80 位 vs SSE 32 位），同样的输入在 PC 和手机上算出的 float 结果可能差 `1 ULP`。帧同步对战游戏中这会导致「我这边打中了，对手那边没打中」——必须用定点数（整数模拟小数）保证所有平台结果完全一致。
5. **`NaN` 和 `Infinity` 会传染**：一次除以零产生 `NaN`，它会像病毒一样传播到所有后续计算——`NaN + 1 = NaN`，`NaN * 0 = NaN`。角色位置变成 `NaN` 后会瞬间传送到世界原点 `(0,0,0)`，整个场景的物体全飞了。必须在关键计算后做 `isFinite()` 检查。
6. **`float32` vs `float64` 的选择是性能与精度的权衡**：JS 的 `number` 永远是 `float64`（双精度），但 WebGL/Shader/GPU 纹理用 `float32`。把 `float64` 的坐标传给 GPU 的 `float32` uniform 会丢失精度，大世界地图（坐标 > 100000）时物体开始抖动——这是「浮点抖动」（Floating Point Jitter）的经典成因。

### 📖 深度展开

**1. IEEE 754 结构与精度丢失原理**

```
float32 结构（32 位 = 4 字节）：
┌─ Sign ─┬──── Exponent ────┬──────── Mantissa ────────┐
│  1 bit │     8 bits       │        23 bits            │
│  符号位 │   指数（偏移127）  │    尾数（隐含前导1.）       │
└────────┴──────────────────┴───────────────────────────┘

0.1 的二进制表示 = 1.10011001100110011...（无限循环）
存进 float32 时截断为 23 位尾数 → 0.100000001490...
                              ↑ 多出的精度被丢弃

float64（JS 的 number）尾数 52 位 → 0.1 存为 0.1000000000000000055...
精度更高但仍然不是精确的 0.1
```

```typescript
// 精度丢失的直观演示
console.log(0.1 + 0.2);          // 0.30000000000000004
console.log(0.1 + 0.2 === 0.3);  // false

// 大数 + 小数 = 精度丢失（float64 尾数只有 52 位）
const big = 1e16;     // 10000000000000000
console.log(big + 1 === big);    // true！1 被吞掉了
console.log(big + 2 === big);    // false，2 还在
// 大世界游戏坐标 > 1e7 时，每帧位移 0.001 可能被完全忽略

// 累加误差演示：模拟 60fps 下每帧移动 0.1
let pos = 0;
for (let i = 0; i < 600; i++) pos += 0.1;  // 10 秒后
console.log(pos);                 // 60.00000000000004（期望 60）
console.log(pos === 60);          // false
// 在平台游戏中：角色「应该」刚好到达平台边缘，但偏了 0.0000004 → 掉下去了
```

**2. 浮点比较的正确姿势：epsilon 与相对误差**

```typescript
// ❌ 错误：直接比较
if (hp === 0) { /* 角色死亡 */ }
// hp 经过多次浮点减法后可能是 0.0000001 → 永远不触发死亡

// ✅ 方法一：绝对误差 epsilon（适合已知数量级的场景）
const EPS_POS = 1e-4;   // 位置比较：0.0001 像素以内算相等
function approxEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

// ✅ 方法二：相对误差（适合数量级跨度大的场景）
function relEqual(a: number, b: number, rel = 1e-5): boolean {
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}
// relEqual(1000000.1, 1000000.2) → true（大数允许更大误差）
// relEqual(0.0000001, 0.0000002) → false（小数精度要求高）

// ✅ 方法三：ULP 比较（最精确，用于帧同步验证）
// 比较两个 float 的二进制表示相差几个 ULP（最后一位单位）
function ulpDistance(a: number, b: number): number {
  const fa = new Float32Array([a]);
  const ia = new Int32Array(fa.buffer);  // 重解释为 int32
  const fb = new Float32Array([b]);
  const ib = new Int32Array(fb.buffer);
  return Math.abs(ia[0] - ib[0]);  // ULP 距离
}
// ulpDistance(x, y) <= 4 → 认为「帧同步一致」（允许 4 ULP 误差）
```

**3. 定点数：帧同步确定性的终极方案**

```typescript
// 定点数（Q16.16 格式）：用 int32 的小数部分模拟浮点
// 高 16 位 = 整数部分，低 16 位 = 小数部分
// 精度：整数范围 ±32767，小数精度 1/65536 ≈ 0.000015

const FRAC_BITS = 16;
const FRAC_SCALE = 1 << FRAC_BITS;  // 65536

// float → 定点数
function toFixed(f: number): number {
  return Math.round(f * FRAC_SCALE) | 0;  // |0 强制转 int32
}
// 定点数 → float（仅用于显示/调试，逻辑运算全在定点域）
function toFloat(fixed: number): number {
  return fixed / FRAC_SCALE;
}

// 定点数加减法：直接运算（同一缩放比例）
const a = toFixed(1.5);  // 98304
const b = toFixed(2.25); // 147456
const sum = a + b;       // 245760 → toFloat = 3.75 ✅

// 定点数乘法：结果多乘了一个 SCALE，需要右移修正
const product = (a * b) >>> FRAC_BITS;  // 1.5 × 2.25 = 3.375 ✅
// 注意用 >>>（无符号右移），>> 在负数时会出错

// 定点数除法：先左移放大再除
const quotient = ((a << FRAC_BITS) / b) | 0;  // 1.5 / 2.25 = 0.666... ✅

// 平方根（牛顿迭代法，定点域运算，跨平台确定性）
function sqrtFixed(n: number): number {
  if (n <= 0) return 0;
  let x = n;
  for (let i = 0; i < 8; i++) {  // 固定迭代次数 → 确定性
    x = (x + (n << FRAC_BITS) / x) >> 1;  // 牛顿法：x = (x + n/x) / 2
  }
  return x;
}
```

| 方案 | 精度 | 跨平台确定性 | 性能 | 适用场景 |
|------|------|-------------|------|----------|
| `float64`（JS number） | 高（15-17 位有效数字） | ❌ 不同平台有 1-2 ULP 差异 | 基准 | 单机游戏、UI、非确定性逻辑 |
| `float32`（GPU/Shader） | 中（6-7 位有效数字） | ⚠️ 基本一致但有边界差异 | 快 2x | 渲染、Shader（非帧同步） |
| 定点数 Q16.16 | 中（±32767，小数 5 位） | ✅ 完全一致（整数运算） | 慢 2-5x | **帧同步对战** |
| 定点数 Q24.8 | 低（±8388607，小数 2 位） | ✅ 完全一致 | 慢 1.5x | 大地图帧同步 |
| 定点数 Q8.24 | 高小数精度（±127，小数 7 位） | ✅ 完全一致 | 慢 2-5x | 小范围高精度（弹道计算） |

### ⚡ 实战经验

- **大世界坐标抖动花了 3 天才定位**：开放世界地图坐标达到 `(50000, 0, 50000)`，角色在远处时模型开始高频抖动（每帧位置在 ±0.01 范围内随机跳）。根因是 `float32` 在 50000 附近的最小分辨率为 `50000 × 2^-23 ≈ 0.006`，每帧 0.001 的位移被精度吞掉。解决方案：相机和渲染用相对于角色中心的局部坐标（`renderPos = worldPos - cameraPos`），把坐标拉回原点附近，抖动消失。
- **帧同步不同步的噩梦**：MOBA 对战中 PC 玩家看到技能命中了，手机端玩家看到没命中——回放两端的输入完全一致但结果不同。排查发现 `Math.sin()` 在 V8（PC）和 JavaScriptCore（iOS Safari）的实现不同，返回值差了 2 个 ULP。改用查表法（预计算 0-360° 的 sin 值存进 `Int32Array`）后，两端结果完全一致。**帧同步中禁止使用任何 `Math` 库函数**，全部用定点数查表。
- **`NaN` 毁掉整个存档**：角色位移计算中 `velocity` 因除零变成 `Infinity`，`position += Infinity * dt` 后 position 变成 `NaN`，然后 `NaN` 传染到碰撞检测、视野计算、AI 决策——存档时 `JSON.stringify` 把 `NaN` 序列化成 `null`，读档后位置变成 `null` 导致类型错误崩溃。教训：位移计算后加 `if (!isFinite(pos)) { pos = lastValidPos; }` 兜底，并记录异常日志。
- **epsilon 选太大导致提前触发**：技能冷却判断 `if (cooldownRemaining < 0.01)` 结束冷却，但 0.01 秒在 60fps 下是 0.6 帧——技能提前不到 1 帧就结束了，玩家感知不到但服务端校验失败（服务端用 `=== 0` 判断）。改为 `cooldownRemaining <= 0` 并在累加时用整数毫秒（`cooldownMs -= dtMs`）避免浮点问题，服务端和客户端判断一致。
- **`JSON.stringify` 丢失浮点精度**：把 `0.1` 存进 JSON 再读出来，`JSON.parse("0.1")` 可能得到 `0.10000000000000001`（取决于引擎的 JSON 实现）。存档中的金币数量从 `100.1` 变成 `100.10000000000001`，UI 显示一串小数。解决方案：存档中所有浮点数先 `Math.round(x * 1000) / 1000` 保留 3 位小数，或直接存整数（以「千分之一」为单位）。

### 🔗 相关问题

1. 帧同步游戏中如何处理物理引擎（如 Box2D）的浮点不确定性？是否需要自己用定点数重写物理引擎？
2. WebGL 中 `highp` / `mediump` / `lowp` 浮点修饰符在不同 GPU 上的实际精度差异有多大？移动端 Shader 精度坑有哪些？
3. 如果游戏不需要帧同步，`float64`（JS 默认）的性能比 `float32` 差多少？什么情况下应该手动用 `Float32Array`？
