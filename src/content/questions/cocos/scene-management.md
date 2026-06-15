---
title: "Cocos Creator 场景管理与切换：场景栈、常驻节点、预加载如何设计？"
category: "cocos"
level: 2
tags: ["场景管理", "预加载", "常驻节点", "架构设计"]
related: ["cocos/asset-management", "cocos/script-lifecycle", "cocos/profiler-and-performance"]
hint: "从场景加载到资源释放，设计一套不卡顿、不泄漏的场景切换方案。"
---

## 参考答案

### ✅ 核心要点

1. **场景加载 API** → `director.loadScene()` 异步加载，`director.preloadScene()` 预加载，支持回调监听进度
2. **常驻节点（Persist）** → `director.addPersistRootNode()` 让节点在场景切换时不被销毁，用于全局 UI、音频管理器、网络层
3. **场景栈管理** → Cocos 没有内置场景栈，需自行封装（SceneStack）实现返回上一场景的功能
4. **预加载策略** → 后台预加载场景资源，切换时瞬时完成，避免加载卡顿
5. **资源释放** → 场景切换时释放旧场景资源（`assetManager.releaseAsset()`），防止内存持续增长

### 📖 深度展开

#### 场景加载 API 对比

| API | 用途 | 是否阻塞 | 使用场景 |
|-----|------|---------|---------|
| `director.loadScene(name)` | 加载并切换场景 | 异步 | 正常场景切换 |
| `director.loadScene(name, cb)` | 加载并回调 | 异步 | 切换后执行初始化 |
| `director.preloadScene(name)` | 后台预加载 | 非阻塞 | 预加载下一个场景 |
| `director.preloadScene(name, cb)` | 预加载完成回调 | 非阻塞 | 预加载完成后显示提示 |

```typescript
import { director, Scene } from 'cc';

// 基础场景切换
director.loadScene('BattleScene', (err, scene) => {
  if (err) {
    console.error('场景加载失败:', err);
    return;
  }
  console.log('BattleScene 加载完成');
  // 此时场景已激活，可执行初始化
  scene.getChildByName('GameManager').getComponent(GameManager).init();
});

// 预加载 + 延迟切换
// 在 Loading 场景中预加载
director.preloadScene('MapScene', (err) => {
  if (!err) {
    console.log('MapScene 预加载完成');
    // 可以立即切换，也可以等待玩家操作
    this.showEnterButton();
  }
});

// 玩家点击进入
onEnterMap() {
  director.loadScene('MapScene');  // 预加载过的场景会秒切
}
```

#### 常驻节点设计

```typescript
import { director, Node, Canvas, find, UITransform } from 'cc';

// 方式1：在首个场景中将节点标记为常驻
@ccclass('BootScene')
export class BootScene extends Component {
  onLoad() {
    // 将全局管理节点设为常驻（必须在场景切换前调用）
    const audioMgr = find('Canvas/AudioManager');
    director.addPersistRootNode(audioMgr);

    const netMgr = find('Canvas/NetworkManager');
    director.addPersistRootNode(netMgr);

    const uiRoot = find('Canvas/GlobalUI');
    director.addPersistRootNode(uiRoot);

    // 然后加载主场景
    director.loadScene('MainScene');
  }
}

// 取消常驻（需要时）
director.removePersistRootNode(audioMgr);
```

```typescript
// 方式2：推荐架构 —— 单例管理器 + 常驻 Canvas
// GlobalManagers.ts —— 挂在常驻节点上
@ccclass('GlobalManagers')
export class GlobalManagers extends Component {
  private static _inst: GlobalManagers;
  static get inst() { return this._inst; }

  public audio: AudioPlayer;
  public network: NetworkClient;
  public sceneMgr: SceneManager;

  onLoad() {
    if (GlobalManagers._inst) {
      this.node.destroy();
      return;
    }
    GlobalManagers._inst = this;
    director.addPersistRootNode(this.node);

    this.audio = this.addComponent(AudioPlayer);
    this.network = this.addComponent(NetworkClient);
    this.sceneMgr = this.addComponent(SceneManager);
  }
}
```

#### 自定义场景栈管理器

