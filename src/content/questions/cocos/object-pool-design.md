---
title: "Cocos Creator 中对象池如何设计与实现？高频实例化场景如何优化？"
category: "cocos"
level: 2
tags: ["对象池", "性能优化", "架构设计", "内存管理"]
related: ["cocos/node-component-system", "cocos/memory-management", "cocos/profiler-and-performance"]
hint: "子弹、特效、敌人频繁创建销毁，GC 抖动怎么破？对象池的容量、扩容、收缩策略怎么定？"
---

## 参考答案

### ✅ 核心要点

1. **核心思想**：预创建一批对象反复复用，避免运行时频繁 `instantiate` / `destroy` 导致的 GC 抖动和内存碎片
2. **适用场景**：子弹、粒子特效、敌人、掉落物等高频创建 / 销毁的短生命周期对象
3. **容量策略**：预热数量（preSize）基于峰值需求预估，运行时动态扩容但设上限，避免无限增长
4. **回收时机**：对象完成使命后立即回收到池中（`active = false`），而非 `destroy`
5. **组件绑定清理**：回收前必须重置对象状态（位置、速度、HP 等），避免"脏数据"影响下次使用

### 📖 深度展开

#### 不用对象池时的性能问题

```
每帧创建 50 个子弹 × 60fps = 3000 次 instantiate/destroy / 秒

instantiate() 内部流程：
  → 递归克隆 Prefab 节点树
  → 创建所有 Component 实例
  → 分配 JS 对象 → 触发 GC 压力
  → 注册到节点树 → 触发 onLoad

destroy() 内部流程：
  → 递归销毁子节点
  → 调用 onDestroy
  → 解除引用 → 等 GC 回收
  → 本帧或下帧 GC 触发 → 帧卡顿（GC Pause）

结果：帧率不稳定，出现周期性掉帧
```

#### 对象池 vs 不用对象池

| 维度 | 每次 instantiate | 对象池复用 |
|------|-----------------|-----------|
| 内存分配 | 每次堆分配 | 零分配（复用） |
| GC 压力 | 高（触发频繁 GC） | 极低 |
| 初始化成本 | 每次 onLoad | 仅首次 onLoad |
| 帧时间稳定性 | 波动大 | 平稳 |
| 代码复杂度 | 简单 | 需要池管理逻辑 |
| 内存占用 | 按需（峰值低） | 常驻（预热内存） |

#### 基础对象池实现

```typescript
import { Node, instantiate, Prefab, Component } from 'cc';

/**
 * 通用对象池
 * 支持：预热、动态扩容、自动回收、容量上限
 */
export class GameObjectPool<T extends Component> {
    private pool: T[] = [];
    private activeSet: Set<T> = new Set();
    private prefab: Prefab;
    private getComponent: (node: Node) => T;
    private maxSize: number;
    private preSize: number;

    constructor(
        prefab: Prefab,
        getComponent: (node: Node) => T,
        preSize: number = 10,
        maxSize: number = 200,
    ) {
        this.prefab = prefab;
        this.getComponent = getComponent;
        this.preSize = preSize;
        this.maxSize = maxSize;
    }

    /** 预热：在 Loading 场景中调用 */
    warmup() {
        for (let i = 0; i < this.preSize; i++) {
            const node = instantiate(this.prefab);
            node.active = false;
            this.pool.push(this.getComponent(node));
        }
    }

    /** 从池中获取一个对象 */
    acquire(): T | null {
        let comp: T | undefined;

        if (this.pool.length > 0) {
            comp = this.pool.pop()!;
        } else if (this.activeSet.size < this.maxSize) {
            // 池空但未达上限，动态创建
            const node = instantiate(this.prefab);
            comp = this.getComponent(node);
        } else {
            // 达到上限，复用最早激活的对象（FIFO 淘汰）
            comp = this.activeSet.values().next().value;
            this.activeSet.delete(comp);
            this.resetComponent(comp);
        }

        comp.node.active = true;
        this.activeSet.add(comp);
        return comp;
    }

    /** 回收对象到池中 */
    release(comp: T) {
        if (!this.activeSet.has(comp)) return; // 防止重复回收

        comp.node.active = false;
        this.activeSet.delete(comp);
        this.resetComponent(comp);
        this.pool.push(comp);
    }

    /** 回收所有激活对象（场景切换 / 重置时调用） */
    releaseAll() {
        for (const comp of this.activeSet) {
            comp.node.active = false;
            this.resetComponent(comp);
            this.pool.push(comp);
        }
        this.activeSet.clear();
    }

    /** 彻底销毁池中所有对象（释放内存） */
    clear() {
        for (const comp of this.pool) {
            comp.node.destroy();
        }
        for (const comp of this.activeSet) {
            comp.node.destroy();
        }
        this.pool = [];
        this.activeSet.clear();
    }

    /** 重置对象状态（子类可覆盖） */
    protected resetComponent(comp: T) {
        comp.node.setPosition(0, 0, 0);
        // 可在子类中重写，重置血量、速度等
    }

    get activeCount(): number {
        return this.activeSet.size;
    }

    get pooledCount(): number {
        return this.pool.length;
    }
}
```

