---
title: "Unity 2021.1+ ObjectPool<T> API 与自定义对象池架构设计"
category: "unity"
level: 2
tags: ["性能优化", "对象池", "ObjectPool", "设计模式", "GC"]
related: ["unity/lod-object-pool", "unity/gc-performance", "unity/destroy-vs-destroyimmediate-lifecycle"]
hint: "频繁 Instantiate/Destroy 导致 GC 频繁和卡顿，如何用对象池彻底解决？"
---

## 参考答案

### ✅ 核心要点

1. **核心思想**：预分配对象 + 循环复用，避免运行时频繁 Instantiate/Destroy 产生的 GC 尖峰
2. **Unity 2021.1+ 内置 `UnityEngine.Pool.ObjectPool<T>`**：基于 Stack 的通用对象池实现，零依赖
3. **`IObjectPool<T>` 接口**：Get / Release / Clear 三个核心操作，支持线程安全模式
4. **容量控制**：`defaultCapacity`、`maxSize` 参数控制初始分配和上限，超限对象直接丢弃走正常销毁
5. **与 `IDisposable` 配合**：池化对象应在 Release 前重置状态（位置、速度、特效等），避免脏数据

### 📖 深度展开

#### Unity 内置 ObjectPool<T> 的完整用法

```csharp
using UnityEngine.Pool;

// 池化对象示例：子弹
public class Bullet : MonoBehaviour
{
    public float speed = 20f;
    public float lifeTime = 3f;
    private float _timer;

    void OnEnable()
    {
        _timer = 0f;
    }

    void Update()
    {
        transform.Translate(Vector3.forward * speed * Time.deltaTime);
        _timer += Time.deltaTime;
        if (_timer >= lifeTime)
        {
            // 通过事件通知外部归还到池
            OnLifeExpired?.Invoke(this);
        }
    }

    public event System.Action<Bullet> OnLifeExpired;

    // 重置状态，防止从池中取出时残留旧数据
    public void ResetState(Vector3 pos, Quaternion rot)
    {
        transform.SetPositionAndRotation(pos, rot);
        _timer = 0f;
        GetComponent<Rigidbody>().linearVelocity = Vector3.zero;
    }
}

// 管理器
public class BulletPoolManager : MonoBehaviour
{
    [SerializeField] private Bullet _bulletPrefab;
    [SerializeField] private int _defaultCapacity = 30;
    [SerializeField] private int _maxSize = 200;

    private IObjectPool<Bullet> _pool;

    void Awake()
    {
        _pool = new ObjectPool<Bullet>(
            createFunc: () => Instantiate(_bulletPrefab),
            onGet:     bullet => bullet.gameObject.SetActive(true),
            onRelease: bullet => bullet.gameObject.SetActive(false),
            onDestroy: bullet => Destroy(bullet.gameObject),
            collectionCheck: true,   // 重复归还时报错
            defaultCapacity: _defaultCapacity,
            maxSize: _maxSize
        );
    }

    public Bullet Spawn(Vector3 pos, Quaternion rot)
    {
        var bullet = _pool.Get();
        bullet.ResetState(pos, rot);
        bullet.OnLifeExpired = b => _pool.Release(b);
        return bullet;
    }
}
```

#### ObjectPool 内部数据结构

```
ObjectPool<T> 内部用 Stack<T> 存储：

Get() 操作：
  ┌──────────────────────────┐
  │  Stack (空闲池)           │
  │  [Bullet_A] ← 取出顶部    │
  │  [Bullet_B]              │
  │  [Bullet_C]              │
  └──────────────────────────┘
  Stack为空 → 调用 createFunc() 新建

Release() 操作：
  ┌──────────────────────────┐
  │  Stack (空闲池)           │
  │  [Bullet_A] ← 压入顶部    │
  │  [Bullet_B]              │
  │  [Bullet_C]              │
  │  [Bullet_D]              │
  └──────────────────────────┘
  Count >= maxSize → 调用 onDestroy() 直接销毁
```

#### 自定义对象池设计模式对比

| 维度 | UnityEngine.Pool.ObjectPool<T> | 手写 Stack 池 | 第三方插件（QFSW等） |
|------|-------------------------------|--------------|-------------------|
| 来源 | Unity 官方 2021.1+ | 自行实现 | Asset Store |
| 线程安全 | 可选 collectionCheck | 自行加锁 | 各有不同 |
| 泛型支持 | ✅ 完整泛型 | 可实现 | 部分支持 |
| Inspector 可视化 | ❌ 需自行扩展 | 自行实现 | 通常有 |
| 预热（Prewarm） | 需手动循环 Get+Release | 自行实现 | 部分支持 |
| 适用场景 | 中小型项目、快速接入 | 大型项目定制需求 | 快速原型 |

#### 预热策略

```csharp
// 在 Awake/Start 时预分配对象
IEnumerator PrewarmPool(int count)
{
    var temp = new List<Bullet>(count);
    for (int i = 0; i < count; i++)
    {
        temp.Add(_pool.Get());
    }
    foreach (var item in temp)
    {
        _pool.Release(item);
    }
    yield return null; // 分帧避免卡顿
}
```

#### 对象池 vs Instantiate/Destroy 性能对比

```
直接 Instantiate/Destroy（1000次/帧）：
  GC Alloc: ~480KB/frame
  Frame Time: 18.3ms
  GC.Collect 尖峰: 每 ~3秒一次卡顿

ObjectPool（预热 200，循环复用）：
  GC Alloc: 0 KB/frame（稳态）
  Frame Time: 2.1ms
  GC.Collect 尖峰: 无
```

### ⚡ 实战经验

1. **collectionCheck 开发期开启、发布关闭**：开发阶段打开 `collectionCheck: true` 捕获重复归还 Bug，Release 包关闭以省性能
2. **事件回调泄漏**：池化对象用 `event Action<T>` 通知归还时，务必在 Release 前取消订阅，否则同一对象被多次获取时事件会叠加触发
3. **Unity 特效/音频也需池化**：ParticleSystem 和 AudioSource 的 Play/Stop 比 Instantiate/Destroy 快得多，但注意 ParticleSystem 需调用 `Clear()` 再 `Play()`
4. **maxSize 不是越大越好**：maxSize 过大会常驻大量内存，尤其是纹理和 Mesh 对象。根据实际峰值场景设置，超出部分走正常 Destroy 回收内存

### 🔗 相关问题

- 对象池的池大小（Pool Size）应该怎么设定？动态扩缩容如何做？
- Unity 中除了对象池，还有哪些减少 GC 的经典手段？
- DOTS/ECS 架构下还需要对象池吗？
