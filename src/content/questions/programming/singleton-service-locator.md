---
title: "游戏中的单例模式和服务定位器如何设计？全局管理器生命周期怎么管理？"
category: "programming"
level: 2
tags: ["设计模式", "单例模式", "服务定位器", "架构模式", "全局状态"]
related: ["programming/dependency-injection-game", "programming/event-bus-architecture", "programming/state-pattern-game"]
hint: "GameManager、AudioManager、UIManager 人人都要访问——单例最简单但耦合最深，服务定位器和依赖注入是它的进化形态。"
---

## 参考答案

### ✅ 核心要点

1. **单例模式保证一个类全局只有一个实例并提供统一访问点**：游戏中的全局管理器（GameManager、AudioManager、UIManager、ConfigManager）需要被场景中无数对象访问，单例用 `Instance.getInstance()` 提供全局访问，省去逐层传引用的繁琐。它的核心价值是"简化全局状态访问"，但代价是引入全局耦合——这是它饱受争议的根源。
2. **单例的三大经典坑必须知道**：① 全局可变状态导致测试困难（单元测试间状态泄漏，无法隔离）；② 隐式依赖关系（类 A 偷偷用 `AudioManager.instance`，依赖关系不在构造函数签名里，重构时极易破坏）；③ 生命周期失控（单例持有大资源不释放，场景切换后内存不降；或被多次重复初始化）。面试中能讲清这三坑，比会写单例代码重要得多。
3. **懒加载 vs 饿汉式要根据启动成本权衡**：饿汉式（类加载即创建）启动时一次性初始化所有管理器，增加冷启动时间但运行时无卡顿；懒加载（首次访问时创建）启动快但首次访问有延迟（如首次播放音效时初始化音频引擎可能卡 50ms）。游戏通常对启动延迟敏感，重要管理器用饿汉式，次要的（如成就系统）用懒加载。
4. **服务定位器是单例的温和进化版**：用一个中央 `ServiceLocator` 注册所有服务（`locator.provide('audio', audioManager)`），使用方通过 `locator.locate('audio')` 获取。相比裸单例，它把"哪些是全局服务"集中管理、支持替换（测试时注入 mock）、支持按需初始化，但仍保留了"全局访问"的便利。是"想要单例的方便又想降低耦合"的折中。
5. **依赖注入是彻底解耦的正解但成本更高**：把管理器作为参数显式传入需要它的对象（构造函数注入），依赖关系完全透明、可测试性最佳。但游戏对象数量巨大（数千实体），逐个注入样板代码繁琐，通常配合 DI 容器（如 TS 装饰器 + 容器）减少手写。中大型项目推荐 DI，小型项目用服务定位器足够。
6. **场景切换和热重载要求单例支持重置**：单例持有场景级数据时（如当前关卡状态），切换场景必须能 `reset()` 清理回初始状态，否则上一关的残留数据污染下一关。热更新场景下单例还可能需要支持销毁重建（旧实例释放 → 新代码创建新实例），纯静态 `instance` 字段的单例做不到这点，需要可变的注册机制。

### 📖 深度展开

#### 1. 三种全局访问模式的实现演进

```typescript
// === 方案A：裸单例（最简单，耦合最深）===
class AudioManager {
  private static _inst: AudioManager | null = null;
  static get instance(): AudioManager {
    if (!this._inst) this._inst = new AudioManager();   // 懒加载
    return this._inst;
  }
  private constructor() { /* 初始化音频引擎 */ }
  play(id: string): void { /* ... */ }
}
// 调用方：AudioManager.instance.play('bgm')  ← 隐式依赖，测试时无法替换

// === 方案B：服务定位器（集中注册，可替换）===
class ServiceLocator {
  private static services = new Map<string, unknown>();
  static provide<T>(key: string, service: T): void { this.services.set(key, service); }
  static locate<T>(key: string): T { return this.services.get(key) as T; }
  static reset(): void { this.services.clear(); }   // 测试隔离 / 场景重置
}
// 启动时注册：ServiceLocator.provide('audio', new AudioManager());
// 调用方：ServiceLocator.locate<AudioManager>('audio').play('bgm')
// 测试时：ServiceLocator.provide('audio', mockAudio);  ← 可替换 ✅

// === 方案C：构造函数注入（依赖完全透明）===
class Enemy {
  constructor(private audio: AudioManager, private config: ConfigManager) {}  // 依赖写在签名里
  onDeath(): void { this.audio.play('death'); const drop = this.config.get('enemyDrop'); }
}
// 谁创建 Enemy 谁负责传入依赖 —— 可测试性最佳，但样板代码多
```

#### 2. 全局访问模式对比

