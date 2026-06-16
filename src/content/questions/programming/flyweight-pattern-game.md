---
title: "享元模式在游戏中如何应用？如何用 Flyweight 管理海量细粒度对象？"
category: "programming"
level: 2
tags: ["设计模式", "享元模式", "内存优化", "结构型模式"]
related: ["programming/decorator-buff-system", "programming/memory-gc-optimization", "programming/cache-eviction-game"]
hint: "不是对象池——对象池复用实例，享元是拆分内部/外部状态，让不可变部分被成千上万个对象共享同一份内存。"
---

## 参考答案

### ✅ 核心要点

1. **核心思想是状态拆分**：享元（Flyweight）模式把对象的状态切成两半——**内部状态**（intrinsic，不可变、可共享：纹理、模型、基础数值）和**外部状态**（extrinsic，每个实例不同：位置、朝向、当前血量）。内部状态被抽出成单一共享对象，外部状态由调用方在用时传入，两者分离是享元模式的本质。
2. **共享靠 Flyweight Factory**：一个工厂维护 `Map<Key, Flyweight>`，首次请求某 key 时创建并缓存，后续请求直接返回同一实例。客户端不 `new`，只 `factory.get(key)`，从而保证同一种子弹/树木/怪物全图只有一份内部状态。
3. **内存节省是数量级的**：10000 棵树如果每棵都自带纹理、mesh、材质引用，可能占 100MB+；拆分后内部状态只存 5 份（5 种树苗），外部状态每棵只占几十字节（位置+旋转+缩放），总占用降到 1MB 以内，节省 99%。
4. **与对象池的本质区别**：对象池（Object Pool）复用**整个实例**，对象被借出时被独占，用完归还；享元是**多个逻辑对象同时共享同一份不可变数据**，没有"借出/归还"概念。对象池解决 GC 压力，享元解决内存占用——两者常组合使用（池里的每个对象内部状态都是享元）。
5. **不可变性是正确性的前提**：享元对象一旦创建就不能改，否则一个实例改了内部状态，所有共享者都被污染。需要"修改"时只能换一个 key 拿另一个享元（不可变替换），这是函数式数据结构的核心思想在游戏中的应用。
6. **游戏中的典型场景**：子弹/弹幕（同种子弹成千上万发）、树木/植被（大场景植被渲染）、粒子（同种粒子数万颗）、棋盘格子（围棋 361 格）、方块世界（Minecraft 方块）、UI 列表项复用、文字渲染（字形图集 glyph atlas 本质就是享元）。

### 📖 深度展开

**1. 子弹系统：享元 + 外部状态传入**

```typescript
// 内部状态：同种子弹只有一份，不可变
interface BulletFlyweight {
  readonly textureId: string;   // 纹理（占内存大头，~256KB）
  readonly meshId: string;      // 模型
  readonly baseDamage: number;  // 基础伤害
  readonly speed: number;       // 初速度
  readonly radius: number;      // 碰撞半径
}

// 外部状态：每发子弹不同，由独立的轻量实例持有
class BulletInstance {
  constructor(
    public flyweight: BulletFlyweight,  // 引用共享的享元（只占 8 字节指针）
    public x: number, public y: number, // 位置（12 字节）
    public vx: number, public vy: number, // 速度向量（12 字节）
    public ownerId: number,             // 发射者 ID（4 字节）
  ) {}
  // 单发子弹实例仅 ~40 字节，而非自带纹理的 ~260KB
}

// 享元工厂：保证同 key 只创建一份
class BulletFlyweightFactory {
  private cache = new Map<string, BulletFlyweight>();
  get(type: string): BulletFlyweight {
    let fw = this.cache.get(type);
    if (!fw) {
      // 首次：加载资源并组装（昂贵，但只发生一次）
      fw = this.loadFromConfig(type);
      this.cache.set(type, fw);
    }
    return fw;
  }
  private loadFromConfig(type: string): BulletFlyweight {
    const cfg = BULLET_CONFIG[type]; // 读配置表
    return {
      textureId: cfg.texture, meshId: cfg.mesh,
      baseDamage: cfg.damage, speed: cfg.speed, radius: cfg.radius,
    };
  }
}

// 战斗系统创建子弹：1000 发子弹只创建 3 份享元
class WeaponSystem {
  private factory = new BulletFlyweightFactory();
  private bullets: BulletInstance[] = [];
  fire(ownerId: number, type: string, x: number, y: number, angle: number) {
    const fw = this.factory.get(type);          // 共享享元
    const speed = fw.speed;
    this.bullets.push(new BulletInstance(
      fw, x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, ownerId,
    ));
  }
  // 渲染时传入外部状态
  render(ctx: CanvasRenderingContext2D) {
    for (const b of this.bullets) {
      ctx.draw(b.flyweight.textureId, b.x, b.y);  // 内部状态共享，外部状态独立
    }
  }
}
```

**2. 内存对比：享元 vs 每实例自携带**

