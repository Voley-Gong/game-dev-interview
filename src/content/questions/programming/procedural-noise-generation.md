---
title: "游戏中如何生成自然连续的噪声？Perlin/Simplex/fBm 原理与实现"
category: "programming"
level: 3
tags: ["过程化生成", "柏林噪声", "Simplex", "fBm", "算法", "地图生成"]
related: ["programming/rng-seeded-random", "programming/tween-easing-interpolation", "programming/game-math-vector-matrix"]
hint: "纯随机太'乱'，正弦波太'规整'——柏林噪声如何造出既有随机性又有连续性的纹理，用于地形、云雾、纹理扰动？"
---

## 参考答案

### ✅ 核心要点

1. **噪声的目标是「带连续性的随机」**：`Math.random()` 每点独立、相邻毫无关系，做地形会出现「像素马赛克」；正弦波又过于规律。程序化噪声要在「宏观上随机不可预测、微观上邻域平滑过渡」之间取得平衡，同时还要可重复（同一种子出同一张图），这是地形、云雾、生物群系生成的基石。
2. **Value Noise 最简单但伪影重**：在整数网格点放随机值，中间用双线性/三次插值。实现 20 行搞定，但插值方向沿网格轴，会产生明显的「格子状」伪影和低对比度条纹，只适合做粗糙的云或过渡贴图。
3. **Perlin Noise（梯度噪声）是业界标准**：Ken Perlin 的思路——每个网格点不存随机值，而是存一个随机**梯度向量**；用点积把「采样点到网格点的方向」投影到梯度上得到贡献值，再用缓和曲线（`fade(t)=6t⁵-15t⁴+10t³`）插值。因为贡献是方向相关的，过渡各向同性更好，没有方块感，广泛用于地形高度图。
4. **Simplex Noise 是 Perlin 的改进版**：Perlin 在高维（3D/4D）时每个点要算 2ⁿ 个角贡献，开销指数爆炸；Simplex 改用**单纯形网格**（2D 是三角形、3D 是四面体），每个采样点只涉及 n+1 个角，把复杂度从 O(2ⁿ) 降到 O(n²)，且各向同性更好、无明显方向伪影，是现代首选。
5. **fBm（分形布朗运动）叠加多层噪声造细节**：单层噪声只有一种「频率」。fBm 把多个倍频（octave）的噪声叠加：每层频率翻倍（lacunarity）、振幅减半（persistence/gain），就像海岸线的自相似分形——近看有浪花、远看有波涛，地形因此有山脉+丘陵+碎石的层次感。
6. **种子 + 哈希保证确定性**：用 `hash(x, y, seed)` 代替 `Math.random()` 生成网格点的梯度/值。同一个种子无论在客户端、服务器、还是回放中都产生完全相同的噪声，这是多人同图、录像回放、跨平台一致性的前提。

### 📖 深度展开

#### 1. Perlin 噪声的 TypeScript 实现

```typescript
// 经典 2D Perlin。梯度表 + 256 位置换表，可换任意种子重排 permutation
const perm = new Uint8Array(512);
function seedPerlin(seed: number): void {
  const p = Array.from({ length: 256 }, (_, i) => i);
  let s = seed >>> 0;
  // 用线性同余生成器打乱 p，得到确定性置换表
  for (let i = 255; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
// 缓和曲线：让插值导数在端点为 0，消除方块感
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + t * (b - a);
// 梯度：8 个方向的单位向量，按哈希值选取
function grad(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0: return  x + y; case 1: return -x + y;
    case 2: return  x - y; case 3: return -x - y;
    case 4: return  x;     case 5: return -x;
    case 6: return  y;     default: return -y;
  }
}
// 输出范围约 [-1, 1]
function perlin2(x: number, y: number): number {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
  const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
  const x1 = lerp(grad(aa, xf, yf),       grad(ba, xf - 1, yf),     u);
  const x2 = lerp(grad(ab, xf, yf - 1),   grad(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v); // ≈ [-1,1]，乘 0.5+0.5 映射到 [0,1]
}
```

#### 2. fBm 分形叠加：单层噪声 → 有层次的地形

