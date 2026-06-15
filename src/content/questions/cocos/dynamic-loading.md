---
title: "Cocos Creator 中如何实现资源的动态加载与释放策略？"
category: "cocos"
level: 3
tags: ["资源管理", "性能优化", "动态加载"]
related: ["cocos/asset-management", "cocos/memory-management"]
hint: "resources 目录、bundle 分包、引用计数、资源释放，怎样组成完整的资源生命周期？"
---

## 参考答案

### ✅ 核心要点

1. **resources 动态加载** → `resources.load()` 加载 resources 目录下的资源，适合小量动态资源
2. **Asset Bundle 分包** → 将资源拆分为独立 bundle，按需下载和加载，适合大型游戏
3. **引用计数管理** → 加载的资源通过 `addRef()` / `decRef()` 管理生命周期，引用归零才真正释放
4. **释放策略** → 场景切换时批量释放、LRU 缓存淘汰、手动释放三种策略配合使用
5. **依赖链处理** → 释放资源时必须考虑依赖关系（如 SpriteAtlas → SpriteFrame → Texture2D）

### 📖 深度展开

#### 资源加载方式全景

```
┌──────────────────────────────────────────────────┐
│              资源加载方式选型                       │
├──────────────┬───────────────────────────────────┤
│ 编辑器引用    │ 序列化在场景/Prefab 中，自动加载     │
│ resources    │ 运行时动态加载，打包进主包           │
│ Asset Bundle │ 独立下载的资源包，按需加载           │
│ 远程加载      │ 从服务器/CDN 下载，需要缓存管理      │
└──────────────┴───────────────────────────────────┘
```

#### resources 动态加载

```typescript
import { resources, SpriteFrame, Asset } from 'cc';

// 加载单个资源
resources.load('icons/sword', SpriteFrame, (err, asset) => {
    if (err) {
        console.error('加载失败', err);
        return;
    }
    sprite.spriteFrame = asset;
});

// 加载目录下所有资源
resources.loadDir('weapons', SpriteFrame, (err, assets) => {
    if (err) return;
    console.log(`加载了 ${assets.length} 个资源`);
});

// 预加载（不返回资源，只写入缓存）
resources.preload('boss/explosion', Asset, () => {
    console.log('预加载完成');
});
```

#### Asset Bundle 分包加载

```typescript
import { assetManager, AssetManager, JsonAsset } from 'cc';

// 加载 Bundle
assetManager.loadBundle('boss-level', (err, bundle: AssetManager.Bundle) => {
    if (err) {
        console.error('Bundle 加载失败', err);
        return;
    }
    
    // 从 Bundle 加载资源
    bundle.load('config/boss-data', JsonAsset, (err, data) => {
        console.log('Boss 数据加载完成', data.json);
    });
    
    // 预加载整个场景
    bundle.preloadScene('BossScene', () => {
        console.log('场景预加载完成');
    });
});

// 远程 Bundle（热更新场景）
assetManager.loadBundle('https://cdn.example.com/bundles/ui-pack', 
    { version: '1.0.3' }, 
    (err, bundle) => { /* ... */ }
);
```

#### 引用计数与释放

```typescript
import { SpriteFrame } from 'cc';

// 加载资源后，引用计数为 1
const sf = await loadAsset<SpriteFrame>('icons/coin');
// sf.refCount === 1

// 多处使用时手动 addRef
sf.addRef();  // refCount === 2

// 使用完毕后 decRef
sf.decRef();  // refCount === 1（还不释放）
sf.decRef();  // refCount === 0 → 引擎自动释放

// ⚠️ 常见错误：直接赋值为 null 不会释放资源！
sprite.spriteFrame = null;  // 只是断开引用，资源仍在内存中
// 必须调用 decRef 才会进入释放流程
```

#### 资源释放策略对比

| 策略 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| 场景切换批量释放 | 关卡制游戏 | 简单粗暴，效果好 | 不适合共享资源 |
| 引用计数自动释放 | 大多数项目 | 精准，无泄漏 | 需要严格的 addRef/decRef 配对 |
| LRU 缓存淘汰 | 大量纹理/音频 | 自动管理，上限可控 | 可能淘汰正在使用的资源 |
| 手动时机释放 | 特定大资源 | 控制精确 | 容易遗漏，出错难排查 |

#### 完整的资源管理器示例

```typescript
import { Asset, resources, assetManager } from 'cc';

/**
 * 简易资源管理器：引用计数 + 自动释放
 */
export class ResManager {
    private static cache = new Map<string, Asset>();

    static async load<T extends Asset>(
        path: string, 
        type: new () => T, 
        bundle?: string
    ): Promise<T> {
        const key = bundle ? `${bundle}:${path}` : path;
        
        if (this.cache.has(key)) {
            const asset = this.cache.get(key) as T;
            asset.addRef();
            return asset;
        }

        return new Promise((resolve, reject) => {
            const handler = (err: Error | null, asset: T) => {
                if (err) { reject(err); return; }
                asset.addRef(); // 缓存持有一份引用
                this.cache.set(key, asset);
                asset.addRef(); // 调用者持有一份引用
                resolve(asset);
            };

            if (bundle) {
                assetManager.getBundle(bundle)?.load(path, type, handler);
            } else {
                resources.load(path, type, handler);
            }
        });
    }

    static release(path: string, bundle?: string) {
        const key = bundle ? `${bundle}:${path}` : path;
        const asset = this.cache.get(key);
        if (asset) {
            asset.decRef(); // 调用者释放引用
            if (asset.refCount <= 1) {
                asset.decRef();   // 缓存释放引用
                this.cache.delete(key);
            }
        }
    }

    static releaseAll() {
        this.cache.forEach(asset => {
            while (asset.refCount > 0) asset.decRef();
        });
        this.cache.clear();
        resources.releaseAllAssets();
    }
}
```

### ⚡ 实战经验

1. **纹理是内存大户**：一张 2048×2048 RGBA 纹理 = 16MB 显存。关卡切换时如果不释放上一关的纹理，几关之后内存直接爆炸。务必在 profiler 中监控纹理内存
2. **依赖释放陷阱**：加载一个 Prefab 时，它引用的 Material、Texture、Mesh 都会被自动加载并计数。但如果你手动 `addRef` 了 Prefab 中的某个 Material 单独使用，释放 Prefab 不会释放这个 Material——必须单独 `decRef`
3. **Bundle 版本管理**：热更新时 Bundle 的 `version` 号必须和 manifest 一致，否则加载到旧版本资源会导致难以排查的 bug。建议 CI/CD 流程中自动校验版本号
4. **resources 目录不是万能的**：`resources` 目录下的所有资源都会被打包进主包（不能分包），大量放在 resources 下会导致首包体积膨胀。正确做法是绝大部分资源用编辑器引用，只有需要运行时决定的才放 resources 或 Bundle

### 🔗 相关问题

- Cocos Creator 的 `resources.release()` 和 `asset.decRef()` 有什么区别？
- 如何实现基于 Asset Bundle 的热更新完整流程？
- 大量音频文件的流式加载（streaming）和一次性加载如何选择？
