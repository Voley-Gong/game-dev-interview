---
title: "贝塞尔曲线在游戏路径动画中怎么用？如何实现匀速运动？"
category: "programming"
level: 2
tags: ["贝塞尔曲线", "路径动画", "Catmull-Rom", "插值", "数学", "相机游廊"]
related: ["programming/tween-easing-interpolation", "programming/game-math-vector-matrix", "programming/numerical-integration-physics"]
hint: "不是线性插值——贝塞尔用控制点定义形状但参数 t 不等于弧长，匀速运动必须做弧长重参数化。"
---

## 参考答案

### ✅ 核心要点

1. **贝塞尔曲线由端点+控制点定义形状**：n 阶贝塞尔有 n+1 个控制点。一次（线性）= 两个端点（即直线 lerp）；二次=2 端点+1 控制点（抛物线段）；三次=2 端点+2 控制点（游戏中最常用，相机飞行、弹道、UI 曲线运动）。控制点"拉拽"曲线形状但曲线不经过中间控制点——直觉是"磁铁吸引而非路径经过"。
2. **De Casteljau 算法递归求值，数值最稳定**：不直接展开 Bernstein 多项式（高阶会出现数值误差和系数爆炸），而是逐层做线性插值——点对取 lerp 直到只剩一个点。几何意义清晰（逐层逼近）、数值稳定、实现简单，是引擎内部的标准实现方式。
3. **参数 t ≠ 弧长，匀速运动必须重参数化**：`B(t)` 里的 t 是参数比例（0 到 1），不是路程比例。曲线在控制点密集处运动"慢"、稀疏处"快"。物体匀速沿曲线移动，必须预先建一张"参数 t → 累计弧长"的查找表(LUT)，再按目标距离反查对应的 t。
4. **切向量 = 曲线导数，用于朝向**：对 `B(t)` 求导得切向量 `B'(t)`，归一化后即前进方向。相机沿曲线飞行时用切向量算朝向（look-at），让镜头"看着前方"而非侧着飞；弹道用切向量决定投射物旋转角度，避免"横着飞"。
5. **Catmull-Rom 样条经过所有点，更适合路径**：贝塞尔不经过中间控制点，做"经过若干航点"的巡逻/相机路径很不方便。Catmull-Rom 样条保证穿过每一个控制点且 C1 连续，能直接从一串航点生成平滑路径，是相机游廊、巡逻路线、NPC 巡游的首选。
6. **长路径用分段三次贝塞尔拼接**：单条高阶贝塞尔难调（动一个控制点全曲线变形）。实际把长路径拆成多段三次贝塞尔，段间保证 C1 连续（前段末端切线 = 后段首端切线）即可平滑拼接，编辑器里逐段调控制点，牵一发动全身的风险大幅降低。

### 📖 深度展开

**1. De Casteljau 求值 + 三次贝塞尔实现**

```typescript
interface Vec2 { x: number; y: number; }
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// De Casteljau：逐层线性插值，直到剩一个点。任意阶通用，数值稳定
function deCasteljau(points: Vec2[], t: number): Vec2 {
  let pts = points.slice();
  while (pts.length > 1) {
    const next: Vec2[] = [];
    for (let i = 0; i < pts.length - 1; i++) next.push(lerp(pts[i], pts[i + 1], t));
    pts = next;
  }
  return pts[0];
}
// 三次贝塞尔：P0(起点) P1 P2(控制点) P3(终点)
const cubicBezier = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number) =>
  deCasteljau([p0, p1, p2, p3], t);

// 切向量（导数）：用于朝向，归一化后即前进方向
function cubicTangent(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  // B'(t) = 3u²(P1-P0) + 6u·t(P2-P1) + 3t²(P3-P2)
  return {
    x: 3*u*u*(p1.x-p0.x) + 6*u*t*(p2.x-p1.x) + 3*t*t*(p3.x-p2.x),
    y: 3*u*u*(p1.y-p0.y) + 6*u*t*(p2.y-p1.y) + 3*t*t*(p3.y-p2.y),
  };
}
```

```
三次贝塞尔的 De Casteljau 构造 (t=0.5)：
P0 ●─────────○ P01                控制点 P1、P2 拉拽曲线
        ╲       ╲                   曲线经过 P0、P3
         ● ○ P02 ○ ● P12            不经过 P1、P2
              ╲
               ●  B(0.5) 最终点
P3 ●─────────○ P23
       P1 ●              ● P2
  → 每层点对取 lerp(t)，逐层收敛到一个点
```

**2. 匀速运动：弧长重参数化查找表 (LUT)**

```typescript
// 问题：B(t) 的 t 不等于路程比例。直接用 t 驱动会"忽快忽慢"
// 解决：预计算 N 个采样点的累计弧长，按距离反查 t

function buildArcLengthLUT(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, samples = 100) {
  const lut: { t: number; len: number }[] = [{ t: 0, len: 0 }];
  let prev = p0, accum = 0;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const pt = cubicBezier(p0, p1, p2, p3, t);
    accum += Math.hypot(pt.x - prev.x, pt.y - prev.y); // 累计弦长≈弧长
    lut.push({ t, len: accum });
    prev = pt;
  }
  return { lut, totalLength: accum };
}

// 给定目标距离 d，二分查找对应的 t（匀速运动核心）
function tForDistance(lut: { t: number; len: number }[], d: number): number {
  let lo = 0, hi = lut.length - 1;
  while (lo < hi - 1) {                 // 二分：O(log N)
    const mid = (lo + hi) >> 1;
    if (lut[mid].len < d) lo = mid; else hi = mid;
  }
  const a = lut[lo], b = lut[hi];
  const r = (d - a.len) / (b.len - a.len); // 段内线性插值
  return a.t + (b.t - a.t) * r;
}
// 用法：每帧 distance += speed * dt; t = tForDistance(lut, distance); pos = B(t);
```

