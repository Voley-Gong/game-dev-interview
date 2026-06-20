---
title: "Unity 资源卸载策略：UnloadUnusedAssets、UnloadAsset、AssetBundle.Unload 的区别与正确用法"
category: "unity"
level: 3
tags: ["资源管理", "内存管理", "AssetBundle", "Addressables", "卸载"]
related: ["unity/resources-load-vs-assetbundle", "unity/memory-management-leak", "unity/addressables-system"]
hint: "加载了资源，但卸载时用错了 API 导致内存泄漏或纹理丢失？三种卸载方式的本质区别是什么？"
---

## 参考答案

### ✅ 核心要点

1. **`Resources.UnloadUnusedAssets()`**：全局扫描，卸载所有未被引用的资源（GC 后生效），是异步操作
2. **`Resources.UnloadAsset(asset)`**：精确卸载单个资源，立即释放底层内存，但引用该资源的 GO 上的组件会丢失数据
3. **`AssetBundle.Unload(unloadAllLoadedObjects)`**：`true` 卸载 AssetBundle 及其所有已加载资源（可能引起场景中物体丢失纹理），`false` 仅卸载 Bundle 压缩数据
4. **卸载顺序铁律**：先解除引用 → 调用 GC → 再调 UnloadUnusedAssets → 最后 AssetBundle.Unload(false)
5. **Addressables 自动管理**：`Addressables.Release(handle)` 通过引用计数自动决定何时卸载，但需确保所有 handle 配对释放

### 📖 深度展开

#### 三种卸载 API 的本质对比

```
UnloadUnusedAssets()：
  遍历所有已加载资源
       ↓
  检查是否有托管引用（C#侧）
       ↓
  无引用 → 卸载 GPU/CPU 内存
  
UnloadAsset(asset)：
  直接释放指定资源的底层内存
       ↓
  ⚠ 不检查是否还有引用！
  ⚠ 适用范围有限：仅支持 Resources.Load 加载的资源
  ⚠ Texture/Mesh/AudioClip 等原生资源，不支持 GameObject

AssetBundle.Unload(true)：
  卸载 Bundle 的压缩数据 + 所有从此 Bundle 加载的资源
       ↓
  场景中正在使用这些资源的物体 → 材质变粉色 / Mesh 消失

AssetBundle.Unload(false)：
  仅卸载 Bundle 的压缩数据（已加载资源保留在内存）
       ↓
  ⚠ 已加载资源成为"孤儿"，无法再次加载同 Bundle 的其他资源
  ⚠ 需后续手动 Resources.UnloadUnusedAssets 才能清理
```

#### 完整卸载流程（正确顺序）

```csharp
public class AssetUnloadDemo : MonoBehaviour
{
    private AssetBundle _bundle;
    private GameObject _loadedPrefab;
    private Texture2D _loadedTexture;

    async void LoadAssets()
    {
        _bundle = AssetBundle.LoadFromFile(Path.Combine(Application.streamingAssetsPath, "mybundle"));
        _loadedPrefab = _bundle.LoadAsset<GameObject>("Player");
        _loadedTexture = _bundle.LoadAsset<Texture2D>("PlayerTex");
        // 使用中...
    }

    async System.Threading.Tasks.Task UnloadAllAsync()
    {
        // Step 1: 解除所有 C# 侧引用
        _loadedPrefab = null;
        _loadedTexture = null;

        // Step 2: 移除场景中实例化的物体
        // （此时材质引用的 Texture 还在内存中）

        // Step 3: 手动触发 GC，切断弱引用
        System.GC.Collect();
        System.GC.WaitForPendingFinalizers();

        // Step 4: 卸载未使用资源
        var op = Resources.UnloadUnusedAssets();
        while (!op.isDone) await System.Threading.Tasks.Task.Yield();

        // Step 5: 卸载 AssetBundle 压缩数据
        _bundle.Unload(false);
        _bundle = null;
    }
}
```

