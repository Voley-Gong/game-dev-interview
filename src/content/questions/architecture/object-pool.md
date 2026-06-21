---
title: "如何设计一个高性能的通用对象池？"
category: "architecture"
level: 2
tags: ["对象池", "设计模式", "性能优化", "泛型", "架构设计"]
related: ["architecture/skill-system", "cocos/drawcall-optimization"]
hint: "频繁 Instantiate/Destroy 是 GC 和卡顿元凶——对象池的核心是「取用-归还」而非「创建-销毁」。"
---

## 参考答案

### ✅ 核心要点

1. **预创建 + 复用**：启动时创建一批对象，用完归还而非销毁，避免运行时 Instantiate 开销
2. **泛型设计**：`ObjectPool<T>` 支持任意类型，按 key（prefab 名）分池
3. **取用-归还生命周期**：`get()` / `release()`，配套 `onGet`/`onReturn` 回调做重置
4. **容量策略**：最小预热数、最大上限、扩容/缩容时机
5. **防御性归还**：防止同一对象被重复归还（重复入池导致取到脏数据）

### 📖 深度展开

**不使用对象池的问题：**

```
战斗中每秒创建 100 个子弹：
  每帧 Instantiate → 触发预制体克隆、组件初始化、内存分配
  销毁时 Destroy  → GC 压力、可能的内存碎片
  → 帧率抖动、偶发卡顿

对象池后：
  池中预存 200 个子弹，循环复用
  → 0 运行时分配，GC 几乎无压力，帧率平稳
```

**泛型对象池实现：**

```typescript
// 单一类型的池
class Pool<T> {
  private available: T[] = [];
  private inUse = new Set<T>();
  private factory: () => T;
  private reset: (obj: T) => void;
  private maxSize: number;

  constructor(opts: {
    factory: () => T;
    reset: (obj: T) => void;
    preload?: number;
    maxSize?: number;
  }) {
    this.factory = opts.factory;
    this.reset = opts.reset;
    this.maxSize = opts.maxSize ?? Infinity;
    // 预热
    for (let i = 0; i < (opts.preload ?? 0); i++)
      this.available.push(this.factory());
  }

  get(): T {
    let obj = this.available.pop();
    if (!obj) obj = this.factory();
    this.inUse.add(obj);
    return obj;
  }

  release(obj: T): void {
    if (!this.inUse.has(obj)) return; // 防重复归还
    this.inUse.delete(obj);
    this.reset(obj); // 重置状态，避免脏数据
    if (this.available.length < this.maxSize) this.available.push(obj);
    // 超过上限则真正销毁，控制内存
  }
}

// 多类型池管理器：按 prefab 名分发
class PoolManager {
  private pools = new Map<string, Pool<any>>();

  getPool<T>(key: string, opts: PoolOptions<T>): Pool<T> {
    if (!this.pools.has(key)) this.pools.set(key, new Pool(opts));
    return this.pools.get(key);
  }

  spawn<T>(key: string): T { return this.getPool<T>(key, ...).get(); }
  despawn<T>(key: string, obj: T) { this.getPool<T>(key, ...).release(obj); }
}
```

**Unity 版核心要点（C#）：**

```csharp
public class GameObjectPool {
    private readonly GameObject prefab;
    private readonly Queue<GameObject> pool = new();
    private readonly HashSet<GameObject> inUse = new();

    public GameObject Get(Vector3 pos) {
        GameObject go = pool.Count > 0 ? pool.Dequeue() : Object.Instantiate(prefab);
        go.transform.SetPositionAndRotation(pos, Quaternion.identity);
        go.SetActive(true);
        inUse.Add(go);
        return go;
    }

    public void Release(GameObject go) {
        if (!inUse.Remove(go)) return;   // 防重复归还
        go.SetActive(false);             // 复用前隐藏
        go.transform.SetParent(poolRoot); // 统一父节点，避免场景树膨胀
        pool.Enqueue(go);
    }
}
```

**生命周期与重置时机：**

| 时机 | 操作 | 说明 |
|------|------|------|
| 预热（Init） | 创建 N 个对象 | 启动时/进场景时批量创建 |
| 取出（Get） | `SetActive(true)` + 重置位置/血量 | 复用前清理上次的残留状态 |
| 归还（Release） | `SetActive(false)` + 移到池根节点 | 对象仍存在，只是隐藏 |
| 溢出（超 maxSize） | 真正 `Destroy` | 控制峰值内存 |
| 清空（场景切换） | 全部 `Destroy` | 防止跨场景引用泄漏 |

### ⚡ 实战经验

- **重置一定要彻底**：归还时必须清空子弹的伤害记录、特效的粒子状态、UI 的文本内容，否则下次取出带"脏数据"出 Bug
- **预热点要准**：根据玩法预估峰值数量（如弹幕游戏预热 500 发子弹），运行中再按需扩容
- **用 `SetActive(false)` 而非移出场景**：Unity 中 SetActive(false) 会停掉脚本 Update 和渲染，比移到远处更省；注意它也会暂停协程
- **防重复归还**：用 Set/标记位兜底——"已经归还的对象再被归还"是对象池最常见的隐蔽 Bug
- **粒度别太细**：连 UI 文字、临时数组都池化属于过度优化；池化的收益在"高频创建销毁的 Unity 对象/重型结构"

### 🔗 相关问题

- 对象池和 ECS 架构冲突吗？ECS 下还需要对象池吗？
- 如何实现一个按需扩容又有上限的资源池？
- 子弹/特效等高频对象如何配合对象池做合批优化？
