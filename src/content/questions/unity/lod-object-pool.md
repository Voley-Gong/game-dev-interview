---
title: "Unity中LOD策略与对象池如何配合优化性能？"
category: "unity"
level: 2
tags: ["性能优化", "LOD", "对象池", "GPU优化"]
related: ["unity/drawcall-batching", "unity/gpu-instancing", "unity/mobile-optimization"]
hint: "LOD负责按距离降精度，对象池负责复用实例——两者如何协同？"
---

## 参考答案

### ✅ 核心要点

1. **LOD（Level of Detail）**：根据摄像机距离切换不同精度模型，降低面数和 DrawCall 开销
2. **对象池（Object Pool）**：预实例化 + 循环复用，消除运行时 `Instantiate`/`Destroy` 的峰值
3. **两者协同**：池中对象按距离动态切换 LOD Group，实现"复用 + 降级"双重优化
4. **Culling Distance**：超出最远 LOD 后直接禁用渲染（Culled），池对象回收到不可见状态
5. **GPU Instancing 配合**：同 LOD 层级的相同网格可触发 GPU Instancing 进一步合批

### 📖 深度展开

#### LOD 系统详解

Unity 内置 `LODGroup` 组件，按屏幕占比（Screen Size Ratio）自动切换网格：

```
LOD 0  → 距离 < 10m   → 原始网格 (8000 三角面)
LOD 1  → 10m ~ 30m    → 中精度 (2000 三角面)
LOD 2  → 30m ~ 60m    → 低精度  (500 三角面)
Culled → > 60m         → 不渲染
```

**LOD Group 配置阈值（百分比代表占屏幕高度的比例）：**

| LOD 级别 | 阈值（Screen%） | 适用场景 | 面数建议 |
|----------|-----------------|----------|----------|
| LOD 0 | 60% ~ 100% | 近距离主体 | 原始精度 |
| LOD 1 | 30% ~ 60% | 中距离 | 减少 50%~70% |
| LOD 2 | 10% ~ 30% | 远景 | 减少 90% |
| Culled | < 10% | 超出视野 | 禁用渲染 |

#### 对象池实现

```csharp
public class GameObjectPool
{
    private readonly GameObject _prefab;
    private readonly Queue<GameObject> _pool = new();
    private readonly Transform _parent;
    private readonly int _initialSize;

    public GameObjectPool(GameObject prefab, int initialSize, Transform parent)
    {
        _prefab = prefab;
        _parent = parent;
        _initialSize = initialSize;

        for (int i = 0; i < initialSize; i++)
        {
            var go = Object.Instantiate(prefab, _parent);
            go.SetActive(false);
            _pool.Enqueue(go);
        }
    }

    public GameObject Get(Vector3 position, Quaternion rotation)
    {
        GameObject go = _pool.Count > 0
            ? _pool.Dequeue()
            : Object.Instantiate(_prefab, _parent);

        go.transform.SetPositionAndRotation(position, rotation);
        go.SetActive(true);
        return go;
    }

    public void Release(GameObject go)
    {
        go.SetActive(false);
        _pool.Enqueue(go);
    }
}
```

#### LOD + 对象池协同架构

```
玩家移动
  ↓
距离检测（每 N 帧，非每帧）
  ↓
┌─────────────────────────────────┐
│ 距离 < LOD2 阈值？              │
│   → 从池中 Get，激活 + 设LOD    │
│ 距离 > Culled 阈值？            │
│   → Release 回池，禁用渲染      │
│ LOD 层级变化？                  │
│   → 切换 LODGroup 的激活 LOD    │
└─────────────────────────────────┘
```

**关键代码——池化对象上的 LOD 切换：**

```csharp
[RequireComponent(typeof(LODGroup))]
public class PooledLODObject : MonoBehaviour
{
    private LODGroup _lodGroup;
    private LOD[] _lods;

    void Awake()
    {
        _lodGroup = GetComponent<LODGroup>();
        _lods = _lodGroup.GetLODs();
    }

    // 从池中取出时调用
    public void OnSpawnFromPool()
    {
        _lodGroup.enabled = true;
    }

    // 回收到池中时调用
    public void OnDespawnToPool()
    {
        _lodGroup.enabled = false;
        // 强制禁用所有 LOD 渲染器
        foreach (var lod in _lods)
        {
            foreach (var renderer in lod.renderers)
                renderer.enabled = false;
        }
    }
}
```

#### 注意事项对比

| 维度 | LOD 单独使用 | LOD + 对象池 |
|------|-------------|-------------|
| 创建开销 | 每次 Instantiate 有峰值 | 预分配，无峰值 |
| 内存占用 | 只加载需要的 LOD | 常驻内存 |
| 适用场景 | 静态场景物体 | 动态生成/消失的物体 |
| 实现复杂度 | 低 | 中 |

### ⚡ 实战经验

- **不要每帧检测距离**：用 `InvokeRepeating` 或自定义间隔（如每 0.2s），100 个对象的距离检测就能省可观 CPU
- **LOD 过渡抖动**：屏幕占比在阈值附近波动时模型频繁切换，加入滞后区间（Hysteresis）避免抖动
- **池的预热大小**：根据玩法峰值估算，关卡开始时一次性预加载，避免运行中动态扩容造成卡顿
- **内存 vs CPU 权衡**：池太大浪费内存，太小频繁 Instantiate 造成 GC 峰值——需 Profiler 实测调参

### 🔗 相关问题

- GPU Instancing 和 Static/Dynamic Batching 分别适合什么场景？
- 如何用 Unity Profiler 定位性能瓶颈？
- 大规模开放世界的流式加载（Streaming）如何设计？
