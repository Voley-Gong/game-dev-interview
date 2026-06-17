---
title: "游戏中的数值插值与缓动函数（Lerp / Easing / Tween）怎么实现？"
category: "programming"
level: 2
tags: ["缓动", "插值", "动画", "数学", "性能优化"]
related: ["programming/async-coroutine-scheduling", "programming/floating-point-precision"]
hint: "从相机平滑跟随到 UI 弹窗动画，Lerp 和缓动函数是每帧都在跑的底层基石——但帧率无关和过冲是两个大坑。"
---

## 参考答案

### ✅ 核心要点

1. **Lerp 是线性插值的本质**：`a + (b - a) * t`，`t∈[0,1]`。它把"从 A 到 B"抽象成一个 0→1 的进度问题，相机跟随、血条填充、进度条全都建立在这条公式上。理解它就能推导出几乎所有平滑运动。
2. **帧率无关是第一道坎**：每帧固定 `t=0.1` 在 60fps 和 30fps 下表现完全不同。必须用 `t = 1 - pow(1 - rate, dt * 60)` 这种指数衰减形式，让运动曲线与帧率解耦，否则高刷屏上相机飞太快、低帧率上又黏糊。
3. **缓动函数（Easing）赋予生命感**：线性运动机械呆板，`easeOutCubic`、`easeInOutQuad` 等非线性映射让 UI 弹窗有"惯性"、角色起跳有"蓄力"。缓动不是花活，是交互手感的灵魂。
4. **指数平滑适合"持续追随"**：相机跟随用 `pos = lerp(pos, target, t)` 每帧递归，天然渐近收敛、永不过冲，是处理"目标会变"场景的首选；而固定时长的 Tween 适合"一次性动画"。
5. **Tween 引擎要管生命周期**：UI 动画、技能特效这类"播一次就完"的动画，用 Tween 引擎统一管理时长、缓动、回调、取消，别满地 `setInterval`——否则页面切换时动画还在跑、回调还在触发。
6. **警惕浮点误差累积**：指数平滑每帧 `lerp` 永远不会精确到达 target，长期累积会有肉眼可见的抖动；到达阈值后要"吸附"（snap）到目标值，否则血条永远差 0.001 像素。

### 📖 深度展开

**1. Lerp 公式族与帧率无关化**

```typescript
// 最朴素的 Lerp —— ❌ 帧率相关，高刷屏上运动变快
function lerpNaive(a: number, b: number, t: number) {
  return a + (b - a) * t;        // t 是"每帧靠近的比例"
}
// camera.pos = lerpNaive(camera.pos, target, 0.1);  // 60fps 快、30fps 慢

// ✅ 帧率无关的指数平滑
// 思路：把"每帧靠近 10%"换算成"每秒靠近的固定比例"
function smoothDamp(current: number, target: number, rate: number, dt: number) {
  // rate=0.1 表示"60fps 下每帧靠近 10%"，换算成任意 dt 都等价
  const t = 1 - Math.pow(1 - rate, dt * 60);
  return current + (target - current) * t;
}
// camera.pos = smoothDamp(camera.pos, target, 0.1, dt);  // 144Hz 也好、30Hz 也好，曲线一致
```

```
帧率无关性验证（同样的 rate=0.1，从 0 追到 100）：
  60fps：第 1 帧 → 10，第 2 帧 → 19，... 约 0.5s 到 95
  30fps（dt 翻倍）：t 自动变大，每帧多靠近一倍 → 曲线重合，耗时相同
  关键：pow(1-rate, dt*60) 让"单位时间"而非"单位帧"成为运动标尺
```

**2. 缓动函数库与曲线对比**

```typescript
// 常用缓动函数（输入 t∈[0,1]，返回变换后的 t）
const Easing = {
  linear:      (t: number) => t,
  easeInQuad:  (t: number) => t * t,                    // 蓄力感
  easeOutQuad: (t: number) => t * (2 - t),              // 减速入场
  easeInOutQuad:(t:number)=> t < 0.5 ? 2*t*t : -1+(4-2*t)*t,
  easeOutCubic:(t: number) => 1 - Math.pow(1 - t, 3),   // 弹窗常用，有惯性
  easeOutBack: (t: number) => {                         // 轻微过冲，活泼
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeOutElastic:(t:number)=>{                          // 弹性回弹
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1
      : Math.pow(2, -10*t) * Math.sin((t*10-0.75)*c4) + 1;
  },
};
// 用法：进度 t 经过缓动函数映射，再喂给 lerp
function tween(a:number,b:number,elapsed:number,duration:number,ease=linear){
  const t = Math.min(elapsed / duration, 1);   // 线性进度
  return a + (b - a) * ease(t);                // 缓动后的插值
}
```

