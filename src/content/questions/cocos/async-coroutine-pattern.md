---
title: "Cocos Creator 中的异步编程模式：Promise、协程与帧调度如何选择？"
category: "cocos"
level: 2
tags: ["异步编程", "协程", "架构设计", "TypeScript"]
related: ["cocos/script-lifecycle", "cocos/scene-management", "cocos/dynamic-loading"]
hint: "resource.load 回调地狱怎么破？帧同步逻辑怎么优雅写？"
---

## 参考答案

### ✅ 核心要点

1. **异步加载回调**：`resource.load` / `assetManager.loadBundle` 返回的是回调或 Promise
2. **帧调度**：`director.schedule` / `setInterval` / `requestAnimationFrame` 的区别
3. **协程模式**：TypeScript 中用 `async/await` + 生成器模拟 Unity 式协程
4. **错误传播**：异步链中 `try/catch` 的陷阱与 `Promise.all` 的短路行为
5. **取消机制**：通过 `AbortController` 或自定义 Token 取消异步任务

### 📖 深度展开

#### 异步加载的三种写法对比

```typescript
// ❌ 回调地狱（不推荐）
resource.load("prefabs/enemy", Prefab, (err, prefab) => {
  if (err) return;
  this.node.addChild(instantiate(prefab));
  resource.load("prefabs/weapon", Prefab, (err2, weaponPrefab) => {
    if (err2) return;
    // 嵌套越来越深...
  });
});

// ✅ Promise 链（可用）
const loadAsync = (path: string, type: typeof Asset) =>
  new Promise<any>((resolve, reject) => {
    resource.load(path, type, (err, asset) => {
      err ? reject(err) : resolve(asset);
    });
  });

loadAsync("prefabs/enemy", Prefab)
  .then(prefab => {
    this.node.addChild(instantiate(prefab));
    return loadAsync("prefabs/weapon", Prefab);
  })
  .then(weaponPrefab => { /* 装配武器 */ })
  .catch(err => console.error("加载失败", err));

// ✅✅ async/await（最佳实践）
async function loadEnemyWithWeapon() {
  try {
    const enemyPrefab = await loadAsync("prefabs/enemy", Prefab);
    const enemy = instantiate(enemyPrefab);
    this.node.addChild(enemy);

    const weaponPrefab = await loadAsync("prefabs/weapon", Prefab);
    enemy.getComponent(EnemyCtrl).equipWeapon(weaponPrefab);
  } catch (err) {
    console.error("加载失败", err);
  }
}
```

#### 协程式分帧执行（伪协程）

```typescript
/** 分帧加载大量实体，避免单帧卡顿 */
async function loadEnemiesFrameByFrame(paths: string[], perFrame: number = 5) {
  for (let i = 0; i < paths.length; i += perFrame) {
    const batch = paths.slice(i, i + perFrame);
    await Promise.all(batch.map(p => loadAsync(p, Prefab)));
    await nextFrame(); // 等待一帧
  }
}

/** 等待一帧的工具函数 */
function nextFrame(): Promise<void> {
  return new Promise(resolve => director.once(Director.EVENT_AFTER_UPDATE, resolve));
}

/** 等待条件满足 */
async function waitForCondition(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("等待超时");
    await nextFrame();
  }
}
```

#### 四种异步调度机制对比

| 机制 | API | 执行时机 | 可取消 | 适用场景 |
|------|-----|---------|--------|---------|
| Component.schedule | `this.schedule(cb, 0)` | 每帧 update 后 | ✅ unschedule | 游戏逻辑帧调度 |
| setTimeout | `setTimeout(cb, ms)` | 毫秒后（不准确） | ✅ clearTimeout | UI 延迟显示等 |
| setInterval | `setInterval(cb, ms)` | 固定间隔重复 | ✅ clearInterval | 倒计时（精度要求低） |
| requestAnimationFrame | `requestAnimationFrame(cb)` | 浏览器绘制前 | ✅ cancelAnimationFrame | 渲染同步动画 |

#### 带取消令牌的异步任务

```typescript
class CancellationToken {
  private _cancelled = false;
  get cancelled() { return this._cancelled; }
  cancel() { this._cancelled = true; }
}

async function loadSceneWithToken(token: CancellationToken) {
  const tasks = [loadAsync("a", Prefab), loadAsync("b", Prefab)];
  const results = await Promise.all(tasks);

  // 检查取消状态
  if (token.cancelled) return; // 提前退出

  results.forEach(prefab => this.node.addChild(instantiate(prefab)));
}

// 使用：玩家切场景时取消正在进行的加载
const token = new CancellationToken();
loadSceneWithToken(token);
// 玩家突然返回主界面
token.cancel();
```

### ⚡ 实战经验

1. **`Promise.all` 有短路行为**：一个 reject 就全部终止，但其他 Promise 实际仍在执行——如果需要"全部完成不管成败"，使用 `Promise.allSettled`
2. **`setTimeout` 在小游戏平台不可靠**：微信小游戏后台时 `setTimeout` 会被暂停，恢复后可能堆积触发，关键逻辑请用 `director.schedule`
3. **异步加载取消不能真正中断网络请求**：Cocos 的资源加载一旦发起无法中途取消，"取消"只是忽略结果，大量加载请求仍会占用带宽
4. **批量加载务必做进度回调**：`assetManager.loadBundle` + `loadAny` 配合 `onFileProgress` 可以实现精确的加载进度条

### 🔗 相关问题

- 如何实现一个通用的资源加载管理器（ResourceManager）？
- Cocos 的 `director.schedule` 和原生 `setInterval` 在帧同步场景下有何差异？
- 多个异步任务有依赖关系时，如何优雅编排执行顺序？
