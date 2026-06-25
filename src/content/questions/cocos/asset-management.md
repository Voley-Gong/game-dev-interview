---
title: "Cocos Creator 资源管理系统是怎样的？Asset Bundle、引用计数与释放策略"
category: "cocos"
level: 2
tags: ["资源管理", "Asset Bundle", "内存优化", "引擎原理"]
related: ["cocos/memory-management", "cocos/hot-update-design"]
hint: "从资源加载方式、Bundle 机制、引用计数到释放策略，如何避免内存泄漏？"
---

## 参考答案

### ✅ 核心要点

1. **资源加载体系**：`resources` 动态加载、`AssetBundle` 按需下载、`editor` 静态引用
2. **Asset Bundle 机制**：将资源拆分为独立 Bundle，支持按需下载与热更新
3. **引用计数管理**：`addRef()` / `decRef()` 配对使用，引用归零后引擎自动释放
4. **自动释放策略**：场景切换时通过 `autoRelease` 和 `AutoReleaseUtils` 控制资源生命周期
5. **依赖加载**：资源间的依赖关系由引擎自动解析递归加载

### 📖 深度展开

#### 资源加载方式对比

| 加载方式 | 适用场景 | 特点 |
|---------|---------|------|
| `resources.load()` | 小型项目/快速原型 | 同步预加载，resources 目录下 |
| `assetManager.loadBundle()` | 中大型项目 | 分包加载，支持热更新 |
| `assetManager.load()` | Bundle 内资源 | 需先加载 Bundle |
| `editor` 静态引用 | UI 编辑器绑定 | 自动管理生命周期 |

#### Asset Bundle 架构

```
main-bundle (主包)
  ├── core-bundle (核心UI)
  │    ├── login-scene
  │    └── main-hall
  ├── battle-bundle (战斗模块)
  │    ├── effects
  │    └── characters
  └── audio-bundle (音频)
       ├── bgm
       └── sfx
```

**Bundle 配置要点：**

```typescript
// 配置 Bundle（在资源管理器中选中文件夹 → 配置为 Bundle）
// 代码中加载 Bundle
async function loadBattleModule() {
    const bundle = await assetManager.loadBundle('battle-bundle');
    // 加载 Bundle 内资源
    const prefab = await new Promise<Prefab>((resolve, reject) => {
        bundle.load('characters/hero', Prefab, (err, asset) => {
            if (err) reject(err);
            else resolve(asset);
        });
    });
    return prefab;
}

// 批量加载 Bundle 内资源
bundle.loadDir('effects', ParticleAsset, (err, assets) => {
    if (!err) {
        console.log(`加载了 ${assets.length} 个特效资源`);
    }
});
```

#### 引用计数与释放机制

```typescript
// ✅ 正确的资源使用模式
class HeroSprite extends Component {
    private _texture: Texture2D | null = null;

    async onLoad() {
        const bundle = assetManager.getBundle('battle');
        this._texture = await this.loadTexture(bundle, 'hero/face');
        // 资源加载后默认引用计数为 1（动态加载时）
        // addRef 用于跨组件共享
        // 不需要额外 addRef，除非其他地方也持有引用
    }

    protected onDestroy() {
        // 组件销毁时释放引用
        this._texture?.decRef();
        this._texture = null;
    }

    private loadTexture(bundle: AssetManager.Bundle, path: string): Promise<Texture2D> {
        return new Promise((resolve, reject) => {
            bundle.load(path, ImageAsset, (err, asset) => {
                if (err) reject(err);
                else {
                    const texture = new Texture2D();
                    texture.image = asset;
                    resolve(texture);
                }
            });
        });
    }
}
```

#### 场景切换时的自动释放

```typescript
// 场景配置中可设置 autoRelease
// 也可以通过代码控制
director.runScene(nextScene, {
    // 进入下一个场景前释放资源
    onPreLaunch: () => {
        // 手动释放当前模块 Bundle
        const bundle = assetManager.getBundle('battle');
        if (bundle) {
            // 释放所有属于该 Bundle 的资源
            assetManager.removeBundle(bundle);
        }
    }
});

// 通过 autoRelease 属性标记资源（在场景配置面板中设置）
// 被标记的资源在场景切换后自动释放
```

#### 资源依赖关系

引擎通过 `.meta` 文件记录资源依赖。加载一个 Prefab 时，其引用的 Texture、Material、Animation 等依赖资源会被自动递归加载。

```
hero.prefab
  ├── hero-body.png (Texture2D)
  ├── hero-face.png (Texture2D)
  ├── hero.mat (Material)
  │    └── default-shader (EffectAsset)
  └── hero.anim (AnimationClip)
```

### ⚡ 实战经验

1. **引用泄漏排查**：DevTools Memory 面板中查看各类资源数量，重点关注 Texture 和 Material 是否持续增长。常见泄漏点是 `addRef()` 后忘记 `decRef()`，或者事件回调中持有资源引用导致无法释放
2. **Bundle 划分原则**：按功能模块划分而非按资源类型划分。例如战斗相关的 UI、特效、音效放在同一个 Bundle 中，避免跨 Bundle 引用导致的重复加载
3. **预加载策略**：在 Loading 界面提前加载下一个场景所需的 Bundle，使用 `bundle.preloadDir()` 预加载但暂不实例化，进入场景时直接使用缓存中的资源
4. **远程资源释放**：使用 `assetManager.removeBundle(bundle)` 会释放 Bundle 的配置信息但不会释放已加载的资源。必须先确保引用计数归零，再 removeBundle，否则资源不会被真正释放

### 🔗 相关问题

- 如何设计一个高效的资源预加载队列？
- Asset Bundle 与微信小游戏分包的关系是什么？
- 如何检测和定位内存泄漏？
