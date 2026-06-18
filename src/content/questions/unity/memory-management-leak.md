---
title: "Unity 的内存管理体系是怎样的？如何排查和修复内存泄漏？"
category: "unity"
level: 3
tags: ["内存管理", "性能优化", "内存泄漏", "移动端"]
related: ["unity/gc-performance", "unity/mobile-optimization", "unity/addressables-system"]
hint: "Unity 内存不只是 GC 托管堆——Native 内存、AssetBundle 内存、纹理/网格等各自独立计费。"
---

## 参考答案

### ✅ 核心要点

1. **Unity 内存分为三大块**：Managed（C# 托管堆，GC 管理）、Native（C++ 层，引擎分配）、Graphics Driver（GPU 显存映射）
2. **最大头不是代码，是资源**：纹理、网格、音频等原生资源占用的 Native 内存远超 C# 托管堆
3. **内存泄漏的头号元凶**：AssetBundle/Addressables 未 Release、事件委托未取消订阅、静态引用链持有已销毁对象
4. **排查工具链**：Unity Memory Profiler（快照对比）→ Profiler Memory 模块（实时监控）→ Device Logcat/Xcode（原生崩溃日志）
5. **移动端内存预算意识**：中端 Android 安全线约 350MB 托管内存，超出即面临 OOM/LMK（Low Memory Killer）风险

### 📖 深度展开

#### Unity 内存全景图

```
┌──────────────────────────────────────────────────────┐
│                  Unity 进程总内存                       │
├────────────────┬─────────────────────────────────────┤
│  Managed Heap  │  Native Memory (C++ 层)              │
│  (C# GC 管理)   │                                     │
│                │  ┌─────────────────────────────┐    │
│  ├── 用户对象   │  │  Asset 内存                  │    │
│  ├── 字符串     │  │  ├── 纹理 (Texture2D)        │    │
│  ├── 委托/事件  │  │  ├── 网格 (Mesh)             │    │
│  ├── 缓冲区     │  │  ├── 音频 (AudioClip)        │    │
│  └── 闭包捕获   │  │  └── 动画 (AnimationClip)    │    │
│                │  ├─────────────────────────────┤    │
│  GC 自动回收    │  │  AssetBundle 内存            │    │
│  分配快, 回收卡  │  │  ├── 压缩数据 (LZ4/LZMA)    │    │
│                │  │  └── 解压后资产               │    │
│                │  ├─────────────────────────────┤    │
│                │  │  GC 内部 ( Boehm GC )        │    │
│                │  │  ├── 堆元数据               │     │
│                │  │  └── 自由列表               │     │
│                │  ├─────────────────────────────┤    │
│                │  │  线程栈 / JIT 代码段         │    │
│                │  └─────────────────────────────┘    │
├────────────────┼─────────────────────────────────────┤
│                │  Graphics Driver Memory             │
│                │  ├── 纹理上传到 GPU 显存             │
│                │  ├── Render Target / FrameBuffer    │
│                │  └── Vertex/Index Buffer            │
└────────────────┴─────────────────────────────────────┘
```

> **关键认知**：`Resources.UnloadUnusedAssets()` 只能释放 Native 资源（纹理、网格等），**不会释放 C# 托管堆**。GC 才管托管堆，但 GC 只回收「不可达」的对象。

#### 三类内存的分配与释放

