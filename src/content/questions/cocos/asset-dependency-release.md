---
title: "Cocos Creator 3.x 资源依赖与释放机制是怎样的？"
category: "cocos"
level: 3
tags: ["资源管理", "内存优化", "assetManager"]
related: ["cocos/asset-management", "cocos/memory-management"]
hint: "加载一个 Prefab 时，它引用的贴图、材质、动画是否也被自动管理？释放时呢？"
---

## 参考答案

### ✅ 核心要点

1. **依赖追踪**：`assetManager` 在加载资源时自动建立依赖关系图（DependMap）
2. **引用计数**：每个资源维护引用计数，只有计数归零才可安全释放
3. **`assetManager.release(asset)`**：释放资源本身，但不会自动释放其依赖
4. **`assetManager.releaseAsset(asset)`**：释放单个资源及其依赖链（深度释放）
5. **自动释放**：场景切换时可通过 `autoRelease` 属性配置是否自动释放场景资源

### 📖 深度展开

#### 依赖关系图

Cocos Creator 3.x 的资源系统基于 **Asset** 类，每个资源都记录了自己依赖的其他资源 UUID：

```
Player.prefab
  ├── player.png (SpriteFrame)
  │    └── player_texture.png (Texture2D)
  ├── player_walk.anim (AnimationClip)
  └── player_skin.mat (Material)
       └── player.png (共享引用)
```

当 `assetManager.loadBundle` + `bundle.load` 加载 Prefab 时，引擎会：

1. 下载并解析 `.json` 配置文件
2. 递归解析依赖列表
3. 按拓扑顺序加载所有依赖资源
4. 建立 `Asset.__depends__` 引用链

#### 释放策略对比

| 方法 | 释放自身 | 释放依赖 | 适用场景 |
|------|---------|---------|---------|
| `assetManager.release(asset)` | ✅ | ❌ | 精确控制，手动管理依赖 |
| `assetManager.releaseAsset(asset)` | ✅ | ✅（递归） | 一键释放，需注意共享资源 |
| `scene.autoRelease = true` | ✅ | ✅ | 场景切换时自动释放 |
| `bundle.releaseAll()` | ✅ | ✅ | 整个 Bundle 卸载 |

#### 引用计数陷阱：共享资源

```typescript
// 场景：两个角色共用同一个贴图
const hero = await bundle.load('hero', Prefab);
const enemy = await bundle.load('enemy', Prefab);
// hero 和 enemy 都依赖 shared_texture.png

// ❌ 危险：直接释放 hero 的全部依赖
assetManager.releaseAsset(hero);
// shared_texture.png 可能被释放！enemy 实例会出现黑块/丢失贴图

// ✅ 正确：使用引用计数检查
// Cocos 内部会维护 _references，releaseAsset 会检查引用计数
// 但如果通过 release() 逐个释放，需手动确认
```

#### 实际项目中的资源释放流程

```typescript
export class ResourceManager {
    private static bundles: Map<string, AssetManager.Bundle> = new Map();

    /** 安全释放单个资源 */
    static safeRelease(asset: Asset): void {
        if (!asset) return;
        // 检查引用计数
        const refCount = (asset as any)._references;
        if (refCount > 0) {
            console.warn(`[ResourceManager] ${asset.name} 仍有 ${refCount} 个引用，跳过释放`);
            return;
        }
        assetManager.releaseAsset(asset);
        asset.decRef(true); // 破坏引用链，允许 GC 回收
    }

    /** 切关时批量释放 */
    static releaseSceneAssets(sceneName: string): void {
        // 方案1：使用场景的 autoRelease 机制（推荐）
        // 在场景属性面板勾选 Auto Release

        // 方案2：手动释放 Bundle 中该场景的资源
        const bundle = this.bundles.get(sceneName);
        if (bundle) {
            bundle.releaseAll();
            this.bundles.delete(sceneName);
        }
    }
}
```

#### `decRef()` 与 `addRef()`

每个 `Asset` 对象内部维护 `_refCount`：

```typescript
const texture = bundle.get('hero_tex', Texture2D);
texture.addRef();    // refCount = 2（加载时已是1）
// ... 使用完毕 ...
texture.decRef();    // refCount = 1
texture.decRef();    // refCount = 0 → 引擎标记为可释放
// 此时再调用 assetManager.releaseAsset(texture) 才会真正释放底层 GPU 资源
```

### ⚡ 实战经验

1. **黑块/紫块问题**：90% 的概率是资源依赖释放导致。尤其在角色换装系统中，不同 Prefab 共享同一个基础贴图，释放一个会波及另一个。建议对共享资源调用 `addRef()` 做保护。
2. **Bundle 粒度规划**：把常驻资源和可能释放的资源分到不同 Bundle。例如 UI 公共素材放 `core` Bundle（永不释放），关卡素材放 `level-x` Bundle（切关时释放整个 Bundle）。
3. **内存排查工具**：使用 Chrome DevTools 的 Memory 面板做 Heap Snapshot 对比。在 Cocos DevTools 中的 Texture/Mesh 计数也能快速定位泄漏。
4. **`autoRelease` 的坑**：场景勾选 `autoRelease` 后，场景内通过 `resources.load()` 动态加载的资源不会被自动释放——`autoRelease` 只管场景配置内声明引用的资源。

### 🔗 相关问题

- Bundle 的加载和卸载策略应该如何设计？
- 如何检测和排查内存泄漏？
- 角色换装系统中如何管理共享资源的引用计数？