| 缓动 | 曲线手感 | 典型游戏场景 | 注意事项 |
|------|----------|--------------|----------|
| linear | 匀速，机械 | 进度条、加载 | UI 上显得僵硬 |
| easeInQuad | 越来越快 | 角色冲刺蓄力 | 终点突停，慎用于位移 |
| easeOutCubic | 快出慢收 | UI 弹窗入场、奖励飞出 | 弹窗动画黄金标准 |
| easeOutBack | 末端过冲再回 | 按钮点击反馈 | 过冲量靠 c1 调 |
| easeOutElastic | 多次回弹 | 金币掉落、得分跳动 | 时长要够长才好看 |

**3. Tween 引擎与生命周期管理**

```
Tween 引擎核心数据流
 ┌─────────────── 每帧 update(dt) ────────────────┐
 │  for each activeTween:                          │
 │    tween.elapsed += dt * tween.timeScale        │  倍速支持
 │    if tween.paused: continue                    │  暂停
 │    p = clamp(tween.elapsed / tween.duration)    │  进度
 │    v = lerp(from, to, tween.easing(p))          │  缓动插值
 │    apply(v)                                     │  写回目标属性
 │    if p >= 1: tween.onComplete(); remove()      │  完成回调
 └─────────────────────────────────────────────────┘
   场景销毁时必须 killAll()，否则回调操作已销毁节点 → 崩溃
```

```typescript
// 极简 Tween 引擎：支持链式、缓动、取消、回调
class Tween {
  private tasks: { from:number; to:number; dur:number; elapsed:number;
                   ease:(t:number)=>number; onUpdate:(v:number)=>void;
                   onComplete?:()=>void }[] = [];
  paused = false; timeScale = 1; dead = false;

  to(from:number,to:number,dur:number,ease:(t:number)=>number,
     onUpdate:(v:number)=>void,onComplete?:()=>void){
    this.tasks.push({from,to,dur,elapsed:0,ease,onUpdate,onComplete});
    return this;
  }
  update(dt:number){
    if(this.paused||this.dead) return;
    const t=this.tasks[0]; if(!t){return;}
    t.elapsed += dt*this.timeScale;
    const p=Math.min(t.elapsed/t.dur,1);
    t.onUpdate(t.from+(t.to-t.from)*t.ease(p));
    if(p>=1){t.onComplete?.(); this.tasks.shift();
             if(this.tasks.length===0) this.dead=true;}
  }
  kill(){ this.dead=true; }   // 场景销毁时调用，阻断后续回调
}
```

### ⚡ 实战经验

- **相机跟随用帧率无关的指数平滑**：曾用 `lerp(pos,target,0.1)` 做相机，60fps 手机丝滑，上了 120Hz iPad 相机像装了推进器飞过头。改成 `smoothDamp(pos,target,0.15,dt)` 后所有设备曲线一致，调参时只看"每秒追上多少"而非"每帧追上多少"。
- **UI 动画忘记跟场景绑定生命周期**：弹窗 Tween 播到一半被关闭，`onComplete` 回调里还在 `node.scale=1`，操作已销毁节点直接报错。所有 Tween 启动时登记到所属 UI，关闭/切场景时批量 `kill()`，宁可动画被打断也别崩溃。
- **血条用纯 lerp 永远抖动**：`hp = lerp(hp, target, 0.1)` 每帧靠近 10%，但永远到不了精确值，肉眼看到血条在目标值附近 0.5px 抖。加个吸附阈值：`if(Math.abs(hp-target)<0.5) hp=target;` 瞬间清爽。
- **缓动函数别套在指数平滑上**：把 `easeOutBack` 塞进相机的 `smoothDamp`，结果相机来回过冲像晕船。缓动函数是给"固定时长一次性动画"用的，持续追随的指数平滑天然就是 `easeOut`，别叠。
- **`dt` 突变（卡顿后的大帧）会让 Tween 跳变**：一次 GC 卡了 200ms，`dt=0.2` 直接让所有 Tween 瞬移到终点。对 `dt` 做 `clamp(dt, 0, 0.05)` 上限封顶，卡顿后动画"慢慢追"而非"瞬移"。

### 🔗 相关问题

1. 弹簧物理（Spring-Damper）和指数平滑有什么区别？为什么《怪物猎人》的相机跟随用弹簧而非 lerp？
2. 如何实现路径动画——让物体沿贝塞尔曲线移动？Catmull-Rom 样条在相机轨道路径中怎么用？
3. 缓动函数背后的数学：贝塞尔曲线怎么表示缓动？为什么 `cubic-bezier(0.25,0.1,0.25,1)` 对应 CSS 的 ease？