```
依赖关系可见性：

裸单例:     Enemy --(隐藏)--> AudioManager.instance   依赖不透明 ❌
服务定位器: Enemy --> ServiceLocator --> AudioManager   半透明（靠 key 字符串）
依赖注入:   Enemy(audio, config)                       完全透明 ✅

测试可替换性：
单例:        无法替换（除非改静态字段，污染全局）  ❌
服务定位器:  provide() 注入 mock，但仍是全局状态     ⚠️
依赖注入:    new Enemy(mockAudio, mockConfig)         ✅ 完美隔离
```

| 维度 | 裸单例 | 服务定位器 | 依赖注入 |
|------|--------|----------|---------|
| 访问便利性 | ✅ 最简 | ✅ 简 | ⚠️ 需传参/容器 |
| 依赖透明度 | ❌ 隐藏 | ⚠️ 半透明 | ✅ 完全透明 |
| 可测试性 | ❌ 难隔离 | ⚠️ 可替换但全局 | ✅ 完美隔离 |
| 生命周期控制 | ⚠️ 难重置 | ✅ 可 reset | ✅ 容器管理 |
| 样板代码量 | ✅ 零 | ✅ 少 | ❌ 多（需容器辅助） |
| 适用规模 | 小型 demo | 中型项目 | **中大型项目** |

#### 3. 实战陷阱：单例导致的内存泄漏与场景污染

```typescript
// ❌ 反面：单例持有场景数据，切换场景不清理 → 内存泄漏 + 数据污染
class GameManager {
  static instance = new GameManager();
  currentEnemies: Enemy[] = [];     // 持有当前关卡敌人（大对象）
  playerScore = 0;
}
// 退出关卡时如果只销毁场景节点，currentEnemies 仍被单例强引用 → GC 不回收
// 进下一关时 currentEnemies 里还混着上一关的敌人

// ✅ 正解：单例区分"持久数据"和"场景数据"，提供 resetScene()
class GameManager {
  static instance = new GameManager();
  // 持久数据（跨场景保留）
  totalScore = 0;
  unlockedLevels: Set<number> = new Set();
  // 场景数据（切换时必须清理）
  private sceneData: { enemies: Enemy[]; pickups: Item[] } | null = null;

  enterScene(): void {
    this.sceneData = { enemies: [], pickups: [] };   // 干净的新场景数据
  }
  // ⚠️ 关键：退出场景时清理场景数据，断开所有引用让 GC 回收
  exitScene(): void {
    this.totalScore += this.computeSceneScore();     // 持久数据先结算
    this.sceneData = null;                            // 场景数据置 null，释放引用
  }
}
```

### ⚡ 实战经验

- **单例泄漏是最隐蔽的内存问题**：某 RPG 的 `QuestManager`（单例）持有当前任务的 NPC 引用链，玩家进出城镇 20 次后内存从 200MB 涨到 600MB。原因是单例的 `activeQuestNpcs` 数组切换场景时只 `length = 0` 清空了数组，但数组元素（NPC 对象）还被其他单例（`DialogueManager`）引用，链式泄漏。解法是所有场景级单例统一在场景退出时调用 `reset()` 并互相协调清理顺序。
- **单例初始化顺序导致启动崩溃**：`UIManager`（单例）构造时依赖 `ConfigManager`（单例）的数据，如果 `UIManager` 先初始化就会拿到空配置崩溃。饿汉式单例的初始化顺序由静态字段声明顺序决定，极易出错。解法是显式 `init()` 方法 + 手动控制启动顺序（`config.init() → audio.init() → ui.init()`），而非依赖隐式的构造顺序。
- **服务定位器的 key 用字符串容易拼错**：`locate('auido')` 拼错运行时才报 `undefined`。改用 `Symbol` 或常量枚举做 key，配合泛型 `locate<AudioManager>(ServiceKey.Audio)` 让 IDE 检查类型，把运行时错误提前到编译期。
- **多场景并存时单例会冲突**：分屏双人游戏两个玩家各看一个场景，但 `AudioManager` 单例只有一个，两个场景的 BGM 互相覆盖。这种场景下"全局单例"的前提（整个游戏一个实例）就不成立，必须改为每场景一份的实例 + 显式传引用，单例模式在此是反模式。
- **依赖注入在 ECS 架构下更自然**：ECS 中 System 是无状态的全局单例（天然适合单例/静态），Component 是纯数据被 System 批量处理（无需注入）。把单例用在 System 上、把依赖注入用在需要配置的 Component 工厂上，是现代游戏架构的常见分工，避免了"到处单例"的泥潭。

### 🔗 相关问题

1. 为什么 GoF 把单例列为反模式？在函数式编程和 ECS 架构中，如何避免全局可变状态？
2. TypeScript 的 `enum`、`const` 对象、`Symbol` 分别如何用作服务定位器的 key？各自的类型安全和序列化能力有何差异？
3. 当游戏需要支持热重载（编辑器模式下修改脚本不重启）时，单例的静态 `instance` 字段如何安全地销毁重建？模块缓存（`import` 缓存）会带来什么问题？
