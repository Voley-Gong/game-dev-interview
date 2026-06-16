---
title: "Cocos Creator 中 Spine 骨骼动画集成与性能优化怎么做？"
category: "cocos"
level: 3
tags: ["Spine", "骨骼动画", "性能优化", "动画系统"]
related: ["cocos/animation-system", "cocos/drawcall-optimization"]
hint: "Spine 动画很强大，但在大量角色同屏时性能断崖式下跌——瓶颈在哪里？"
---

## 参考答案

### ✅ 核心要点

1. **Spine 组件本质**：`sp.Skeleton` 组件基于 Cocos 的 MeshRenderer 渲染，每帧驱动骨骼变换更新顶点
2. **性能瓶颈三件套**：DrawCall 数量、CPU 蒙皮计算、动画帧更新开销
3. **GPU Skinning vs CPU Skinning**：开启 GPU 蒙皮可将骨骼计算转移到 GPU，大幅降低 CPU 压力
4. **动画合批条件**：相同 Spine 图集 + 相同材质 + 未被合批中断的渲染顺序才能合批
5. **内存管理**：Spine 动画资源包含 atlas + json/bin + 贴图，切换场景时必须手动释放

### 📖 深度展开

#### Spine 渲染流程

```
sp.Skeleton 组件
  ↓ 每帧 update()
骨骼动画状态机 (AnimationState)
  ↓ 插值计算骨骼变换
Bone 数据更新 (位置/旋转/缩放)
  ↓ 蒙皮计算（CPU 或 GPU）
顶点位置更新
  ↓ 提交 MeshRenderer 渲染
DrawCall
```

#### CPU Skinning vs GPU Skinning

| 维度 | CPU Skinning | GPU Skinning |
|------|-------------|-------------|
| 计算位置 | CPU 逐顶点计算 | Vertex Shader 中计算 |
| 性能（100角色） | ~15ms/帧 | ~3ms/帧 |
| 兼容性 | 全平台 | 需要着色器支持 |
| 内存占用 | 较高（顶点数据频繁上传） | 较低（骨骼矩阵以 Uniform/Texture 传入） |
| 适用场景 | 少量大角色 | 大量同屏小怪 |

开启 GPU Skinning 的方式：

```typescript
// Cocos Creator 3.x 中通过宏控制
// 在项目设置 → 宏配置中开启 CC_USE_SKINNING
// 或在代码中动态设置：

import { macro } from 'cc';

// 检查当前平台是否支持 GPU Skinning
if (sys.platform === sys.Platform.ANDROID || sys.platform === sys.Platform.IOS) {
    // 移动平台建议开启 GPU Skinning
    // 通过自定义材质 Shader 实现骨骼蒙皮
}
```

#### 性能优化策略

**策略一：控制动画复杂度**

```typescript
// 减少骨骼数量：将不重要的骨骼在导出时烘焙到顶点
// Spine 导出设置建议：
// - 精简骨骼数 ≤ 60 根（普通角色）
// - NPC/小怪 ≤ 30 根
// - 关闭不必要的 IK 约束和路径约束

// 运行时设置动画混合时间不宜过长
const skeleton = node.getComponent(sp.Skeleton)!;
skeleton.setMix('idle', 'run', 0.1); // 混合时间 0.1s 足够
```

**策略二：LOD 策略——距离衰减**

```typescript
import { _decorator, Component, Vec3, Camera, sp } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('SpineLOD')
export class SpineLOD extends Component {
    @property(Camera)
    camera: Camera = null!;

    @property(sp.Skeleton)
    skeleton: sp.Skeleton = null!;

    private _dist: number = 0;

    update(dt: number) {
        const pos = this.node.worldPosition;
        const camPos = this.camera.node.worldPosition;
        this._dist = Vec3.distance(pos, camPos);

        if (this._dist > 500) {
            // 远距离：降低动画帧率
            this.skeleton.timeScale = 0.5;
            // 切换到简化动画
            if (this.skeleton.animation !== 'idle_simple') {
                this.skeleton.animation = 'idle_simple';
            }
        } else if (this._dist > 200) {
            this.skeleton.timeScale = 1.0;
        } else {
            // 近距离：完整动画
            this.skeleton.timeScale = 1.0;
            if (this.skeleton.animation !== 'idle_full') {
                this.skeleton.animation = 'idle_full';
            }
        }
    }
}
```

**策略三：对象池复用**

```typescript
// Spine 对象池：避免频繁创建/销毁 Skeleton 组件
export class SpinePool {
    private _pool: Map<string, sp.Skeleton[]> = new Map();

    get(prefabName: string): sp.Skeleton {
        const pool = this._pool.get(prefabName);
        if (pool && pool.length > 0) {
            const skel = pool.pop()!;
            skel.node.active = true;
            return skel;
        }
        return null!; // 调用方负责实例化
    }

    put(prefabName: string, skeleton: sp.Skeleton) {
        skeleton.node.active = false;
        skeleton.clearTracks(); // 清除动画状态
        const pool = this._pool.get(prefabName) ?? [];
        pool.push(skeleton);
        this._pool.set(prefabName, pool);
    }

    // 场景切换时彻底释放
    clear() {
        this._pool.forEach((skeletons) => {
            skeletons.forEach(s => s.destroy());
        });
        this._pool.clear();
    }
}
```

#### DrawCall 合批陷阱

Spine 动画的合批比普通 Sprite 更脆弱：

```
渲染队列顺序：
  Skeleton A (图集1) → DrawCall 1
  Skeleton B (图集1) → ✅ 合批到 DrawCall 1
  Sprite C (图集2)   → DrawCall 2（中断了合批）
  Skeleton D (图集1) → DrawCall 3（无法回到 DrawCall 1）
```

解决方案：将大量 Spine 角色放在同一渲染层级，避免被其他渲染组件穿插。

### ⚡ 实战经验

1. **微信小游戏内存杀手**：一个 1024x1024 的 Spine 贴图约 4MB，10 个角色轻松吃掉 40MB。小怪统一使用 512x512 甚至 256x256 贴图，NPC 用共享图集
2. **`setAnimation` vs `addAnimation`**：频繁调用 `setAnimation` 会重置动画状态导致闪烁，连续动画应使用 `addAnimation` 入队
3. **Spine 换装性能**：使用 `setSlotAttachment` 换装时，每次调用都会触发顶点重算。批量换装时先 `skeleton.setSlotsToSetupPose()` 再逐个设置，最后 `skeleton.updateWorldTransform()` 一次性更新
4. **内存泄漏排查**：`sp.SkeletonData` 加载后即使节点销毁，资源仍驻留 `assetManager` 中。必须调用 `assetManager.release(skeletonData)` 或使用引用计数释放

### 🔗 相关问题

- Cocos Creator 原生动画系统（AnimationClip）与 Spine 各有什么优劣？
- DragonBones 与 Spine 在 Cocos 中的集成方案有何区别？
- 如何实现 Spine 动画的帧事件同步（如攻击判定帧）？