| 内存类型 | 分配方式 | 释放方式 | 分析工具 |
|---------|---------|---------|---------|
| Managed (C#) | `new` / LINQ / 字符串拼接 | GC 自动（标记-清除） | Profiler GC Alloc |
| Native - 资源 | `Resources.Load` / `Instantiate` | `Resources.UnloadUnusedAssets` / `Destroy` | Memory Profiler |
| Native - AssetBundle | `AssetBundle.LoadAsset` | `AssetBundle.Unload(true)` | Memory Profiler |
| Graphics Driver | 自动上传（纹理/网格渲染时） | 资源卸载后延迟释放 | Xcode GPU Capture / RenderDoc |
| Addressables | `Addressables.LoadAssetAsync` | `Addressables.Release(handle)` | Addressables Event Viewer |

#### 典型内存泄漏场景与修复

**场景 1：事件委托未取消订阅（最常见的泄漏）**

```csharp
// ❌ 泄漏：按钮订阅了已销毁对象的方法
public class EnemyHealthBar : MonoBehaviour
{
    void OnEnable()
    {
        // 订阅了全局事件
        EventManager.OnHealthChanged += UpdateHealthBar;
        // EnemyHealthBar 被销毁后，EventManager 仍持有它的引用
        // → GC 永远不会回收 EnemyHealthBar
    }
}

// ✅ 修复：必须配对取消订阅
public class EnemyHealthBar : MonoBehaviour
{
    void OnEnable()
    {
        EventManager.OnHealthChanged += UpdateHealthBar;
    }

    void OnDisable()
    {
        EventManager.OnHealthChanged -= UpdateHealthBar;
    }
}
```

**场景 2：AssetBundle 只加载不卸载**

```csharp
// ❌ 泄漏：加载了 AssetBundle 但从不卸载
IEnumerator LoadLevelAsync(string bundleName, string levelName)
{
    var bundle = AssetBundle.LoadFromFileAsync(bundleName);
    yield return bundle;
    var level = bundle.assetBundle.LoadAsset<GameObject>(levelName);
    Instantiate(level);
    // bundle.assetBundle 从未调用 Unload() → Native 内存永久泄漏
}

// ✅ 修复：加载后立即卸载压缩数据，保留解压资产
IEnumerator LoadLevelAsync(string bundleName, string levelName)
{
    var bundleLoad = AssetBundle.LoadFromFileAsync(bundleName);
    yield return bundleLoad;
    var ab = bundleLoad.assetBundle;

    var assetLoad = ab.LoadAssetAsync<GameObject>(levelName);
    yield return assetLoad;
    Instantiate(assetLoad.asset);

    // 卸载 AssetBundle 压缩数据（保留已加载的资产）
    ab.Unload(false);
    // 注意：ab.Unload(true) 会同时卸载已加载的资产，可能导致场景中的物体变粉色
}
```

**场景 3：静态集合无限增长**

```csharp
// ❌ 泄漏：缓存只增不减
public static class EnemyCache
{
    private static List<Enemy> _allEnemies = new();

    public static void Register(Enemy e) => _allEnemies.Add(e);
    // 忘记写 Unregister → 列表持有所有已死敌人引用 → GC 无法回收
}

// ✅ 修复：注册/注销配对 + 定期清理
public static class EnemyCache
{
    private static List<Enemy> _allEnemies = new();

    public static void Register(Enemy e) => _allEnemies.Add(e);

    public static void Unregister(Enemy e) => _allEnemies.Remove(e);

    public static void CleanDestroyed()
    {
        _allEnemies.RemoveAll(e => e == null); // 清理已销毁引用
    }
}
```

#### Memory Profiler 快照对比法

```
排查流程：

1. 在目标场景入口打快照 A
2. 进入场景 → 完整游玩 → 退出场景
3. 手动触发 GC.Collect() + Resources.UnloadUnusedAssets()
4. 打快照 B
5. 对比 A vs B → 差值就是「泄漏」
   ├── Managed Heap 差值 > 1MB → 可能有 C# 引用泄漏
   ├── Native 差值大 → 可能有资源未卸载
   └── 在 Memory Profiler 中按类型排序定位泄漏大户
```

```csharp
// 在测试场景中一键做内存快照的辅助工具
public class MemorySnapshotTool : MonoBehaviour
{
    [ContextMenu("Force GC + Unload + Snapshot")]
    void TakeSnapshot()
    {
        System.GC.Collect();
        System.GC.WaitForPendingFinalizers();
        Resources.UnloadUnusedAssets();
        System.GC.Collect();

        string timestamp = System.DateTime.Now.ToString("yyyyMMdd_HHmmss");
        string path = $"MemorySnapshots/Snapshot_{timestamp}";

        UnityEngine.Profiling.Memory.MemoryProfiler.TakeSnapshot(
            path,
            (success, file) =>
            {
                Debug.Log(success
                    ? $"[MemorySnapshot] 保存成功: {file}"
                    : "[MemorySnapshot] 保存失败");
            });
    }
}
```

### ⚡ 实战经验

1. **`Resources.UnloadUnusedAssets()` 不是万能的**：它只能释放「没有任何引用」的资源。如果一个 Texture2D 被某个未销毁的 ScriptableObject 引用，即使场景里没人用它，也不会被卸载。排查时需要在 Memory Profiler 中用 Reference 链查找「谁在引用它」
2. **Addressables 的引用计数是双刃剑**：每次 `LoadAssetAsync` 会让引用计数 +1，每次 `Release` 让计数 -1，归零才真正卸载。多人协作中很容易「A 加载了 B 忘记释放」，建议封装一层带 Tag 的加载管理器，按 Tag 批量释放
3. **`Destroy` vs `DestroyImmediate`**：`Destroy` 是延迟到帧末执行，在那一帧内对象仍然存在、引用仍然有效；`DestroyImmediate` 立即销毁，但在非编辑器环境下不推荐使用。做内存快照前要等一帧让 `Destroy` 完成
4. **iOS 比 Android 更容易触发 OOM**：iOS 的 jetsam 机制非常激进，内存超限直接杀进程没有商量。Android 有 LMK（Low Memory Killer）但交换空间（swap）机制给了更多缓冲。上线前必须在 iPhone 低端机上跑 Memory Test（Xcode Instruments → Allocations）

### 🔗 相关问题

- Unity 的 Boehm GC 为什么容易产生内存碎片？什么时候会换成 SGC？
- 如何实现一个自动化内存泄漏检测管线（CI/CD 集成）？
- Graphics Driver 内存（GPU 显存）泄漏如何排查和定位？
