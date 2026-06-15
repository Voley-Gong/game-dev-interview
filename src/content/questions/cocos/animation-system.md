---
title: "Cocos Creator 动画系统：AnimationClip、动画状态机与混合树如何运作？"
category: "cocos"
level: 2
tags: ["动画系统", "AnimationClip", "动画状态机", "混合树"]
related: ["cocos/node-component-system"]
hint: "从 AnimationClip 资源到 Marionette 动画图，理清 3.x 动画系统的完整链路。"
---

## 参考答案

### ✅ 核心要点

1. **AnimationClip** → 定义一段动画的关键帧数据（轨道：位置、旋转、缩放、材质、自定义属性）
2. **Animation 组件** → 挂载在节点上，管理多个 Clip 的播放（play / pause / crossFade）
3. **Marionette 动画系统** → 3.x 引入的可视化动画状态机（Animation Graph），支持状态切换与混合
4. **混合树（Blend Tree）** → 根据参数在多个动画间进行线性混合（1D / 2D / 加法混合）
5. **动画事件** → 在时间轴上标记事件帧，触发回调函数实现音效、特效同步

### 📖 深度展开

#### 动画系统架构总览

```
资源层:  AnimationClip (.anim 文件)
           ├── 曲线轨道（Position / Rotation / Scale / Color ...）
           ├── 事件轨道（Event frames）
           └── 元数据（wrapMode / duration / speed）
              ↓
组件层:  Animation Component (基础动画)
           ├── defaultClip
           ├── clips[]
           └── play() / crossFade() / pause()
              ↓
高级层:  Marionette Animation System (3.4+)
           ├── AnimationGraph (状态机)
           │    ├── States (动画状态)
           │    ├── Transitions (状态切换条件)
           │    └── Variables (参数变量)
           └── AnimationController (驱动组件)
```

#### AnimationClip 基础使用

```typescript
import { Animation, AnimationClip, SpriteFrame } from 'cc';

// 代码创建 AnimationClip（序列帧动画示例）
const clip = new AnimationClip();
clip.duration = 0.8;           // 总时长 0.8s
clip.name = 'idle';
clip.wrapMode = AnimationClip.WrapMode.Loop;

// 添加轨道：SpriteFrame 切换（序列帧）
const track = new AnimationClip.Track();
track.path = '__builtin__.sprite';
track.componentsIndex = 0;

const frames: { frame: number; value: SpriteFrame }[] = [
    { frame: 0,   value: frame0 },
    { frame: 0.2, value: frame1 },
    { frame: 0.4, value: frame2 },
    { frame: 0.6, value: frame3 },
];
track.curve.assignKeyFrames(frames);
clip.addTrack(track);

// 挂载并播放
const anim = node.getComponent(Animation);
anim.defaultClip = clip;
anim.play('idle');
```

#### 动画状态机（Marionette Animation Graph）

3.4+ 引入了可视化动画图系统，类似 Unity 的 Animator：

```typescript
// 代码控制 AnimationGraph 参数
import { AnimationGraph } from 'cc';

// 在 AnimationGraph 中预定义参数：
// - speed (Float): 角色移动速度
// - isGrounded (Bool): 是否在地面
// - attackTrigger (Trigger): 攻击触发器

// 运行时修改参数驱动状态切换
const animCtrl = node.getComponent(AnimationController);
animCtrl.setValue('speed', 5.2);
animCtrl.setValue('isGrounded', false);
animCtrl.setTrigger('attackTrigger');
```

**状态切换条件示例：**

| 当前状态 | 目标状态 | 切换条件 | 过渡时间 |
|----------|----------|----------|----------|
| Idle | Run | speed > 0.1 | 0.15s |
| Run | Idle | speed < 0.1 | 0.15s |
| Any | Jump | isGrounded == false | 0.05s |
| Jump | Fall | verticalSpeed < 0 | 0.1s |
| Any | Attack | attackTrigger (Trigger) | 0.0s |

#### 混合树（Blend Tree）

混合树允许根据参数在多个动画之间进行平滑过渡：

```
1D 混合（速度轴）:
  Speed: 0   → Idle Clip (权重 1.0)
  Speed: 2   → Walk Clip  (权重 0.7) + Idle (权重 0.3)
  Speed: 6   → Run Clip   (权重 1.0)

2D 混合（速度 + 方向）:
  ┌─────────────────────────┐
  │         Forward          │
  │     ↑                    │
  │  Walk-F  ●━━━ Run-F     │
  │     │      │             │
  │  Idle ●━━━━●━━━━ Run-B  │
  │     │      │             │
  │  Walk-B  ●━━━ Walk-L    │
  │     ↓                    │
  │       Backward           │
  └─────────────────────────┘
```

```typescript
// 加法混合示例：在基础动画上叠加伤害动作
// baseClip = Walk（下半身行走）
// additiveClip = HurtUpper（上半身受伤）
// 最终效果 = Walk + HurtUpper
anim.playAdditive('walk');
anim.playAdditive('hurtUpper');
```

#### 动画事件系统

```typescript
// 在 AnimationClip 的时间轴上添加事件
const clip = new AnimationClip();

// 方式1：代码添加事件帧
clip.events = [
    {
        frame: 0.3,           // 第 0.3 秒触发
        func: 'onAttackHit',  // 回调函数名
        params: ['sword_hit'], // 参数
    },
    {
        frame: 0.8,
        func: 'onAttackEnd',
        params: [],
    },
];

// 方式2：在节点组件上实现回调函数
@ccclass('CharacterAnimHandler')
export class CharacterAnimHandler extends Component {
    onAttackHit(effectName: string) {
        // 播放音效、生成特效
        console.log(`播放音效: ${effectName}`);
        this.spawnHitEffect();
    }

    onAttackEnd() {
        this.isAttacking = false;
    }
}
```

### ⚡ 实战经验

- **crossFade 淡入淡出时间要调**：默认的过渡时间可能不自然，角色移动类游戏一般设 0.1-0.2s，战斗类需要更短（0.05s）以保证手感。
- **Marionette 动画图是 3.4+ 功能**：低版本只能用基础 Animation 组件手动管理状态，升级前确认版本兼容性。
- **动画事件帧不是精确到毫秒的**：事件触发依赖帧率，30fps 动画的事件精度约为 33ms，不要在事件回调中做精确计时逻辑。
- **骨骼动画内存开销大**：每个 SkeletalAnimation 需要骨骼矩阵数据，同屏角色超过 20 个时考虑用 GPU Skinning 或简化骨骼层级。

### 🔗 相关问题

- 如何实现角色的连招系统（Combo System）？动画取消窗口如何设计？
- 动画状态机的分层动画（Layered Animation）如何实现上下半身分离？
- 如何使用动画融合树实现 8 方向移动的平滑过渡？