#### AssetBundle.Unload(true) vs (false) 决策图

```
           所有从此 Bundle 加载的资源
           是否仍在场景中使用？
                 │
         ┌──Yes──┴──No──┐
         │              │
    Unload(false)   Unload(true)
         │              │
  保留已加载资源     全部卸载
  释放压缩数据      释放所有
         │              │
  ⚠ 内存占用大     ✅ 内存彻底释放
  ⚠ Bundle不可再读  ⚠ 正在用的材质变粉
  需后续手动清理     
```

#### Addressables 的引用计数卸载

```csharp
// Addressables 内部维护引用计数
public class AddressablesDemo : MonoBehaviour
{
    private AsyncOperationHandle<Texture2D> _texHandle;
    private AsyncOperationHandle<GameObject> _prefabHandle;

    async void LoadAndUse()
    {
        _texHandle = Addressables.LoadAssetAsync<Texture2D>("PlayerTex");
        _prefabHandle = Addressables.LoadAssetAsync<GameObject>("Player");
        await _prefabHandle.Task;

        // 同一资源多次 Load → refCount++ → 不重复加载
        var handle2 = Addressables.LoadAssetAsync<Texture2D>("PlayerTex");
        // refCount = 2
    }

    void ReleaseAll()
    {
        // 每次 Release → refCount--
        Addressables.Release(_texHandle);    // refCount--
        Addressables.Release(handle2);       // refCount = 0 → 自动卸载
        
        Addressables.Release(_prefabHandle); // refCount = 0 → 自动卸载
    }
}
```

| 维度 | UnloadUnusedAssets | UnloadAsset | AssetBundle.Unload(true) | AssetBundle.Unload(false) | Addressables.Release |
|------|-------------------|-------------|------------------------|------------------------|-------------------|
| 作用范围 | 全局所有资源 | 单个资源 | 整个 Bundle | Bundle 压缩数据 | 单个 handle（引用计数） |
| 异步 | ✅ | ❌ 同步 | ❌ 同步 | ❌ 同步 | ✅ |
| 自动检查引用 | ✅ | ❌ | ❌ | ❌ | ✅（refCount） |
| 风险 | 低（只删无引用） | 高（误删在用资源） | 高（材质变粉） | 中（内存泄漏风险） | 低（引用计数保证） |
| 性能开销 | 高（全扫描） | 低 | 低 | 低 | 低 |
| 推荐场景 | 切场景/定期清理 | 极少使用 | 切场景时批量卸载 | 谨慎使用 | Addressables 项目首选 |

### ⚡ 实战经验

1. **最常见的坑：AssetBundle.Unload(true) 导致材质变粉色**：场景中物体引用的 Texture/Material 被卸载，Shader 丢失贴图后渲染为默认粉色。切场景时用 `Unload(false)` 更安全，配合 `UnloadUnusedAssets` 清理
2. **UnloadUnusedAssets 前必须先 GC**：`UnloadUnusedAssets` 只回收托管侧无引用的资源，如果 C# 侧仍有变量持有引用（即使 `null` 赋值后 GC 还没跑），资源不会被释放。顺序是 `obj = null → GC.Collect() → UnloadUnusedAssets()`
3. **Addressables handle 泄漏是内存增长主因**：每次 `LoadAssetAsync` 返回的 handle 必须配对 `Release`。建议封装一个 `AssetRef` 类管理生命周期，利用 `using` 或 `IDisposable` 自动释放
4. **内存 Profiler 配合验证卸载效果**：用 Memory Profiler Package 拍快照对比卸载前后的内存变化，确认资源真正被释放，而不是自以为释放了

### 🔗 相关问题

- AssetBundle 之间的依赖关系如何影响卸载顺序？
- Addressables 的资源在内存中的实际生命周期是怎样的？
- 如何检测和定位 Unity 项目中的内存泄漏？
