---
title: "Cocos Creator 3.x 粒子系统原理与性能优化怎么做？"
category: "cocos"
level: 2
tags: ["粒子系统", "性能优化", "渲染", "特效"]
related: ["cocos/render-pipeline", "cocos/drawcall-optimization", "cocos/profiler-and-performance"]
hint: "从粒子发射器到 GPU 渲染，大量粒子同屏时瓶颈在哪里？如何用对象池、LOD、GPU 实例化来优化？"
---

## 参考答案

### ✅ 核心要点

1. **ParticleSystem 架构**：发射器（Emitter）→ 模拟器（Simulator）→ 渲染器（Renderer），三个阶段各有性能瓶颈
2. **CPU 模拟 vs GPU 模拟**：Cocos 默认在 CPU 端逐帧更新粒子，大量粒子时成为瓶颈；可通过自定义 Shader 迁移到 GPU
3. **粒子合批规则**：同材质 + 同纹理的粒子可合批，不同纹理或 BlendState 会打断合批
4. **生命周期管理**：粒子系统必须正确暂停 / 恢复 / 销毁，否则持续消耗 CPU
5. **LOD 策略**：远处粒子减少发射率、降低贴图精度，甚至替换为简单 Sprite

### 📖 深度展开

#### 粒子系统完整管线

```
ParticleSystem 组件
    │
    ├── Emitter（发射器）
    │     ├── 发射率（Rate）→ 每帧生成 N 个粒子
    │     ├── 发射形状（Box / Sphere / Cone）
    │     └── 初始属性（速度、大小、颜色、生命周期）
    │
    ├── Simulator（模拟器，CPU 逐帧更新）
    │     ├── Position 更新（速度 × dt）
    │     ├── Force 应用（重力、风力、扰动）
    │     ├── Color / Size 渐变（Gradient / Curve）
    │     └── 碰撞检测（可选，开销大）
    │
    └── Renderer（渲染器）
          ├── 收集存活粒子的顶点数据
          ├── 按材质 + 纹理 + BlendState 分组
          ├── 合批提交 → DrawCall
          └── GPU 绘制（Billboard / StretchedBillboard / Mesh）
```

#### 粒子数量与性能的关系

| 粒子数量 | CPU 模拟耗时 | DrawCall 影响 | 内存占用 | 适用场景 |
|---------|-------------|--------------|---------|---------|
| < 200 | 可忽略 ( <0.2ms) | 1-2 DrawCall | 低 | UI 特效、简单技能 |
| 200-1000 | 中等 (0.5-2ms) | 2-5 DrawCall | 中 | 战斗特效、爆炸 |
| 1000-5000 | 较高 (2-8ms) | 5-15 DrawCall | 较高 | 大范围场景特效 |
| > 5000 | 严重瓶颈 (>8ms) | 可能 >20 DrawCall | 高 | 不推荐 CPU 模拟 |

> ⚠️ 经验法则：同屏粒子总数控制在 **2000 以内**（中端手机），超过则需要 GPU 方案。

#### 关键代码示例

```typescript
// ✅ 粒子系统池化管理
import { ParticleSystem, Node, instantiate, Prefab } from 'cc';

export class ParticlePool {
    private pool: ParticleSystem[] = [];
    private prefab: Prefab;

    init(prefab: Prefab, preSize: number = 5) {
        this.prefab = prefab;
        for (let i = 0; i < preSize; i++) {
            const node = instantiate(prefab);
            node.active = false;
            this.pool.push(node.getComponent(ParticleSystem)!);
        }
    }

    spawn(pos: Vec3): ParticleSystem {
        let ps = this.pool.find(p => !p.node.active);
        if (!ps) {
            const node = instantiate(this.prefab);
            ps = node.getComponent(ParticleSystem)!;
            this.pool.push(ps);
        }
        ps.node.setWorldPosition(pos);
        ps.node.active = true;
        // 重置粒子状态并播放
        ps.clear();
        ps.play();
        return ps;
    }

    // 在 update 中检查粒子是否播放完毕，自动回收
    recycle(dt: number) {
        for (const ps of this.pool) {
            if (ps.node.active && !ps.isPlaying) {
                ps.node.active = false;
            }
        }
    }
}
```

```typescript
// ✅ 粒子 LOD 策略：根据距离调整发射率
@ccclass('ParticleLOD')
export class ParticleLOD extends Component {
    @property(ParticleSystem)
    particle: ParticleSystem = null!;

    @property(Node)
    camera: Node = null!;

    private baseRate: number = 0;

    start() {
        this.baseRate = this.particle.rate; // 记录基础发射率
    }

    update(dt: number) {
        const dist = Vec3.distance(this.node.worldPosition, this.camera.worldPosition);

        if (dist > 30) {
            this.particle.rate = 0;          // 太远，直接关闭
        } else if (dist > 15) {
            this.particle.rate = this.baseRate * 0.3;  // 远，降到 30%
        } else if (dist > 8) {
            this.particle.rate = this.baseRate * 0.6;  // 中，降到 60%
        } else {
            this.particle.rate = this.baseRate;        // 近，全量
        }
    }
}
```

#### 常见粒子配置对比

| 配置项 | 高开销 | 推荐做法 | 说明 |
|-------|--------|---------|------|
| Collision | Type = World | 尽量关闭或用 Plane | 世界碰撞每帧做射线检测 |
| Renderer | Mesh 模式 | Billboard 模式 | Mesh 模式顶点数翻倍 |
| Trail | 开启 Trail | 仅关键粒子开 | Trail 会成倍增加顶点 |
| Texture Size | 512×512 | 128×128 或更小 | 粒子贴图通常不需要高分辨率 |
| Duration | 无限循环 | 有限时长 + 池化回收 | 循环粒子要手动管理生命周期 |
| Simulate Speed | 1.0（实时） | 可降到 0.5 | 慢速模拟减少视觉帧率需求 |

### ⚡ 实战经验

1. **粒子不是越华丽越好**：中端 Android 设备上，一个 800 粒子的特效就可能吃掉 3-4ms 帧时间。必须在目标设备上实测，而不是只在编辑器里看效果
2. **StopAction 设为 `Destroy` 是常见坑**：如果ParticleSystem 配了 `stopAction = Destroy`，每次播放完节点就被销毁，无法复用。应设为 `Disable` 并配合对象池管理
3. **粒子系统预编译**：首次播放粒子时会有 Shader 编译和纹理上传的卡顿（尤其 WebGL）。在 Loading 场景中预播放一次各特效，可避免运行时 spike
4. **多特效叠加的合批陷阱**：两个粒子特效叠在一起，如果纹理不同或 BlendMode 不同，会各自产生 DrawCall。将常用特效纹理合并到一张图集（Atlas）中可显著降低 DrawCall

### 🔗 相关问题

- Cocos Creator 的渲染管线中，粒子系统走的是哪个 Render Pass？
- 如何用自定义 Shader 实现 GPU 粒子模拟？
- 在战斗场景中，多个角色同时释放技能，如何控制特效总粒子数？
