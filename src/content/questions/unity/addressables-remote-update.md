---
title: "Unity Addressables 远程更新机制是怎样的？Catalog、Content Update、CDN 分发如何运作？"
category: "unity"
level: 3
tags: ["资源管理", "Addressables", "热更新", "CDN"]
related: ["unity/addressables-system", "unity/assetbundle-strategy"]
hint: "Addressables 如何实现资源热更新？Catalog 是什么？Content Update Build 和 Full Build 有什么区别？"
---

## 参考答案

### ✅ 核心要点

1. **Catalog（目录）** 是 Addressables 的核心映射表：将逻辑地址（如 "Assets/UI/MainMenu"）映射到物理路径（AssetBundle 名、Hash、依赖关系），运行时通过 Catalog 定位资源
2. **远程加载依赖 CDN**：将 AssetBundle 上传到 CDN，Addressables 自动处理下载、缓存、版本校验
3. **Content Update Build** 是增量更新流程：只重新构建变更的资源包，生成新的 Catalog，客户端比对 Catalog hash 触发更新
4. **版本管理通过 Catalog Hash + Player Content Version**：客户端首次加载远程 Catalog，与本地缓存比对，hash 不同则触发更新
5. **Addressables 2.x 引入了更灵活的 ContentCatalogProvider**，支持自定义 Catalog 加载逻辑和加密

### 📖 深度展开

#### Addressables 资源寻址与加载全链路

```
客户端代码
  │
  │  Addressables.LoadAssetAsync<GameObject>("MainMenu")
  ▼
┌─────────────────────────────┐
│  ResourceManager            │
│  1. 查 Catalog：解析地址     │
│     "MainMenu" → Bundle key │
│  2. 解析依赖链              │
│     MainMenu → shared_tex   │
│  3. 检查本地缓存            │
│     Cache 命中？→ 直接加载   │
│     未命中？  → 下载 Bundle  │
│  4. AssetBundle.LoadAsset   │
└─────────────┬───────────────┘
              ▼
         Asset（资源对象）
```

#### Catalog 机制详解

**Catalog 结构（运行时序列化为 JSON 或二进制）：**

| 字段 | 说明 | 示例 |
|------|------|------|
| Key | 资源逻辑地址 | `"MainMenu"` 或 GUID |
| InternalId | 物理路径 | `{Addressables.BasePath}/ui_mainmenu.bundle` |
| Dependencies | 依赖的其他 Bundle | `["shared_textures.bundle"]` |
| Data | 资源类型、Label 等 | `typeof(GameObject)` |
| ProviderId | 用哪个 Provider 加载 | `BundleProvider` / `Asset Provider` |

**Catalog 分类：**

- **Player Catalog**：打包时内置在 Player 中的 Catalog（包含本地资源）
- **Remote Catalog**：放在 CDN 上的 Catalog（包含远程资源 + 可更新资源）
- **Catalog Hash 文件**：`.hash` 文件用于版本比对

#### Content Update 完整流程

```
┌─────────── 开发侧 ───────────┐

1. New Group → 创建 Addressables Group
   ├── Local Group（打进包体）
   └── Remote Group（放 CDN）

2. 标记资源为 Addressable
   → 指定 Group

3. Content Update 前先做：
   a. Addressables Analyze（检查冲突）
   b. Build → New Build → Default Build Script（首次）
   c. 后续用 Build → Update a Previous Build

4. Update a Previous Build：
   → 选择上次的 addressables_content_state.bin
   → Unity 检测变更的 Group
   → 只重建变更的 Bundle
   → 生成新 Catalog + 新 Hash

5. 上传到 CDN：
   → ServerData/<platform>/ 下的所有文件
   → 替换 CDN 上的旧版本
└──────────────────────────────┘

┌─────────── 客户端侧 ───────────┐

1. App 启动 → 初始化 Addressables
   → 自动加载 Remote Catalog

2. 比对 Catalog Hash
   → Hash 相同：使用缓存
   → Hash 不同：下载新 Catalog

3. 加载资源时：
   → 查新 Catalog 获取 Bundle 信息
   → 检查本地缓存（Unity Cache）
   → 需要则下载，否则直接加载

4. 旧 Bundle 自动清理：
   → Addressables 清理不再引用的缓存
└──────────────────────────────┘
```

#### Content Update vs Full Build 对比