```typescript
import { director, director as Director } from 'cc';

@ccclass('SceneManager')
export class SceneManager extends Component {
  private sceneStack: { name: string; params?: any }[] = [];

  /** 进入新场景（压栈） */
  pushScene(sceneName: string, params?: any, onLoaded?: Function) {
    this.sceneStack.push({ name: sceneName, params });

    director.loadScene(sceneName, (err, scene) => {
      if (err) {
        this.sceneStack.pop();
        console.error('场景加载失败:', err);
        return;
      }
      // 传递参数给新场景
      const handlers = scene.getComponentsInChildren(SceneHandler);
      handlers.forEach(h => h.onSceneEnter?.(params));
      onLoaded?.(scene);
    });
  }

  /** 返回上一场景 */
  popScene(onLoaded?: Function) {
    if (this.sceneStack.length <= 1) {
      console.warn('已在根场景，无法返回');
      return;
    }
    this.sceneStack.pop();
    const prev = this.sceneStack[this.sceneStack.length - 1];
    director.loadScene(prev.name, (err, scene) => {
      if (!err) {
        const handlers = scene.getComponentsInChildren(SceneHandler);
        handlers.forEach(h => h.onSceneReturn?.(prev.params));
      }
      onLoaded?.(scene);
    });
  }

  /** 替换当前场景（不压栈） */
  replaceScene(sceneName: string, params?: any) {
    if (this.sceneStack.length > 0) {
      this.sceneStack[this.sceneStack.length - 1] = { name: sceneName, params };
    } else {
      this.sceneStack.push({ name: sceneName, params });
    }
    director.loadScene(sceneName);
  }

  /** 获取当前场景参数 */
  getParams(): any {
    return this.sceneStack[this.sceneStack.length - 1]?.params;
  }

  /** 场景栈深度 */
  get depth(): number {
    return this.sceneStack.length;
  }
}

// 使用示例
// 主城 → 战斗 → 结算 → 返回主城
sceneMgr.pushScene('BattleScene', { levelId: 5 });
// 战斗结束后
sceneMgr.popScene();  // 回到主城
```

#### 场景切换资源管理

```typescript
// 场景切换时自动释放旧资源
@ccclass('SceneResourceHandler')
export class SceneResourceHandler extends Component {
  private static loadedAssets: Set<string> = new Set();

  /** 在场景退出前调用 */
  onSceneExit() {
    // 1. 释放场景特有的纹理和音频
    SceneResourceHandler.loadedAssets.forEach((uuid) => {
      const asset = assetManager.assets.get(uuid);
      if (asset && asset.refCount <= 1) {
        assetManager.releaseAsset(asset);
      }
    });
    SceneResourceHandler.loadedAssets.clear();

    // 2. 触发 GC（延迟一帧，避免场景切换瞬间的卡顿）
    this.scheduleOnce(() => {
      sys.garbageCollect?.();
    }, 0.1);
  }

  /** 记录场景加载的资源 */
  static trackAsset(uuid: string) {
    SceneResourceHandler.loadedAssets.add(uuid);
  }
}
```

#### 加载进度条实现

```typescript
@ccclass('LoadingScene')
export class LoadingScene extends Component {
  @property(ProgressBar) progressBar: ProgressBar;
  @property(Label) tipLabel: Label;

  private targetScene: string;

  start() {
    this.targetScene = sceneMgr.getParams()?.targetScene || 'MainScene';
    this.loadTarget();
  }

  private async loadTarget() {
    // 预加载目标场景
    director.preloadScene(this.targetScene, (err) => {
      if (err) {
        this.tipLabel.string = '加载失败，正在重试...';
        this.scheduleOnce(() => this.loadTarget(), 1);
        return;
      }
      // 预加载完成，平滑切换
      this.progressBar.progress = 1.0;
      this.tipLabel.string = '加载完成';
      this.scheduleOnce(() => {
        director.loadScene(this.targetScene);
      }, 0.2);
    });

    // 模拟进度更新（preloadScene 不提供精确进度）
    let fakeProgress = 0;
    this.schedule(() => {
      fakeProgress = Math.min(fakeProgress + 0.02, 0.9);
      this.progressBar.progress = fakeProgress;
      this.tipLabel.string = `正在加载... ${Math.floor(fakeProgress * 100)}%`;
    }, 0.05);
  }
}
```

### ⚡ 实战经验

- **常驻节点要在第一次 loadScene 前注册**：`addPersistRootNode` 在场景切换过程中调用会失效，最佳实践是在 BootScene 的 `onLoad` 中统一注册所有常驻节点，然后切换到主场景。
- **preloadScene 的进度回调不准确**：引擎的 `preloadScene` 没有提供精确的加载进度回调（只有完成回调），UI 上的进度条通常需要手动模拟，等完成回调到了直接跳到 100%。
- **大场景切换要做分帧加载**：一次性加载包含大量资源的场景（如开放世界地图）会导致几秒的卡顿，应拆分为多个 Bundle 分帧加载，配合 Loading 场景展示进度。
- **场景切换时取消所有未完成的网络请求和定时器**：旧场景的 `setInterval`、WebSocket 回调、HTTP 请求在场景切换后如果还在执行，会引发空指针和内存泄漏。统一在 `onSceneExit` 中清理。

### 🔗 相关问题

- Cocos Creator 的 Asset Bundle 如何配合场景切换做按需加载？
- 如何实现无缝场景切换（角色在开放世界中不感知加载）？
- 场景切换时如何保证音频不中断？BGM 跨场景播放怎么实现？