```typescript
// 叠加 octaves 层，每层频率×lacunarity、振幅×persistence
function fbm(x: number, y: number, octaves = 5, lacunarity = 2, persistence = 0.5): number {
  let total = 0, amp = 1, freq = 1, max = 0;
  for (let o = 0; o < octaves; o++) {
    total += perlin2(x * freq, y * freq) * amp;
    max += amp;
    amp *= persistence;   // 高频细节振幅递减 → 看起来是「附着」在大地形上的
    freq *= lacunarity;   // 频率翻倍 → 细节更密
  }
  return total / max; // 归一化到 [-1,1]
}
```

```
地形高度 = fbm(x*0.01, y*0.01, octaves=5) 的剖面（自相似分形）：

     /\      /\        高频小波纹（octave 4-5，振幅小）
  ___/  \____/  \___   中频丘陵   （octave 2-3）
_/                  \_ 低频大地形 （octave 0-1，振幅大）

octave 太少→光滑无细节；太多→毛刺+计算量翻倍。地形一般 4~6 层。
```

#### 3. 噪声类型对比

| 噪声类型 | 2D 单点开销 | 各向同性 | 伪影 | 典型用途 |
|----------|------------|---------|------|---------|
| Value Noise | O(4) | 差（轴向） | 方块/条纹 | 过渡贴图、简单云 |
| Perlin Noise | O(2ⁿ) | 中等 | 轻微格点 | 地形、云雾、扰动 |
| Simplex Noise | O(n²) | **好** | 几乎无 | 现代地形首选、3D 体积云 |
| Worley/Cellular | O(邻域) | 好 | 细胞状（特性） | 水面波纹、石头纹理、生物群系散布 |
| White Noise | O(1) | 无 | 纯马赛克 | 静态贴图、粒子分布 |

#### 4. 应用管线：噪声 → 游戏世界

```
fbm(x,y) 高度图          Simplex(x,y,0.3) 湿度      Worley 城镇散布
      │                          │                          │
      ▼                          ▼                          ▼
 海拔分层(<0海,<0.4沙滩,        雨林/草原/沙漠           POI 点位
       <0.7山地,>0.7雪山)            │                        │
      └─────────────┬──────────────┘                        │
                    ▼                                         ▼
            生物群系判定                                生成建筑/资源
                    │
                    ▼
            Domain Warping: 用第二层噪声扰动采样坐标
            sample(x + warp(x,y), y + warp(x,y))
            → 海岸线弯曲自然，告别「棋盘地形」
```

### ⚡ 实战经验

- **能上 GPU 就别在 CPU 算**：一次 1024² 的 fBm（6 octaves）CPU 要算约 600 万次 perlin，JS 单线程几十毫秒卡帧。地形/体积云这类大批量采样应写进 Shader 用 GPU 跑，CPU 只算少量 POI 点位。我们项目地形从 CPU 改 GPU fragment shader 后生成时间从 80ms 降到 2ms。
- **可平铺（tileable）噪声有专门技巧**：地图要无缝拼接时直接用 `perlin2(x,y)` 会在边界出现接缝。正确做法是用「环绕域」：在 3D 噪声里沿一个圆环采样 `perlin3(cos(θ)·r, sin(θ)·r, z)`，让 θ 走一圈天然闭合，2D 平面同理用 4D 噪声在两个环上采样。
- **域形变（Domain Warping）是廉价的高级感**：直接 fbm 地形有种「程序员感」。把采样坐标本身用另一层低频噪声扰动一下再采样，海岸线、山脉走向立刻变得蜿蜒自然，几乎零成本——这是低成本提升品质的杀手锏。
- **种子必须在所有端一致**：曾踩坑——JS 用 `Math.random()` 建表，服务器用 C# 同算法但浮点精度不同，结果同一种子客户端和服务端生成的资源点位置差了几米，玩家看到「明明这里没有矿」。务必用整数哈希生成置换表，避免浮点 `Math.random`，并在跨语言时统一哈希实现。

### 🔗 相关问题

- Simplex 噪声的单纯形网格在 3D 下如何划分空间，为什么能降到 O(n²)？
- 如何用噪声驱动的密度场（Marching Cubes）生成 3D 体素地形/洞穴？
- 多人联机下，如何保证所有玩家看到的程序化地形完全一致？
