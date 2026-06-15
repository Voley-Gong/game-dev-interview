---
title: "Cocos Creator 物理引擎（Cannon.js / Bullet）如何使用？有哪些常见陷阱？"
category: "cocos"
level: 2
tags: ["物理引擎", "Cannon.js", "Bullet", "性能优化"]
related: ["cocos/node-component-system", "cocos/render-pipeline"]
hint: "从物理世界配置到碰撞回调，理清 3.x 物理系统的正确使用方式和高频踩坑点。"
---

## 参考答案

### ✅ 核心要点

1. **物理后端可选** → 3.x 支持 builtin（仅触发器）、Cannon.js（轻量 AABB/SPHERE）、Bullet（完整 3D 物理，支持 Mesh 碰撞体）
2. **碰撞体组件** → BoxCollider / SphereCollider / MeshCollider 等，挂载在有 Node3D 变换的节点上
3. **刚体组件（RigidBody）** → 控制物理模拟行为（动态、静态、运动学）
4. **碰撞检测流程** → Broadphase（粗筛）→ Narrowphase（精检测）→ 接触求解 → 回调通知
5. **物理世界步进** → 引擎在固定时间步（FixedStep）内更新物理模拟，与渲染帧率解耦

### 📖 深度展开

#### 物理后端对比

| 特性 | builtin | Cannon.js | Bullet (bullet-wasm) |
|------|---------|-----------|----------------------|
| 碰撞检测 | 仅事件触发 | AABB / Sphere / Box | 完整支持（含 Mesh） |
| 刚体模拟 | ❌ | ✅ | ✅ |
| 关节/约束 | ❌ | ✅ 基础 | ✅ 完整 |
| 性能开销 | 极低 | 中等 | 较高 |
| 适用场景 | UI / 简单触发 | 2D / 简单 3D | 完整 3D 物理游戏 |

#### 物理世界配置

```typescript
// project.json 或代码配置物理后端
import { PhysicsSystem, PhysicsGroup } from 'cc';

// 在项目初始化时选择物理后端
// 方式1：通过项目设置面板 → 物理引擎 → 选择 Cannon / Bullet
// 方式2：代码配置（需在引擎启动前）

// 物理分组与掩码（重要！碰撞过滤的核心）
export const PHYSICS_GROUPS = {
    DEFAULT:   1 << 0,  // 默认组
    PLAYER:    1 << 1,  // 玩家
    ENEMY:     1 << 2,  // 敌人
    PROJECTILE: 1 << 3, // 投射物
    WALL:      1 << 4,  // 墙壁
    TRIGGER:   1 << 5,  // 触发器
};
```

#### 碰撞体与刚体设置

```typescript
import {
    _decorator, Component,
    RigidBody, BoxCollider, SphereCollider,
    ICollisionEvent, ITriggerEvent,
    ERigidBodyType
} from 'cc';
const { ccclass, property } = _decorator;

@ccclass('EnemyPhysics')
export class EnemyPhysics extends Component {
    start() {
        // 配置刚体
        const rb = this.getComponent(RigidBody);
        rb.type = ERigidBodyType.DYNAMIC;   // 动态刚体
        rb.mass = 1.0;                       // 质量
        rb.linearDamping = 0.1;              // 线性阻尼
        rb.angularDamping = 0.5;             // 角阻尼（防止翻滚）
        rb.useGravity = true;

        // 配置碰撞体
        const collider = this.getComponent(BoxCollider);
        collider.size.set(1, 2, 1);         // 碰撞体尺寸
        collider.isTrigger = false;          // 是否为触发器（不产生物理碰撞）
        collider.material?.friction = 0.4;  // 摩擦系数

        // 碰撞回调（物理碰撞）
        collider.on('onCollisionEnter', this.onCollision, this);
        collider.on('onCollisionStay', this.onCollisionStay, this);

        // 触发器回调（穿透检测）
        collider.on('onTriggerEnter', this.onTrigger, this);
    }

    private onCollision(event: ICollisionEvent) {
        const otherCollider = event.otherCollider;
        console.log(`碰到: ${otherCollider.node.name}`);
        // event.contacts[0] 包含碰撞接触点信息
    }

    private onTrigger(event: ITriggerEvent) {
        console.log(`进入触发器: ${event.otherCollider.node.name}`);
    }
}
```