| 参数 t | 累计弧长（归一化） | 匀速想要的 t | 偏差 |
|--------|-------------------|--------------|------|
| 0.0 | 0.000 | 0.000 | 0% |
| 0.2 | 0.082 | 0.200 | **59%**（此处实际才走 8.2% 路程） |
| 0.5 | 0.385 | 0.500 | 23% |
| 0.8 | 0.748 | 0.800 | 7% |
| 1.0 | 1.000 | 1.000 | 0% |

→ 上表说明：直接用 t=0.2 驱动物体只走了 8.2% 路程，比预期快了一倍多，视觉上"前冲后顿"。LUT 修正后全程匀速。

**3. 贝塞尔 vs Catmull-Rom vs B 样条：路径选型**

| 曲线类型 | 是否经过控制点 | 连续性 | 局部可控 | 典型游戏场景 |
|----------|---------------|--------|----------|--------------|
| 贝塞尔（三次） | 只过端点 | C1（段间） | 单段局部、多段联动 | 弹道、UI 抛物线、单段镜头 |
| Catmull-Rom | 经过所有点 | C1 连续 | 局部（4 点定一段） | 巡逻路径、相机游廊、NPC 巡游 |
| B 样条 (B-spline) | 不经过控制点 | C2 连续 | 强局部 | 高速赛车道、丝滑相机过渡 |
| 直线 lerp | 过两端点 | C0 | 完全局部 | 简单位移、Tween |

```typescript
// Catmull-Rom：给定 4 个航点 P0 P1 P2 P3，生成 P1→P2 之间穿过两端的曲线段
function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (2*p1.x + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y: 0.5 * (2*p1.y + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
  };
}
// 一串航点 waypoints[] → 对每相邻 4 点调用，自动生成穿过所有点的平滑路径
// 编辑器里策划拖拽航点即可，比手调贝塞尔控制点直观得多
```

### ⚡ 实战经验

- **不重参数化就别做匀速**：相机沿三次贝塞尔飞 3 秒，策划反馈"开头猛冲、中间减速"。实测 t=0.2 时实际才走 8% 路程，物体速度是预期的 2.5 倍。加 100 采样点 LUT + 二分查表后全程速度方差 < 2%，策划复测通过。LUT 只需构建一次、O(100) 内存，运行时查表 O(log 100)≈7 次比较，几乎零开销。
- **LUT 采样数要匹配曲线长度**：一条跨整个地图的长曲线用 100 采样点，每段间距太大导致匀速有轻微抖动（肉眼可见的 2-3px 跳变）。改成按 `samples = max(100, totalLength / 10)`（每 10 像素一个采样点）后抖动消失。短 UI 曲线用 30 点足够，别无脑堆 1000 浪费内存。
- **朝向用切向量别用速度差**：用 `(pos - prevPos)` 算朝向，在曲线首尾或拐点处 prevPos 接近当前点导致方向抖动、镜头甩头。改用解析切向量 `B'(t)` 归一化后做 look-at，首尾平滑、零抖动；切向量还能加平滑滤波（指数滑动平均）进一步去毛刺。
- **Catmull-Rom 首尾要补虚拟点**：航点序列 `[A, B, C]` 直接生成 Catmull-Rom 只能得到 B→C 段，A→B 段缺前导点生成不出来。常规做法是首尾各镜像补一个虚拟点（`P_-1 = 2*A - B`），就能生成完整 A→B→C 路径——否则巡逻 NPC 第一步会原地顿一帧。
- **移动端别每帧重建 LUT**：动态曲线（如跟踪移动目标的弹道）每帧重建 LUT 在低端机掉帧 5-8ms。改为"曲线变了才重建 + 缓存"，90% 的帧复用旧 LUT，开销降到 0.1ms；只有目标大幅移动触发重建，肉眼无感知。
- **分段贝塞尔保证 C1 连续**：长相机轨道拆成 8 段三次贝塞尔，最初没保证段间切线一致，过渡处镜头"咯噔"转向。强制约束"前段末切线 = 后段首切线"（即 P3-P2 方向 = Q1-Q0 方向）后 C1 连续，过渡丝滑。

### 🔗 相关问题

1. 弹道需要受重力影响（抛物线 + 物理下坠），用贝塞尔曲线模拟和用真实物理积分模拟各有什么优劣？什么场景下该用哪个？
2. 高速物体沿曲线运动时会出现"穿墙"（隧ne ling），如何结合连续碰撞检测 (CCD) 和弧长参数化解决？
3. 策划要在编辑器里可视化编辑巡逻路径，Catmull-Rom 和分段贝塞尔哪种对非技术人员更友好？如何设计控制点交互？
