---
title: "Unity 场景管理有哪些方式？SceneManager、Additive Loading 和 Addressable Scenes 的区别是什么？"
category: "unity"
level: 2
tags: ["场景管理", "SceneManager", "Additive", "Addressables", "资源管理"]
related: ["unity/addressables-system", "unity/memory-management-leak", "unity/assetbundle-strategy"]
hint: "从单场景到无缝大世界，场景加载策略决定了游戏的内存布局和玩家体验。"
---

## 参考答案

### ✅ 核心要点

1. **SceneManager 是基础 API**，`LoadScene` 有 Single（替换）和 Additive（叠加）两种模式，Additive 模式是无缝大世界的技术基础
2. **Additive Loading 允许多场景共存**，可以实现「场景流式加载」——玩家移动时动态加载/卸载周围区块，避免一次性加载整个大世界
3. **Addressable Scenes 是更高层封装**，基于 Addressables 系统管理场景资源，自带引用计数、异步加载、依赖管理，是大型项目的首选方案
4. **场景切换的核心挑战是内存控制**：叠加场景意味着内存中同时存在多个场景的对象，必须精确管理卸载时机，否则内存只增不减
5. **多场景协同需要架构设计**：跨场景通信、光照数据共享、NavMesh 数据合并、烘焙光照冲突都是需要处理的工程问题

### 📖 深度展开

#### 场景加载方式对比

```
方式一：Single（替换加载）
┌──────────┐    LoadScene("Level2", Single)    ┌──────────┐
│  Level1  │ ───────────────────────────────→  │  Level2  │
│ 场景对象  │         (销毁旧场景)               │ 场景对象  │
└──────────┘                                    └──────────┘
→ 简单但画面会卡住（除非配合 LoadSceneAsync）

方式二：Additive（叠加加载）
┌──────────┐    LoadScene("Chunk_B", Additive)  ┌──────────────┐
│  Chunk_A │ ───────────────────────────────→  │ Chunk_A      │
│          │                                   │ + Chunk_B    │
└──────────┘                                   │ + Chunk_C... │
                                               └──────────────┘
→ 无缝加载，但内存持续增长，需手动卸载
```

#### 三种方案对比表

| 维度 | SceneManager | SceneManager Additive | Addressable Scenes |
|------|-------------|----------------------|-------------------|
| **加载粒度** | 整个场景 | 整个场景（叠加） | 场景 + 任意资源 |
| **异步支持** | ✅ LoadSceneAsync | ✅ LoadSceneAsync | ✅ 原生异步 |
| **依赖管理** | ❌ 手动处理 | ❌ 手动处理 | ✅ 自动解析依赖 |
| **引用计数** | ❌ 无 | ❌ 无 | ✅ 自动卸载 |
| **远程下载** | ❌ 不支持 | ❌ 不支持 | ✅ CDN 远程加载 |
| **内存控制** | 粗粒度 | 中等 | 精细 |
| **适用规模** | 小型游戏 | 中型游戏 | 大型/在线游戏 |

#### Additive 场景管理架构（分块世界示例）

```csharp
using UnityEngine;
using UnityEngine.SceneManagement;
using System.Collections.Generic;

/// <summary>
/// 场景分块管理器：根据玩家位置动态加载/卸载区块场景
/// </summary>
public class SceneChunkManager : MonoBehaviour
{
    [SerializeField] private Transform player;
    [SerializeField] private float chunkSize = 100f;  // 每个区块的世界尺寸
    [SerializeField] private int loadRadius = 2;       // 加载半径（区块数）

    // 记录当前已加载的区块
    private readonly Dictionary<Vector2Int, Scene> loadedChunks = new();

    private Vector2Int lastPlayerChunk;

    void Update()
    {
        Vector2Int currentChunk = WorldToChunk(player.position);

        if (currentChunk != lastPlayerChunk)
        {
            UpdateChunks(currentChunk);
            lastPlayerChunk = currentChunk;
        }
    }

    private Vector2Int WorldToChunk(Vector3 worldPos)
    {
        return new Vector2Int(
            Mathf.FloorToInt(worldPos.x / chunkSize),
            Mathf.FloorToInt(worldPos.z / chunkSize)
        );
    }

    private void UpdateChunks(Vector2Int centerChunk)
    {
        // 1. 卸载范围外的区块
        List<Vector2Int> toUnload = new();
        foreach (var chunk in loadedChunks.Keys)
        {
            if (Mathf.Abs(chunk.x - centerChunk.x) > loadRadius ||
                Mathf.Abs(chunk.y - centerChunk.y) > loadRadius)
            {
                toUnload.Add(chunk);
            }
        }

        foreach (var chunk in toUnload)
        {
            var unloadOp = SceneManager.UnloadSceneAsync(
                ChunkToSceneName(chunk),
                UnloadSceneOptions.UnloadAllEmbeddedSceneObjects
            );
            unloadOp.completed += _ => loadedChunks.Remove(chunk);
        }

        // 2. 加载范围内的区块
        for (int x = -loadRadius; x <= loadRadius; x++)
        {
            for (int y = -loadRadius; y <= loadRadius; y++)
            {
                var chunkCoord = new Vector2Int(centerChunk.x + x, centerChunk.y + y);
                if (!loadedChunks.ContainsKey(chunkCoord))
                {
                    string sceneName = ChunkToSceneName(chunkCoord);
                    if (SceneManager.GetSceneByName(sceneName).IsValid())
                        continue; // 已加载但尚未注册

                    var loadOp = SceneManager.LoadSceneAsync(
                        sceneName,
                        LoadSceneMode.Additive
                    );
                    loadOp.completed += _ =>
                    {
                        loadedChunks[chunkCoord] = SceneManager.GetSceneByName(sceneName);
                    };
                }
            }
        }
    }

    private string ChunkToSceneName(Vector2Int chunk)
        => $"Chunk_{chunk.x}_{chunk.y}";
}
```

