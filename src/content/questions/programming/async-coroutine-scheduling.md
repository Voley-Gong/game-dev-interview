---
title: "游戏开发中的异步编程：协程、Promise 和帧调度器该选哪个？"
category: "programming"
level: 2
tags: ["异步编程", "协程", "Promise", "任务调度", "帧循环"]
related: ["programming/observer-pattern", "programming/memory-gc-optimization"]
hint: "游戏主循环里没有真正的 await —— 一帧绝不能被阻塞，协程是分帧执行的秘密。"
---

## 参考答案

### ✅ 核心要点

1. **主循环不能被 await 阻塞**：渲染/物理都跑在 16ms 一帧的循环里，一旦 `await` 一个慢操作，整帧卡死，掉帧。异步必须转成"跨帧逐步推进"。
2. **协程（Coroutine）用生成器分帧**：`function*` 每执行到一个 `yield` 就把控制权交还主循环，下一帧再 `next()` 继续——天然适合"等 N 帧""等 0.5 秒""等动画播完"。
3. **Promise/async 适合一次性异步**：资源加载、网络请求、存档读写这种"开始→完成"的延迟任务用 Promise 清晰，但完成回调里别做重活。
4. **统一任务调度器**：不要满地 `setTimeout`，用一个调度器集中管理延迟任务、协程、定时器，方便统一暂停、倍速、按优先级排序。
5. **必须有取消机制**：技能前摇到一半角色死了，协程得能取消；Promise 原生不可取消，要包一层 `AbortSignal` 或自己实现。
6. **`setTimeout` 在游戏里不可靠**：标签页失焦会被节流到 1s，且和帧不同步；帧内调度用 `dt` 累加，比墙钟时间更准。

### 📖 深度展开

**1. 协程实现：生成器 + 调度器**

```typescript
// 协程本质：生成器函数，yield 表示"先暂停，下帧再说"
type Co = Generator<number | Promise<unknown>, void, unknown>;

class Scheduler {
  private coroutines: { co: Co; done: boolean }[] = [];
  start(gen: () => Co) { this.coroutines.push({ co: gen(), done: false }); }

  update(dt: number) {
    for (const c of this.coroutines) {
      if (c.done) continue;
      const r = c.co.next(dt);          // 推进一步
      if (r.done) c.done = true;        // 协程跑完
    }
    this.coroutines = this.coroutines.filter(c => !c.done);
  }
}

// 用法：技能前摇 0.3s → 播特效 → 等动画 → 造伤害
function* castFireball(self: Hero, target: Enemy): Co {
  yield 0.3;                            // 等前摇 0.3 秒（dt 累加）
  playEffect('fireball', self.pos);
  yield loadAsset('hit.prefab');        // yield 一个 Promise：等加载完
  yield* waitFrames(2);                 // 等 2 帧再结算，避免穿模
  target.takeDamage(120);
}
```

```
帧调度时序（一帧 = update(dt) 一次）
 ┌─────────── 帧 N ───────────┐
 │ scheduler.update(0.016)     │
 │  ├─ coroutine A.next() ─► yield 0.3  (累加 dt=0.016，未到)
 │  ├─ coroutine B.next() ─► done       (清理)
 │  └─ 渲染 / 物理 ...
 └────────────────────────────┘
   协程状态保存在生成器内部，跨帧不丢
```

**2. Promise / 协程 / setTimeout 横向对比**

| 维度 | Promise/async | 协程 (Generator) | setTimeout/setInterval |
|------|---------------|------------------|-----------------------|
| 时间单位 | 事件驱动（完成即触发） | 帧时间 dt 累加 | 墙钟毫秒（不可靠） |
| 是否阻塞帧 | ❌ 不阻塞（回调式） | ❌ 不阻塞（分帧 yield） | ❌ 不阻塞 |
| 跨帧状态保持 | 要靠闭包手动存 | ✅ 自动（生成器内部） | 难，要外部状态 |
| 可取消性 | 原生不可取消（需包装） | ✅ 直接丢掉即可 | 要 clearTimeout |
| 受标签页节流影响 | 否 | 否（跟帧走） | ✅ 是（失焦→1s） |
| 典型场景 | 资源加载、网络、存档 | 前摇、连招、剧情脚本 | ❌ 游戏内尽量少用 |

**3. 可取消的延迟任务系统**

```typescript
// 一个带句柄、能取消、能查进度的延迟任务
class Task {
  cancelled = false; elapsed = 0;
  constructor(public duration: number, public onDone: () => void) {}
  update(dt: number) {
    if (this.cancelled) return true;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) { if (!this.cancelled) this.onDone(); return true; }
    return false;
  }
  cancel() { this.cancelled = true; }   // 完成前可随时取消
}
// DOT（持续伤害）：每 0.5s 掉 10 血，持续 3s，被打断就 cancel
function poison(target: Enemy): Task {
  let ticks = 6;
  const task = new Task(3, () => {});
  const sub = setInterval(() => { if (!task.cancelled) target.hp -= 10; }, 500);
  task.onDone = () => clearInterval(sub);
  target.on('cleansed', () => task.cancel());   // 驱散立即终止
  return task;
}
```

### ⚡ 实战经验

- **`await` 串成链会吃掉整帧**：切场景时 `await loadMap(); await loadNpc(); await loadUI();` 三个串行 await 加起来卡 1.8s 黑屏。改成 `Promise.all` 并行 + 协程式分帧加载进度条，卡顿降到 200ms 且有过渡动画。
- **协程忘了取消 = 重复触发**：角色死亡后 `castFireball` 协程仍在跑，尸体还在喷火球。所有协程启动时绑到实体，实体 `destroy` 时批量取消其协程，别手动一个个管。
- **`setTimeout` 在后台标签页漂移严重**：放置类游戏用 `setTimeout` 算离线收益，切后台后被节流，回来时间差几小时。改用帧 `dt` 累加 + 服务器时间校准，杜绝时间作弊和漂移。
- **调度器要支持倍速和暂停**：战斗回放、GM 调试需要 2x/4x 加速，所有延迟任务必须走调度器的 `dt`，全局乘个倍率即可；直接用 `setTimeout` 的全得返工。
- **Promise 链里抛异常会吞掉**：`async` 函数里 `reject` 没被 `catch`，技能静默失效还查不出原因。统一加全局未处理 rejection 上报，或调度器里 `try/catch` 包住协程 `next()`。

### 🔗 相关问题

1. 如何实现一个真正可取消的 Promise？`AbortController`/`AbortSignal` 在资源加载取消中怎么用？
2. 协程用 `async/await` 写和用 `function*` 写有什么区别？为什么 Unity/C# 用 `IEnumerator` 而前端常用 generator？
3. Web Worker 适合搬哪些游戏任务（寻路、物理、JSON 解析）？主线程和 Worker 间传数据的 `Transferable` 怎么零拷贝？
