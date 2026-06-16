---
title: "Cocos Creator 场景切换时如何排查和避免内存泄漏？"
category: "cocos"
level: 2
tags: ["内存泄漏", "场景切换", "生命周期", "性能优化"]
related: ["cocos/scene-management", "cocos/memory-management", "cocos/script-lifecycle"]
hint: "切场景后内存不降？从引用链、回调、资源三个维度系统排查。"
---

## 参考答案

### ✅ 核心要点

1. **场景切换 ≠ 自动释放**：Cocos 的 `director.loadScene()` 会销毁旧场景节点树，但 JS 层闭包引用、全局变量、事件监听不会自动清理
2. **三大泄漏源**：闭包引用（闭包持有 Node 引用）、事件监听未移除、定时器未清除
3. **资源层泄漏**：`resources.load()` 加载的资源不会随场景销毁释放，需手动 `release()`
4. **排查工具链**：Chrome DevTools Memory Snapshot → Cocos Profiler → 自定义引用追踪
5. **预防架构**：场景模块设计 `onEnter`/`onExit` 生命周期钩子，强制清理契约

### 📖 深度展开

#### 1. 场景切换的内存生命周期

```
场景切换流程 (loadScene)

运行中场景 (SceneA)
  ↓ director.loadScene("SceneB")
  ↓
onExit回调 (SceneA 各节点 onDestroy)
  ↓ ⚠️ JS闭包/全局变量仍持有引用
  ↓ ⚠️ 事件监听器仍挂载在全局
  ↓ ⚠️ 定时器仍在运行
  ↓
旧场景节点树销毁 (Node 树从内存移除)
  ↓
新场景加载 (SceneB)
  ↓
onLoad → onEnable → start
```

**关键点**：节点树被引擎销毁，但节点上的 Component 实例如果有外部引用，JS GC 无法回收。

#### 2. 三大泄漏源详解

**泄漏源一：闭包引用**

```typescript
// ❌ 危险：闭包持有 Node 引用
class GameManager {
    private static instance: GameManager;
    private playerNode: Node;

    onLoad() {
        this.playerNode = this.node;
        // 定时器闭包 → 持有 this → 持有 playerNode
        schedule(() => {
            this.playerNode.setPosition(...);
        }, 0.1);

        // 事件回调闭包 → 同理
        systemEvent.on(KeyEventType.KEY_DOWN, (e) => {
            this.playerNode.setPosition(...); // 持有引用
        }, this);
    }
}

// ✅ 正确：onDestroy 时清理
class GameManager {
    private callbackId: number = 0;

    onLoad() {
        this.callbackId = schedule(() => { ... }, 0.1);
    }

    onDestroy() {
        this.unschedule(this.callbackId);
        systemEvent.off(KeyEventType.KEY_DOWN, this.onKeyDown, this);
    }
}
```

**泄漏源二：事件监听器**

```typescript
// ❌ 危险：全局事件未移除
onLoad() {
    // EventTarget / EventListener 是全局的，不随节点销毁
    eventTarget.on('PLAYER_DIED', this.onPlayerDied, this);
    director.on(Director.EVENT_AFTER_SCENE_LAUNCH, this.onSceneChange, this);
}

// ✅ 正确
onDestroy() {
    eventTarget.off('PLAYER_DIED', this.onPlayerDied, this);
    director.off(Director.EVENT_AFTER_SCENE_LAUNCH, this.onSceneChange, this);
}
```

**泄漏源三：动态加载资源未释放**

```typescript
// ❌ 危险：resources.load 加载的资源引用缓存到全局
resources.load('textures/boss', Texture2D, (err, tex) => {
    GlobalCache.bossTexture = tex; // 切场景后仍在内存
});

// ✅ 正确：场景销毁时释放
onDestroy() {
    if (GlobalCache.bossTexture) {
        assetManager.releaseAsset(GlobalCache.bossTexture);
        GlobalCache.bossTexture = null;
    }
}
```

#### 3. 排查工具链