#### Addressable Scenes 加载方式

```csharp
using UnityEngine.AddressableAssets;
using UnityEngine.ResourceManagement.AsyncOperations;
using UnityEngine.ResourceManagement.ResourceProviders;
using System.Collections.Generic;

public class AddressableSceneManager : MonoBehaviour
{
    // 存储场景加载句柄，用于按需卸载
    private readonly Dictionary<string, AsyncOperationHandle<SceneInstance>> sceneHandles = new();

    public void LoadScene(string sceneKey)
    {
        if (sceneHandles.ContainsKey(sceneKey)) return;

        var handle = Addressables.LoadSceneAsync(
            sceneKey,
            UnityEngine.SceneManagement.LoadSceneMode.Additive,
            activateOnLoad: true
        );

        handle.Completed += op =>
        {
            if (op.Status == AsyncOperationStatus.Succeeded)
            {
                sceneHandles[sceneKey] = op;
                Debug.Log($"场景 {sceneKey} 加载完成");
            }
        };
    }

    public void UnloadScene(string sceneKey)
    {
        if (!sceneHandles.TryGetValue(sceneKey, out var handle)) return;

        var unloadHandle = Addressables.UnloadSceneAsync(handle);
        unloadHandle.Completed += _ =>
        {
            sceneHandles.Remove(sceneKey);
            // Addressables 自动处理引用计数和依赖释放
        };
    }
}
```

#### 多场景协同的坑

```
问题                  │ 原因                          │ 解决方案
─────────────────────┼──────────────────────────────┼────────────────────────
烘焙光照冲突           │ 每个场景自带 Lightmap 数据     │ 使用 LightingSettings 共享
                     │                              │ 或用 Light Probes 代替
NavMesh 不连通         │ NavMesh 数据是 per-scene 的    │ 使用 NavMesh Link 连接
                     │                              │ 或运行时重新构建
场景间对象引用丢失      │ 加载时序不确定                 │ 用 ScriptableObject 或
                     │                              │ 事件系统解耦
同名对象冲突           │ 不同场景中同名 GameObject      │ 使用命名规范或 GUID
                     │ 导致查找混乱                   │
Scene Root 混乱        │ Additive 加载后新场景 Root     │ 加载后 SetParent 到
                     │ 堆叠在 Hierarchy              │ 统一的 Manager 节点
```

### ⚡ 实战经验

- **不要在加载场景的第一帧就访问场景对象**：`LoadSceneAsync` 即使 `activateOnLoad=true`，对象的 `Awake/Start` 执行也需要到下一帧，安全的做法是在 `handle.Completed` 回调中操作
- **Additive 场景的灯光环境是叠加的**：两个场景各有一个 Directional Light，叠加后场景亮度翻倍，解决方案是在「主场景」放灯光，「区块场景」不放任何光源
- **大世界流式加载的区块大小很关键**：太大（500m+）会导致加载时卡顿明显，太小（<50m）会导致加载/卸载过于频繁，实际项目中 80~150m 区块配合异步加载效果较好
- **Addressables 场景首次加载有额外的资源初始化开销**：实测比直接 SceneManager.LoadSceneAsync 慢 50~100ms（需要初始化 Resource Manager），在大世界加载中这个延迟可以通过预热 Addressables 系统来消除

### 🔗 相关问题

- Addressables 的引用计数机制具体是怎样的？什么情况下会卸载错误的资源？
- 如何实现无缝场景切换的过渡效果（如隧道遮罩、黑屏淡入淡出）？
- 多场景下的 Physics 场景分离是什么概念？如何避免不同场景的物理对象互相影响？
