---
title: "如何设计一套可扩展的资源管理与加载架构？"
category: "architecture"
level: 3
tags: ["资源管理", "架构设计", "AssetBundle", "引用计数", "异步加载"]
related: ["architecture/hot-update-architecture", "architecture/object-pool"]
hint: "资源管理的难点不在加载本身，而在引用计数、生命周期、分包与内存预算的平衡。"
---

## 参考答案

### ✅ 核心要点

1. **引用计数是核心**：每个资源记录被引用次数，归零才可卸载，避免"用着被卸 / 不用占内存"
2. **异步加载 + 句柄（Handle）**：加载返回句柄而非直接资源，避免回调地狱和资源野指针
3. **分包与依赖图**：资源按场景/功能分包，构建时生成依赖关系，加载时自动拉取依赖
4. **统一资源寻址**：用地址（Address）/Key 寻址而非硬编码路径，资源迁移不影响业务代码
5. **内存预算与淘汰策略**：设定各类资源内存上限，超限时按 LRU 淘汰可回收资源

### 📖 深度展开

**资源管理分层架构：**

```
┌──────────────────────────────────────┐
│ 业务层 (Gameplay)                    │
│   "给我 hero_001 的预制体"            │
├──────────────────────────────────────┤
│ 资源服务层 (AssetService / Facade)   │
│   句柄分发、缓存查询、异步队列调度    │
├──────────────────────────────────────┤
│ 引用管理层 (RefCounter / Handle)     │
│   引用计数、生命周期、自动卸载        │
├──────────────────────────────────────┤
│ 加载层 (Loader)                      │
│   AssetBundle / Resources / Addressables
├──────────────────────────────────────┤
│ 缓存层 (Cache + LRU)                 │
│   内存预算管理、淘汰策略              │
└──────────────────────────────────────┘
```

**句柄（Handle）设计——解决回调地狱和野指针：**

```csharp
// 加载返回句柄，业务持有句柄，不直接持有资源
public sealed class AssetHandle {
    public string Key;
    public UnityEngine.Object Asset;
    public int RefCount;
    public event System.Action OnLoaded;

    public void Retain() { RefCount++; }
    public void Release() {
        RefCount--;
        if (RefCount <= 0) AssetManager.Instance.Unload(this);
    }
    public Task WaitUntilLoaded() { /* ... */ }
}

// 业务侧用法
public async void SpawnHero() {
    var handle = AssetManager.Instance.LoadAsync("heroes/knight");
    await handle.WaitUntilLoaded();
    var prefab = handle.Asset as GameObject;
    Instantiate(prefab);
    // 实例销毁时必须调用 handle.Release()，否则内存泄漏
}
```

**引用计数的关键：谁申请谁释放**

```
加载 hero_001：RefCount = 1（UI 头像用）
  → 又被场景角色用到：RefCount = 2
    → UI 关闭 Release：RefCount = 1（仍被场景用，不卸载）
      → 角色离开场景 Release：RefCount = 0 → 触发卸载
```

两类经典 bug：**忘了 Release（内存泄漏）** 或 **多次 Release（引用计数为负，提前卸载正在用的资源，表现为模型变粉/崩溃）**。

**资源依赖图（AssetBundle 场景）：**

```
KnightBundle
  ├── 依赖 → SharedTexBundle（共享贴图）
  ├── 依赖 → ShaderBundle
  └── 依赖 → anim/knight_idle

加载 KnightBundle 时必须先加载依赖，否则材质丢失（粉色材质）
卸载时反向：先卸载主资源，依赖包等其 RefCount 归零后再卸
```

**加载策略对比：**

| 策略 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| 同步加载 | 启动/Loading 屏 | 实现简单 | 卡主线程 |
| 异步加载 | 游戏内按需 | 不卡帧 | 需处理加载延迟 |
| 预加载 | 关卡进入前 | 运行时无卡顿 | 占用启动时间 |
| 懒加载 | 首次使用时 | 省内存 | 首次有卡顿 |
| 分帧加载 | 大世界流式加载 | 均摊开销 | 实现复杂 |

**内存预算管理（防 OOM）：**

```csharp
// 设定纹理/音频/网格各自的内存上限
public class MemoryBudget {
    public long TextureLimit = 256 * 1024 * 1024; // 256MB
    public long AudioLimit    = 64  * 1024 * 1024;
    private Dictionary<string, long> _used = new();

    public bool TryAcquire(string type, long size) {
        if (_used.GetValueOrDefault(type) + size > GetLimit(type)) {
            Evict(type, size);  // LRU 淘汰可回收资源，腾出空间
        }
        _used[type] += size;
        return true;
    }
}
```

### ⚡ 实战经验

- **用句柄而非资源对象做生命周期管理**：业务代码直接持有 GameObject 引用容易野指针，句柄 Release 后统一置空更安全
- **警惕 AssetBundle 的整包加载**：一个包里有 100 个资源，只用 1 个也会把整包载入内存——需要粒度合理的分包 + 依赖打包，大资源单独成包
- **`Resources.Load` 是隐形炸弹**：打进 Resources 目录的资源无法按需卸载，会撑大首包体积，项目变大后必须迁移到 AssetBundle/Addressables
- **做好资源卸载的可视化工具**：实时显示每个资源当前的引用者和引用链，泄漏时一眼定位是哪个模块忘了 Release，而不是靠经验盲猜

### 🔗 相关问题

- AssetBundle 的依赖打包和加载顺序如何处理？
- Addressables 相比传统 AssetBundle 解决了什么问题？
- 热更新架构中资源版本管理如何设计？