#### 碰撞过滤：分组与掩码

```typescript
// 碰撞过滤的核心规则：
// (A.group & B.mask) !== 0 && (B.group & A.mask) !== 0
// → A 和 B 才会发生碰撞

// 设置碰撞体分组和掩码
const playerCollider = playerNode.getComponent(BoxCollider);

// 玩家：属于 PLAYER 组，只与 WALL + ENEMY + TRIGGER 碰撞
playerCollider.group = PHYSICS_GROUPS.PLAYER;
playerCollider.mask =
    PHYSICS_GROUPS.WALL |
    PHYSICS_GROUPS.ENEMY |
    PHYSICS_GROUPS.TRIGGER;

// 子弹：属于 PROJECTILE 组，只与 ENEMY + WALL 碰撞
projectileCollider.group = PHYSICS_GROUPS.PROJECTILE;
projectileCollider.mask =
    PHYSICS_GROUPS.ENEMY |
    PHYSICS_GROUPS.WALL;
```

#### 射线检测（Raycast）

```typescript
import { physics, Vec3 } from 'cc';

// 射线检测：常用于点击拾取、视线判断、地面贴合
const ray = new geometry.Ray();
ray.o.set(0, 10, 0);  // 起点
ray.d.set(0, -1, 0);  // 方向（向下）

const mask = PHYSICS_GROUPS.WALL;  // 只检测墙壁
const maxDistance = 100;

if (PhysicsSystem.instance.raycastClosest(ray, mask, maxDistance)) {
    const result = PhysicsSystem.instance.raycastClosestResult;
    const hitPoint = result.distance;     // 碰撞距离
    const hitNode = result.collider.node; // 碰撞节点
    console.log(`击中 ${hitNode.name}，距离 ${hitPoint}`);
}
```

#### 物理步进与固定时间步

```
渲染帧（60fps，dt ≈ 16.6ms）
  ├── Frame 1
  │     └── FixedStep × 1 (dt = 16.6ms)
  ├── Frame 2 (渲染卡顿，dt = 33ms)
  │     └── FixedStep × 2 (每次 16.6ms，追赶)
  └── Frame 3
        └── FixedStep × 1

物理模拟使用固定步长，确保模拟稳定性。
如果帧率过低，多个物理步在一个渲染帧内执行。
```

### ⚡ 实战经验

- **刚体穿透（Tunneling）问题**：高速移动的子弹或物体可能穿透薄碰撞体。解决方案：使用射线检测（Continuous Collision Detection）替代纯物理模拟，或增大碰撞体厚度，或降低物理步长。
- **MeshCollider 性能陷阱**：MeshCollider 使用三角网格做碰撞检测，复杂模型（上千三角面）会导致物理帧严重卡顿。应使用简单碰撞体（Box / Sphere / Capsule）组合近似替代，只在静态场景物体上使用 MeshCollider。
- **物理模拟与动画冲突**：如果角色同时有 RigidBody 和动画控制 position，两者会打架。解决方案：运动学刚体（Kinematic）由代码/动画驱动位置，或用「动画驱动 → 物理同步」模式（动画播完后手动同步刚体位置）。
- **Cannon.js 不支持 Mesh-Mesh 碰撞**：Cannon.js 的 MeshCollider 只能做凸包检测，凹面 Mesh 之间的碰撞不可靠。需要凹面碰撞时切换到 Bullet 后端。

### 🔗 相关问题

- 如何实现角色的 CharacterController（角色控制器）？它和 RigidBody 有什么区别？
- 物理引擎的性能监控与优化：如何排查物理帧耗时过高？
- 如何实现布娃娃（Ragdoll）物理效果？