**方法一：Chrome DevTools Heap Snapshot**

```
操作步骤:
1. 浏览器运行游戏 → F12 → Memory 面板
2. 场景A 运行 → 拍快照 Snapshot 1
3. 切换到场景B → 手动 GC → 拍快照 Snapshot 2
4. 对比 Snapshot 1 vs 2 (Comparison 视图)
5. 筛选 Retained Size 降序 → 找到未释放的大对象
6. 查看 Retainers 链 → 定位引用源头
```

**方法二：Cocos Profiler 内存监控**

```typescript
// 在关键位置打桩，追踪内存变化
export class MemTracker {
    private static snapshots: Map<string, number> = new Map();

    static mark(label: string) {
        // @ts-ignore
        const usage = performance.memory?.usedJSHeapSize || 0;
        const prev = this.snapshots.get(label) || 0;
        const delta = usage - prev;
        console.log(`[MEM] ${label}: ${(usage / 1024 / 1024).toFixed(2)}MB (Δ${(delta / 1024).toFixed(0)}KB)`);
        this.snapshots.set(label, usage);
    }
}

// 使用
MemTracker.mark('SceneA_BeforeLoad');
director.loadScene('SceneB', () => {
    setTimeout(() => MemTracker.mark('SceneB_AfterLoad'), 1000);
});
```

**方法三：引用链追踪**

```typescript
// 自定义 WeakRef 追踪（ES2021+）
class NodeLeakDetector {
    private static refs: Map<string, WeakRef<Node>> = new Map();

    static track(node: Node, label: string) {
        this.refs.set(label, new WeakRef(node));
    }

    static check() {
        this.refs.forEach((ref, label) => {
            const node = ref.deref();
            if (node && !node.isValid) {
                console.warn(`[LEAK] Node "${label}" destroyed but still referenced!`);
                console.warn(`  Retainers:`, node);
            }
        });
    }
}
```

#### 4. 架构级防御：场景生命周期管理器

```typescript
// 场景生命周期契约
interface ISceneModule {
    onEnter(): void;
    onExit(): Promise<void>;
}

abstract class SceneModuleBase implements ISceneModule {
    protected disposers: (() => void)[] = [];

    protected registerDisposer(fn: () => void) {
        this.disposers.push(fn);
    }

    abstract onEnter(): void;

    async onExit(): Promise<void> {
        // 自动执行所有清理函数
        this.disposers.forEach(d => { try { d(); } catch(e) { console.error(e); } });
        this.disposers.length = 0;
    }
}

// 具体模块
class BattleUIModule extends SceneModuleBase {
    onEnter() {
        const timerId = setInterval(this.updateTimer.bind(this), 1000);
        this.registerDisposer(() => clearInterval(timerId));

        eventTarget.on('UPDATE_HP', this.onHpChange, this);
        this.registerDisposer(() => eventTarget.off('UPDATE_HP', this.onHpChange, this));
    }
}
```

### ⚡ 实战经验

- **"切三次场景看内存曲线"是最快的泄漏判断法**：如果连续切场景 3 次后内存持续上升且不回落，基本可断定有泄漏。注意要等待 GC（2-3 秒后再看数值）
- **最隐蔽的泄漏是 `console.log` 持有对象引用**：DevTools 的 Console 会持有被打印对象的引用，导致 GC 无法回收。排查泄漏时先注释掉所有 console.log
- **ParticleSystem / AudioSource 停止不等于释放**：`stop()` 只是停止播放，底层 buffer 可能仍驻留。切场景时需主动调用 `destroy()` 或释放对应资源
- **用对象池替代频繁 `instantiate/destroy`**：子弹、飘字等高频创建销毁的对象用对象池管理，避免 GC 压力和内存碎片

### 🔗 相关问题

- Cocos Creator 的内存管理体系（引用计数 + GC）是怎样的？
- 如何设计高效的对象池系统？
- `assetManager.release()` 与 `destroy()` 的区别是什么？
