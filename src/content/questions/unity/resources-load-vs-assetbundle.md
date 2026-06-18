---
title: "Unity 的 Resources.Load、AssetBundle、Addressables 三种资源加载方式有什么区别？如何选择？"
category: "unity"
level: 2
tags: ["资源管理", "Resources", "AssetBundle", "Addressables", "内存管理"]
related: ["unity/assetbundle-strategy", "unity/addressables-system"]
hint: "从加载机制、内存开销、热更新能力、维护成本四个维度做横向对比。"
---

## 参考答案

### ✅ 核心要点

1. **Resources.Load** 将资源打包进 APK/IPA 内部，启动时全部序列化文件索引加载到内存，无法热更新，仅适合小量必加载资源
2. **AssetBundle** 是 Unity 的动态资源包机制，支持运行时下载、按需加载和热更新，但 API 繁琐、依赖管理容易出错
3. **Addressables** 是 Unity 官方推荐的资源管理框架，在 AssetBundle 之上提供地址寻址、自动依赖管理、内存引用计数，是未来标准
4. **内存安全**：Resources.Load 加载的资源常驻内存无法卸载（只能卸载 Resources 整个池）；AssetBundle/Addressables 支持精确卸载
5. **选择原则**：新项目直接上 Addressables；老项目维护用 AssetBundle；Resources.Load 仅用于少量启动期必需资源（如启动 UI、首屏 Prefab）

### 📖 深度展开

#### 三种加载方式架构对比

```
Resources.Load（内置打包）
┌──────────────────────────────┐
│  APK / IPA                    │
│  ├── resources.assets         │ ← 所有 Resources 资源打成一个包
│  ├── resources.assets.resS    │
│  └── 启动时全量加载索引         │ ← 内存常驻，无法热更
└──────────────────────────────┘

AssetBundle（动态包）
┌──────────────────────────────┐
│  服务器 / CDN                  │
│  ├── hero_ab                  │ ← 按需打包、按需下载
│  ├── ui_ab                    │ ← 可热更新
│  └── map_ab                   │
│         ↓ 运行时下载            │
│  本地缓存                      │
│  └── AssetBundle.LoadFromFile │ ← 手动管理依赖、手动卸载
└──────────────────────────────┘

Addressables（地址寻址框架）
┌──────────────────────────────┐
│  Addressables Group 配置       │
│  ├── Group: Heroes            │ ← 按组打包，自动依赖分析
│  ├── Group: UI                │
│  └── Group: Maps              │
│         ↓ 运行时              │
│  LoadAssetAsync<T>("Hero/Knight") │ ← 按地址加载，自动加载依赖
│         ↓                     │
│  引用计数 = 0 → 自动卸载       │ ← 无需手动管理内存
└──────────────────────────────┘
```

#### 横向对比表

| 维度 | Resources.Load | AssetBundle | Addressables |
|------|---------------|-------------|--------------|
| 资源位置 | 打包进包体 | 本地/远程均可 | 本地/远程均可 |
| 热更新 | ❌ 不支持 | ✅ 支持 | ✅ 支持 |
| 依赖管理 | 自动 | 手动（容易出错） | 自动 |
| 内存释放 | 只能全量卸载 | 精确（Unload卸载包） | 自动引用计数 |
| API 复杂度 | 极简（一行） | 复杂（加载+依赖+卸载） | 中等（异步为主） |
| 包体大小 | 增大主包 | 可分包下载 | 可分包下载 |
| 启动开销 | 大（全量索引） | 小 | 小 |
| 学习成本 | 低 | 高 | 中 |
| 推荐度 | ⭐ 仅小项目 | ⭐⭐⭐ 维护期 | ⭐⭐⭐⭐⭐ 首选 |

#### Resources.Load 的隐藏陷阱