#### 实战示例：子弹管理器

```typescript
@ccclass('BulletManager')
export class BulletManager extends Component {
    @property(Prefab)
    bulletPrefab: Prefab = null!;

    private pool: GameObjectPool<Bullet>;
    private bullets: Bullet[] = [];

    start() {
        this.pool = new GameObjectPool(
            this.bulletPrefab,
            (node) => node.getComponent(Bullet)!,
            20,    // 预热 20 发
            150,   // 最多 150 发同屏
        );
        this.pool.warmup();
    }

    fire(pos: Vec3, dir: Vec3, speed: number) {
        const bullet = this.pool.acquire();
        if (!bullet) return;

        bullet.node.setWorldPosition(pos);
        bullet.fire(dir, speed);
        this.bullets.push(bullet);
    }

    update(dt: number) {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            bullet.update(dt);

            // 子弹生命结束或命中 → 回收
            if (bullet.isDead) {
                this.pool.release(bullet);
                this.bullets.splice(i, 1);
            }
        }
    }

    onDestroy() {
        this.pool.clear();
    }
}
```

#### 多类型对象池管理器

```typescript
/**
 * 对象池注册中心：管理多种 Prefab 的对象池
 * 适合大型项目，统一管理所有池化对象
 */
export class PoolRegistry {
    private pools: Map<string, GameObjectPool<any>> = new Map();

    register<T extends Component>(
        key: string,
        prefab: Prefab,
        getComp: (node: Node) => T,
        preSize: number = 5,
        maxSize: number = 100,
    ) {
        const pool = new GameObjectPool(prefab, getComp, preSize, maxSize);
        pool.warmup();
        this.pools.set(key, pool);
    }

    acquire<T extends Component>(key: string): T | null {
        const pool = this.pools.get(key);
        return pool ? pool.acquire() : null;
    }

    release<T extends Component>(key: string, comp: T) {
        const pool = this.pools.get(key);
        pool?.release(comp);
    }

    /** 场景切换时调用：回收所有，释放预热内存 */
    cleanup() {
        for (const pool of this.pools.values()) {
            pool.releaseAll();
        }
    }

    /** 游戏退出 / 低内存时调用 */
    destroyAll() {
        for (const pool of this.pools.values()) {
            pool.clear();
        }
        this.pools.clear();
    }
}
```

#### 容量预估参考表

| 对象类型 | 预热数量 | 最大上限 | 说明 |
|---------|---------|---------|------|
| 子弹 | 20-30 | 100-200 | 射击类游戏高峰值 |
| 粒子特效 | 5-10 | 30-50 | 复用特效节点 |
| 敌人 | 5-10 | 30-50 | 根据刷怪频率调整 |
| 掉落物 | 10-20 | 50-100 | 打怪掉落 |
| 伤害数字 | 10-15 | 50-80 | 漂浮文字 |
| 网络实体 | 根据服务器返回 | 100-200 | AOI 范围内实体 |

### ⚡ 实战经验

1. **预热时机很关键**：在 Loading 场景中调用 `warmup()`，让 `instantiate` 的开销分摊到加载阶段。如果进入战斗后才预热，第一波子弹就会有明显卡顿
2. **防重复回收是必修课**：对象被回收到池后如果还被外部引用（比如定时器回调），会导致"操作了一个 inactive 节点"的异常。推荐用 `activeSet` 做存在性校验，并在回收时清理所有外部引用
3. **池不是越大越好**：预热太多对象会占用大量常驻内存。一个带动画和特效的敌人 Prefab 可能占 50-100KB，预热 50 个就是 2.5-5MB。根据实际峰值需求设定，宁可运行时偶尔扩容
4. **节点层级的坑**：池化对象从池中取出后，如果之前的父节点已被销毁，`node.active = true` 会报错。确保池化对象的父节点是常驻的（如 `BulletLayer` 节点），或在 acquire 时重新 `addChild` 到正确父节点

### 🔗 相关问题

- Cocos Creator 的 `instantiate()` 内部做了哪些事？为什么比 `new Node()` 复杂？
- 如何实现一个支持优先级的对象池（重要对象优先分配）？
- 在帧同步（Lockstep）游戏中，对象池如何保证确定性？