| 维度 | Full Build | Content Update |
|------|-----------|----------------|
| 重建范围 | 所有 Bundle | 仅变更的 Group |
| 速度 | 慢（全量） | 快（增量） |
| 生成物 | 全部 Bundle + Catalog | 变更 Bundle + 新 Catalog |
| 使用场景 | 首次构建/大版本 | 小版本热更/补丁 |
| 前置条件 | 无 | 需要 `addressables_content_state.bin` |
| 依赖文件 | 无 | `addressables_content_state.bin` |

#### 代码示例：手动检查更新 + 预下载

```csharp
using System.Collections;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.AddressableAssets.ResourceLocators;
using UnityEngine.ResourceManagement.AsyncOperations;

public class AddressablesUpdateChecker : MonoBehaviour
{
    [SerializeField] private string catalogPath = "https://cdn.example.com/catalog.json";

    public IEnumerator CheckAndUpdateCatalog()
    {
        // 1. 初始化 Addressables（如果尚未初始化）
        var initHandle = Addressables.InitializeAsync();
        yield return initHandle;

        // 2. 检查并更新 Catalog
        var catalogHandle = Addressables.CheckForCatalogUpdates(false);
        yield return catalogHandle;

        if (catalogHandle.Status == AsyncOperationStatus.Succeeded)
        {
            var catalogsToUpdate = catalogHandle.Result;
            if (catalogsToUpdate.Count > 0)
            {
                Debug.Log($"发现 {catalogsToUpdate.Count} 个 Catalog 需要更新");

                // 3. 更新 Catalog
                var updateHandle = Addressables.UpdateCatalogs(catalogsToUpdate, false);
                yield return updateHandle;

                // 4. 获取资源大小，决定是否预下载
                var sizeHandle = Addressables.GetDownloadSizeAsync("PreloadLabel");
                yield return sizeHandle;

                long totalBytes = sizeHandle.Result;
                Debug.Log($"需要下载: {totalBytes / 1024f / 1024f:F2} MB");

                if (totalBytes > 0)
                {
                    // 5. 预下载
                    var downloadHandle = Addressables.DownloadDependenciesAsync("PreloadLabel", false);
                    while (!downloadHandle.IsDone)
                    {
                        float percent = downloadHandle.PercentComplete;
                        Debug.Log($"下载进度: {percent * 100:F1}%");
                        yield return null;
                    }
                    Addressables.Release(downloadHandle);
                }

                Addressables.Release(sizeHandle);
            }
        }
        Addressables.Release(catalogHandle);
    }

    // 清理旧缓存
    public IEnumerator CleanOldCache()
    {
        var cleanHandle = Addressables.CleanUnusedCacheFiles();
        yield return cleanHandle;
        Debug.Log("旧缓存清理完成");
    }
}
```

#### Group 设置关键参数

| 参数 | 说明 | 建议 |
|------|------|------|
| Bundle Mode | Pack Together / Pack Separately / Pack Together By Label | UI 一起打包，大资源分开 |
| Compression | Uncompressed / LZ4 / LZ4HC | 移动端 LZ4（快速解压） |
| Include in Build | 是否参与构建 | false = 仅编辑器用 |
| Asset Provider | 加载方式 | Bundle Provider |
| Use Asset Bundle Cache | 是否缓存远程 Bundle | 必须开启 |
| Bundle Naming | Filename / Hash | Hash 避免 CDN 缓存命中问题 |

### ⚡ 实战经验

1. **CDN 缓存陷阱**：Bundle 文件名如果不带 hash，CDN 可能缓存旧版本。使用 `Bundle Naming = Hash` 或在 CDN 配置正确的 Cache-Control 策略。遇到过更新了 Catalog 但 CDN 返回旧 Bundle 的问题
2. **`addressables_content_state.bin` 必须版本管理**：每次 Content Update 都依赖这个文件。建议将 `ServerData/` 目录纳入 Git，或者 CI/CD 中保存每次构建的产出
3. **Group 划分影响更新包大小**：如果把不常变更的核心资源和频繁更新的活动资源放在同一个 Group，每次更新整组重建。原则：按"更新频率"划分 Group，高频更新的资源单独成组
4. **Addressables 2.x 的 `CheckForCatalogUpdates` 行为变化**：2.x 改为异步 Provider 架构，某些回调时序和 1.x 不同，升级时需要测试所有加载路径

### 🔗 相关问题

- Addressables 和 AssetBundle 的关系是什么？为什么推荐 Addressables？
- 如何实现 Addressables 资源的加密和防盗链？
- Addressables 在移动端的内存管理有哪些注意事项？
