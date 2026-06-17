---
title: "Unity Addressables 资源管理系统的工作原理是什么？与 AssetBundle 有何区别？"
category: "unity"
level: 3
tags: ["资源管理", "Addressables", "AssetBundle"]
related: ["unity/assetbundle-strategy"]
hint: "Addressables 不是 AssetBundle 的替代品，而是对资源地址、加载、卸载生命周期的抽象管理层"
---

## 参考答案

### ✅ 核心要点

1. **Addressables 是资源管理框架**，底层仍使用 AssetBundle，但在其上封装了地址解析、异步加载、引用计数、远程更新等完整生命周期管理
2. **核心概念"地址"**：每个资源有一个可寻址的 key（字符串或 GUID），加载时不再关心资源在哪个 bundle 中，由系统自动解析
3. **引用计数自动管理**：`LoadAssetAsync` 增加引用，`Release` 减少引用，归零时自动卸载 bundle，彻底解决 AssetBundle 的"手动管理引用计数"痛点
4. **内置远程更新**：通过 Catalog 文件记录资源版本，运行时检查更新并增量下载，不需要自己写版本对比逻辑
5. **分组（Group）策略**：资源按 Group 打包，每个 Group 可配置打包方式（Single/Together/Separately）、压缩方式、加载路径等

### 📖 深度展开

#### Addressables 架构总览

```
开发者代码（按地址加载）
       ↓
Addressables API
  ├── ResourceManager（资源管理器）
  │     ├── 解析地址 → Asset Location
  │     ├── 选择 Provider（AssetDatabase / Bundles / Instantiation）
  │     └── 依赖链解析（A 依赖 B，先加载 B）
  │
  ├── Catalog（资源目录）
  │     ├── 本地 catalog.json（内置资源映射）
  │     └── 远程 catalog.hash（版本校验）
  │
  └── Provider 层
        ├── AssetDatabaseProvider（编辑器模式，直接用 AssetDatabase）
        ├── BundledAssetProvider（从 AssetBundle 加载）
        ├── AssetBundleProvider（下载/加载 Bundle 文件）
        └── InstanceProvider（实例化 GameObject）
```

#### Addressables vs 传统 AssetBundle

| 维度 | 传统 AssetBundle | Addressables |
|------|-----------------|--------------|
| **资源定位** | 手动维护 bundle 名 → 资源路径映射 | 用地址字符串直接加载，自动解析 |
| **依赖管理** | 手动记录和加载依赖 bundle | 自动解析并加载依赖 |
| **引用计数** | 完全手动，容易出错 | 自动引用计数，归零自动卸载 |
| **编辑器模拟** | 需要打包才能测试 | Play Mode 可选 "Use Asset Database"（无需打包） |
| **远程更新** | 自己实现版本对比和增量下载 | 内置 `CheckForCatalogUpdate` + 自动差异下载 |
| **学习成本** | 需深入理解底层机制 | API 简洁，但需理解 Group 和 Label 配置 |
| **灵活性** | 极高，完全自主可控 | 框架封装，高度自定义但有一定约束 |
| **调试工具** | 基本无 | Addressables Event Viewer、Analyze 工具 |
| **适合项目** | 有成熟框架的中大型团队 | 所有项目（Unity 官方推荐方案） |

#### 核心加载 API 示例

```csharp
using UnityEngine.AddressableAssets;
using UnityEngine.ResourceManagement.AsyncOperations;
using System.Threading.Tasks;

public class AddressablesExample : MonoBehaviour
{
    private GameObject instance;

    async void Start()
    {
        // 1. 加载单个资源（最常用）
        var handle = Addressables.InstantiateAsync("BossDragon");
        await handle.Task;
        instance = handle.Result;

        // 2. 加载 Sprite
        var spriteHandle = Addressables.LoadAssetAsync<Sprite>("UI/Icon_Health");
        Sprite icon = await spriteHandle.Task;

        // 3. 按 Label 批量加载
        var allWeapons = await Addressables
            .LoadAssetsAsync<GameObject>("Weapons", null)
            .Task;
        // 加载所有标记了 "Weapons" label 的资源

        // 4. 预加载（下载但不实例化）
        var preloadHandle = Addressables.DownloadDependenciesAsync("Level_01");
        await preloadHandle.Task;
        // 适合在 Loading 场景预加载后续场景资源

        // 5. 获取下载大小（用于提示玩家）
        long downloadSize = await Addressables
            .GetDownloadSizeAsync("Level_01")
            .Task;
        Debug.Log($"需下载: {downloadSize / 1024f / 1024f:F1} MB");
    }

    void OnDestroy()
    {
        // ⚠️ 关键：加载了就必须 Release，否则资源永远不会卸载
        if (instance != null)
        {
            Addressables.ReleaseInstance(instance);
        }
    }
}
```