```csharp
// ❌ 看起来无害，实际上很危险
public class BootLoader : MonoBehaviour
{
    void Start()
    {
        // Resources 文件夹下的所有资源会在启动时
        // 被序列化进 resources.assets
        // 即使你只加载了一个Prefab，整个 Resources
        // 目录的序列化数据也常驻内存
        var prefab = Resources.Load<GameObject>("Prefabs/BootScreen");
        Instantiate(prefab);
    }
}

// ⚠️ 卸载Resources加载的资源
// Resources.UnloadUnusedAssets() 只能卸载未被引用的资源
// Resources.UnloadAsset() 只能卸载单个资源
// 无法像AssetBundle一样精确释放某个包的所有资源
```

#### AssetBundle 依赖管理示例

```csharp
// AssetBundle 的经典痛点：依赖链管理
// 假设 Knight.prefab 依赖 knight_tex.tga（在另一个AB中）

public class ABLoader : MonoBehaviour
{
    void LoadKnight()
    {
        // 1. 必须先加载依赖的AB
        var texAB = AssetBundle.LoadFromFile(
            Path.Combine(Application.streamingAssetsPath, "knight_tex"));
        
        // 2. 再加载主AB
        var prefabAB = AssetBundle.LoadFromFile(
            Path.Combine(Application.streamingAssetsPath, "knight_prefab"));
        
        // 3. 加载资源
        var prefab = prefabAB.LoadAsset<GameObject>("Knight");
        Instantiate(prefab);
        
        // 4. 卸载时如果先卸载texAB再卸载prefabAB
        //    材质引用会丢失（材质变粉色！）
    }
}

// ✅ 实际项目必须用清单文件（Manifest）管理依赖
// AssetBundleManifest.GetAllDependencies(name) 返回依赖列表
```

#### Addressables 的简洁写法

```csharp
using UnityEngine.AddressableAssets;
using UnityEngine.ResourceManagement.AsyncOperations;

public class AddressablesLoader : MonoBehaviour
{
    private GameObject _knightInstance;

    async void LoadKnight()
    {
        // 一行搞定：自动加载依赖、自动缓存
        var handle = Addressables.InstantiateAsync("Hero/Knight");
        _knightInstance = await handle.Task;

        // 释放：引用计数归零自动卸载
        Addressables.Release(handle);
    }

    void OnDestroy()
    {
        if (_knightInstance != null)
            Addressables.ReleaseInstance(_knightInstance);
    }
}
```

```
Addressables 内存管理流程：

LoadAsset("Knight")  →  refCount = 1
  ↓
LoadAsset("Knight")  →  refCount = 2  (同一资源复用)
  ↓
Release("Knight")    →  refCount = 1
  ↓
Release("Knight")    →  refCount = 0  →  自动卸载Asset + 依赖AB
```

### ⚡ 实战经验

- **Resources.Load 的包体膨胀**：项目早期把大量 Prefab 放在 Resources 目录，最终 APK 比预期大了 200MB，因为 Resources 内的资源不会被引擎裁剪。修复方案：迁移到 Addressables，启动时按需下载
- **AssetBundle 依赖丢失（粉红材质）**：最经典也最痛的坑。调试时使用 `AssetBundleManifest` 打印完整依赖链，确保加载顺序正确；Addressables 从根本上解决了这个问题
- **Addressables 远程加载的 CDN 回源**：线上项目首次启动大量玩家同时下载 AB，CDN 流量峰值极高。对策：预下载策略（后台静默下载关键资源）+ 分批发布（灰度更新时分批次推送）
- **卸载时机的选择**：切换场景时统一释放上一个场景的 Addressables 资源，避免频繁加载卸载导致内存碎片化和 GC Spike

### 🔗 相关问题

- AssetBundle 的 LZ4 和 LZMA 压缩格式有什么区别？分别适用于什么场景？
- 如何设计 Addressables 的分组策略以优化包体和加载速度？
- Resources.Load 加载的资源在内存中到底是什么结构？为什么无法精确卸载？