```
场景：屏幕上 2000 发「火球」+ 1000 发「冰锥」+ 500 发「毒弹」

❌ 不用享元（每发子弹自带纹理引用副本 + 配置字段）：
┌──────────────────────────────────────────────────┐
│ Bullet[0]  纹理引用+mesh+damage+speed+...+pos  ≈ 8KB │
│ Bullet[1]  纹理引用+mesh+damage+speed+...+pos  ≈ 8KB │
│ ...                                                │
│ Bullet[3500]                                   8KB │
└──────────────────────────────────────────────────┘
总计：3500 × 8KB ≈ 27 MB（实际纹理只有 3 份）

✅ 用享元（内部状态全局 3 份，外部状态每发 40 字节）：
┌──────────── 享元池（全局唯一）────────────────────┐
│ Flyweight[火球] 纹理+mesh+config ≈ 500KB         │
│ Flyweight[冰锥] 纹理+mesh+config ≈ 500KB         │
│ Flyweight[毒弹] 纹理+mesh+config ≈ 500KB         │
└──────────────────────────────────────────────────┘
┌──────── 子弹实例（3500 个，每个仅位置+速度）──────┐
│ Instance[0] fw指针+x+y+vx+vy+owner ≈ 40 字节     │
│ ...                                                │
└──────────────────────────────────────────────────┘
总计：3×500KB + 3500×40B ≈ 1.6 MB（节省 94%）
```

**3. 享元 vs 对象池 vs 单例：三种"共享"机制对比**

| 维度 | 享元 Flyweight | 对象池 Object Pool | 单例 Singleton |
|------|---------------|-------------------|---------------|
| **共享什么** | 不可变的内部状态（数据） | 整个实例（借出-归还） | 全局唯一实例 |
| **实例数** | N 个轻量外壳 + M 个共享核心（M≪N） | 池容量 K 个，逻辑对象可能远多于 K | 永远 1 个 |
| **可变性** | 内部状态必须不可变 | 实例可变，但同一时刻只被一个使用者独占 | 通常可变（全局状态） |
| **解决的问题** | 海量细粒度对象的**内存占用** | 频繁创建销毁的 **GC 压力** | 全局访问点、唯一资源 |
| **游戏场景** | 子弹/树木/粒子/方块 | 子弹/特效/怪物实例（运行时复用） | 输入管理器/音频引擎/配置中心 |
| **常见组合** | 子弹享元（纹理）+ 子弹实例池（运行时复用 BulletInstance） | — | — |

```typescript
// 享元 + 对象池组合：既省内存又省 GC，子弹系统的工业级实践
class BulletSystem {
  private flyweights = new BulletFlyweightFactory();
  private instancePool = new ObjectPool<BulletInstance>(() =>
    new BulletInstance(null!, 0, 0, 0, 0, 0));  // 预分配实例外壳

  spawn(type: string, x: number, y: number, angle: number) {
    const fw = this.flyweights.get(type);         // 共享内部状态
    const bullet = this.instancePool.acquire();   // 复用实例外壳（无 GC）
    bullet.flyweight = fw;
    bullet.x = x; bullet.y = y;
    bullet.vx = Math.cos(angle) * fw.speed;
    bullet.vy = Math.sin(angle) * fw.speed;
    return bullet;
  }
  // 享元负责省内存（3 份纹理），对象池负责省 GC（实例外壳复用）
}
```

### ⚡ 实战经验

- **享元对象必须冻结**：曾有一次 bug——策划热更时改了共享火球的 `baseDamage`，结果全图所有火球（包括玩家已发射的）伤害瞬间翻倍，玩家反馈"BOSS 秒杀"。根因是享元对象可变。修复用 `Object.freeze(flyweight)` 强制不可变，需要调整数值时换 key 拿新享元（旧实例保持旧值，符合预期）。
- **享元 Key 设计要稳定**：用 `"fireball_lv3"` 这种配置 ID 作 key 没问题；曾用 `对象引用` 作 key 导致 Map 找不到缓存（每次 new 都是新引用），3500 发子弹创建 3500 份享元，内存反而比不享元多 20%（多了一层壳）。改用稳定字符串 key 后享元数稳定在配置表条目数（约 50 份）。
- **外部状态尽量用 SoA 布局**：早期把 `BulletInstance` 做成对象数组，3500 个实例触发 V8 隐藏类爆炸，GC 扫描 8ms。改成 SoA（Structure of Arrays）：`x: Float32Array(3500), y: Float32Array(3500), vx: Float32Array(3500)...`，同字段连续存储，GC 扫描降到 0.3ms（连续内存 + 单一隐藏类），帧时间稳定 16.7ms。
- **字形图集是隐式享元**：文字渲染本质是享元——每个字形（'A'、'好'）只光栅化一次存进 atlas 纹理，渲染时按 UV 采样复用。一次踩坑是动态字体没复用 atlas，每个 Label 节点都自己光栅化导致 500 个 UI 文本占 80MB 纹理；接入共享 glyph cache 后降到 2MB。
- **享元不是越多越好**：当逻辑对象数量 < 100 时，享元的额外间接层（工厂 + 外部状态拆分）带来的复杂度收益不明显，直接 struct/对象反而更直观。曾在一个只有 20 个 UI 图标的列表里强行套享元，代码可读性骤降且没省到内存（图标本身已被引擎纹理缓存），属于过度设计。

### 🔗 相关问题

1. 享元模式要求内部状态不可变，但游戏中很多配置需要热更新（运行时调整子弹伤害），如何在不违反享元不可变性的前提下实现热更？是否需要引入 copy-on-write 或版本号机制？
2. ECS 架构中的"共享组件"（如 Unity DOTS 的 ISharedComponentData）本质是不是享元模式？它与经典 GoF 享元在内存布局和查询性能上有何差异？
3. 当享元的内部状态包含 GPU 资源（纹理、VertexBuffer）时，享元的生命周期管理如何与 GPU 资源卸载协同？引用计数还是延迟卸载？
