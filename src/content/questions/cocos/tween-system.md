---
title: "Cocos Creator 的 Tween 缓动系统原理与使用是怎样的？"
category: "cocos"
level: 2
tags: ["Tween", "缓动", "动画", "动作系统"]
related: ["cocos/animation-system", "cocos/node-component-system"]
hint: "Tween 本质上是一个每帧更新数值的调度器，理解它才能避免内存泄漏和卡顿。"
---

## 参考答案

### ✅ 核心要点

1. **Tween 本质** → 逐帧修改目标属性值的链式动作调度器，非线程、非物理驱动
2. **链式 API** → `tween(node).to().by().call().start()` 构建动作序列
3. **缓动函数（Easing）** → 决定值变化曲线（线性、弹性、回弹等）
4. **生命周期管理** → Tween 需正确销毁，否则节点销毁后回调仍触发导致报错
5. **与 Action 系统的关系** → 3.x 推荐 Tween 替代旧的 `cc.Action` 系统

### 📖 深度展开

#### Tween 的工作原理

Tween 的核心是一个**时间驱动的值更新器**：

```
tween(node)
    .to(0.5, { position: v3(100, 200, 0) }, { easing: 'quadOut' })
    .call(() => { console.log('动画完成'); })
    .start();

执行流程：
1. start() → 注册到 TweenManager（每帧 update）
2. 每帧：deltaTime 累加 → 计算进度比 ratio (0~1)
3. ratio 经过 easing 函数变换 → 得到 easedRatio
4. 用 easedRatio 在 [startValue, targetValue] 之间插值
5. 将插值结果赋给 node.position
6. ratio >= 1 → 进入下一个链式动作
```

#### 常用缓动函数曲线对比

| Easing 名称 | 曲线特征 | 适用场景 |
|-------------|---------|---------|
| `linear` | 匀速 | 机械运动、进度条 |
| `quadOut` | 先快后慢 | UI 弹出、自然减速 |
| `quadIn` | 先慢后快 | 加速启动 |
| `quadInOut` | 慢-快-慢 | 通用移动 |
| `backOut` | 超出再回弹 | 按钮弹出、趣味反馈 |
| `elasticOut` | 弹性震荡 | 强调动画、奖励特效 |
| `bounceOut` | 弹跳落地 | 物理感着陆 |
| `sineInOut` | 平滑正弦 | 呼吸效果、缓入缓出 |

#### 代码示例：常见 Tween 模式

```typescript
import { tween, Vec3, UIOpacity, Node } from 'cc';

// 1. 基础位移 + 回弹
tween(node)
    .to(0.3, { position: new Vec3(0, 100, 0) }, { easing: 'backOut' })
    .start();

// 2. 透明度淡入淡出
const opacity = node.getComponent(UIOpacity);
tween(opacity)
    .to(0.2, { opacity: 0 })
    .call(() => node.active = false)
    .start();

// 3. 并行动画（同时缩放和旋转）
tween(node)
    .parallel(
        tween().to(0.5, { scale: new Vec3(1.2, 1.2, 1) }),
        tween().to(0.5, { angle: 360 })
    )
    .start();

// 4. 重复动画（呼吸效果）
tween(node)
    .by(0.8, { scale: new Vec3(0.1, 0.1, 0) }, { easing: 'sineInOut' })
    .by(0.8, { scale: new Vec3(-0.1, -0.1, 0) }, { easing: 'sineInOut' })
    .repeatForever()
    .start();

// 5. 延迟 + 序列
tween(node)
    .delay(0.5)
    .to(0.3, { position: new Vec3(100, 0, 0) })
    .call(() => this.onMoveComplete())
    .start();
```

#### Tween vs Animation 系统对比

| 维度 | Tween | Animation Clip |
|------|-------|----------------|
| 编辑方式 | 纯代码 | 编辑器可视化曲线 |
| 适用场景 | 简单属性动画、UI 动效 | 复杂骨骼/序列帧动画 |
| 性能开销 | 轻量（每帧几次数值赋值） | 需要采样曲线数据 |
| 复用性 | 代码封装复用 | 资源文件复用 |
| 可读性 | 链式调用直观 | 时间轴可视化 |
| 状态管理 | 需手动管理生命周期 | 组件托管，自动销毁 |

#### TweenManager 的更新机制

```
游戏主循环 (Game.tick)
  ↓
Director.update(deltaTime)
  ↓
TweenManager.update(deltaTime)
  ↓ 遍历所有活跃的 Tween
  每个 Tween:
    ├── 累加时间 → 计算当前 Action 进度
    ├── easing 变换 → 插值
    ├── 赋值目标属性
    └── 判断是否进入下一个 Action / 完成
```

### ⚡ 实战经验

- **节点销毁后 Tween 报错是经典踩坑**：节点被 `destroy()` 后，如果 Tween 仍在运行，会尝试访问已回收的对象。解决方案：在 `onDestroy()` 中调用 `Tween.stopAllByTarget(node)` 手动停止
- **`repeatForever` 的 Tween 不会自动销毁**：忘记 stop 会造成内存泄漏，尤其是 UI 频繁打开关闭时。每次打开时先 stop 旧的再创建新的
- **大量 Tween 同时运行会卡帧**：例如列表 100 个 item 同时做入场动画。建议错开 `delay` 或分帧启动
- **优先操作组件属性而非 Node 属性**：如透明度应操作 `UIOpacity.opacity` 而非直接改 Sprite 颜色，性能更好且兼容合批

### 🔗 相关问题

- Animation 系统和 Tween 如何配合使用？
- 如何实现 timeline 时间轴式的复杂动画编排？
- Tween 的 `parallel` 和 `sequence` 模式底层实现有何区别？