#### Group 打包策略配置

```
Addressables Group 窗口
├── Built In Data（内置资源）
│     └── Shader: Shader Variant Collection
│
├── UI_Group
│     ├── Bundle Mode: Pack Together（所有 UI 打成一个包）
│     ├── Compression: LZ4（快速解压）
│     └── Load Path: Local（内置包）
│
├── Characters_Group
│     ├── Bundle Mode: Pack Separately（每个角色单独打包）
│     ├── Compression: LZ4HC
│     └── Load Path: Remote（CDN 下载）
│
└── Audio_Group
      ├── Bundle Mode: Pack Together
      ├── Compression: LZMA（最高压缩率，适合音频）
      └── Load Path: Remote
```

#### 运行时远程更新流程

```csharp
public async Task<bool> CheckAndUpdateResources()
{
    // 1. 初始化 Addressables（首次使用必须等待）
    await Addressables.InitializeAsync().Task;

    // 2. 检查 Catalog 是否有更新
    var checkHandle = Addressables.CheckForCatalogUpdates(false);
    await checkHandle.Task;
    List<string> catalogsToUpdate = checkHandle.Result;
    Addressables.Release(checkHandle);

    if (catalogsToUpdate.Count == 0)
    {
        Debug.Log("资源已是最新");
        return false;
    }

    // 3. 更新 Catalog
    var updateHandle = Addressables.UpdateCatalogs(catalogsToUpdate, false);
    await updateHandle.Task;
    Addressables.Release(updateHandle);

    // 4. 检查需要下载的资源大小
    long totalSize = 0;
    var sizeHandle = Addressables.GetDownloadSizeAsync("preload");
    totalSize = await sizeHandle.Task;
    Addressables.Release(sizeHandle);

    if (totalSize > 0)
    {
        Debug.Log($"需要更新资源: {totalSize / 1024f / 1024f:F1} MB");

        // 5. 下载更新（可以配合进度条）
        var downloadHandle = Addressables.DownloadDependenciesAsync("preload");
        while (!downloadHandle.IsDone)
        {
            float progress = downloadHandle.PercentComplete;
            Debug.Log($"下载进度: {progress * 100:F0}%");
            await Task.Yield();
        }
        Addressables.Release(downloadHandle);
    }

    return true;
}
```

### ⚡ 实战经验

1. **最大陷阱：忘记 Release**。每次 `LoadAssetAsync` / `InstantiateAsync` 都会产生一个 handle，必须配对 `Release` / `ReleaseInstance`。推荐封装一层 ResourceManager 做统一的生命周期管理，在场景切换或模块销毁时批量释放
2. **Play Mode 设置要区分开发与测试**。开发日常用 "Use Asset Database"（零等待、改资源即时生效），但 CI 测试和上线前必须切换到 "Use Existing Build"（模拟真实打包加载流程），否则线上暴露的 bundle 依赖问题本地完全发现不了
3. **Analyze 工具必看**。Addressables Groups 窗口 → Analyze，能检测出资源重复打包（同一个资源被多个 Group 引用但没配置为共享 bundle）、Shader 丢失变体等问题。上线前必须跑一遍
4. **内存监控用 Addressables Event Viewer**（Window → Analysis → Addressables Event Viewer），可以可视化查看每次加载/卸载的引用链，定位"资源加载了但没释放"的泄漏点

### 🔗 相关问题

- Addressables 的 `LoadAssetAsync` 和 `Resources.Load` 底层有什么区别？
- 如何设计一个基于 Addressables 的场景管理系统？
- Addressables 打包后 bundle 之间存在依赖，如果更新了被依赖的 bundle，依赖它的 bundle 也需要更新吗？
