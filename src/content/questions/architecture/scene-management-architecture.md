---
title: "如何设计一套无卡顿的场景管理与平滑切换架构？"
category: "architecture"
level: 3
tags: ["场景管理", "异步加载", "架构设计", "加载界面", "Addressables"]
related: ["architecture/asset-management-architecture", "architecture/hot-update-architecture", "architecture/game-loop-subsystem"]
hint: "场景切换的难点不在 LoadScene 这一行，而在「加载期间做什么」和「切换瞬间的衔接」。"
---

## 参考答案

### ✅ 核心要点

1. **异步加载是底线**：用 `LoadSceneAsync` / Addressables 异步加载，主线程不阻塞，加载期间继续渲染 Loading 界面
2. **叠加加载（Additive）**：把世界拆成多个子场景（UI 场景、逻辑场景、地图场景），按需叠加/卸载，做到「换地图不闪屏」
3. **状态机驱动切换流程**：切换是一个多阶段过程（淡出 → 卸载旧 → 加载新 → 初始化 → 淡入），用状态机/流程机编排，杜绝散落的回调
4. **常驻管理器场景**：UI 框架、音频、网络等用单独的常驻场景 + `DontDestroyOnLoad`，切换时不被销毁、不重复创建
5. **进度反馈与假进度**：真实加载进度非线性，要用「平滑插值 + 兜底保底推进」做视觉进度条，避免卡在 89% 的尴尬

### 📖 深度展开

**场景切换不是一步完成的，而是一条流水线：**

```
玩家点击「进入副本」
  ↓
[State] FadeOut（黑屏淡入遮罩，~0.3s）
  ↓
[State] UnloadOld（卸载当前关卡场景，释放资源引用）
  ↓
[State] LoadNew（异步加载目标场景 + 依赖资源，进度上报）
  ↓
[State] Init（调用场景内 Manager 初始化、生成玩家、注入数据）
  ↓
[State] FadeIn（遮罩淡出，~0.3s）→ 进入可玩
```

用状态机把每个阶段隔离，某一阶段失败（如加载超时）可以回退/重试，而不是回调套回调。

**叠加加载（Additive）——大世界与 UI 的核心模式：**

```csharp
// 一个游戏同时挂载多个场景
// PersistentScene：常驻，放 Manager、UI 框架、音频（DontDestroyOnLoad）
// Level_City：当前关卡，切换时整组卸载
//   ├── 可拆成 Level_City_Terrain / Level_City_NPC 等子场景

// 进入新关卡：叠加加载目标场景
yield return SceneManager.LoadSceneAsync("Level_Dungeon", LoadSceneMode.Additive);
// 卸载旧关卡
yield return SceneManager.UnloadSceneAsync("Level_City");
// 再统一激活（避免半旧半新同时存在的闪烁）
SceneManager.SetActiveScene(SceneManager.GetSceneByName("Level_Dungeon"));
```

叠加场景的关键收益：**UI 框架/网络/音频不受关卡切换影响**，玩家在大地图走动时可以做到「无缝」——只换 Level 子场景，常驻层纹丝不动。

**Addressables 场景加载——粒度更细、热更友好：**

```csharp
// 用地址加载场景，资源自动跟随分包/热更，路径与代码解耦
var handle = Addressables.LoadSceneAsync("Levels/BossRoom", LoadSceneMode.Single, activateOnLoad: false);
handle.Completed += op =>
{
    // 资源已就绪，但场景还没激活——等玩家点「确认进入」或动画播完再激活
    // 这是避免「加载完立刻卡一帧」的关键
};
// 满足条件时再激活
handle.Activate();
```

`activateOnLoad: false` + 手动 `Activate()`：把「加载完成」和「激活上屏」解耦，可以等过场动画播完、玩家就绪后再切入，消除切换瞬间的卡顿。

**加载进度条的「假进度」技巧：**

真实进度受 IO 抖动影响，经常长时间停在某个值。直接显示会让玩家觉得卡死。常见做法：

```
显示进度 = 上一帧显示进度 + (真实进度 - 显示进度) × 插值系数
当真实进度卡住时，显示进度也缓慢爬升（兜底：每秒 +1%）
当真实进度跳到 100% 时，显示进度快速追上再切场景
```

这样视觉上进度条永远在动，体验稳定。注意：**别让假进度先于真实进度到达 100%**，否则会「卡在 100% 等加载」。

**各种切换方式对比：**

| 方式 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| `LoadScene`（同步） | 启动/重启 | 简单 | 卡死主线程，体验差 |
| `LoadSceneAsync(Single)` | 关卡切换 | 不卡帧、有进度 | 切换有黑屏/淡入淡出 |
| `LoadSceneAsync(Additive)` | 无缝大世界、UI 常驻 | 可换场景不闪屏 | 多场景管理复杂、需手动卸载 |
| Addressables 场景 | 需热更/分包的项目 | 粒度细、支持远程加载 | 接入成本、需处理依赖 |

### ⚡ 实战经验

- **常驻层单独建一个场景**：UI、Audio、Network、Config 这些跨关卡的 Manager 放在 `Boot/PersistentScene` 里 `DontDestroyOnLoad`，否则每次切场景都重建一遍，事件订阅/单例重置稍有不慎就全盘错乱
- **警惕 `SetActiveScene` 时机**：叠加加载后新场景默认不是 Active，新生成的物体会落到旧场景里。加载完成后要立刻 `SetActiveScene` 指向新场景
- **资源引用必须在卸载前清干净**：旧场景里若有脚本持有新资源（如静态缓存），`UnloadSceneAsync` 后这些引用变野指针。卸载前主动清缓存，或用句柄统一管理
- **Loading 界面自己别太重**：Loading 场景反而容易卡，因为它要在加载别的场景的同时自己还在跑——预加载好 Loading 用的素材，别在 Loading 时还在动态加载 Loading 自己的图

### 🔗 相关问题

- 叠加加载多个场景时，光照和物理场景如何正确划分？
- 如何实现真正的「无缝大世界」切换（无 Loading 屏）？
- 场景切换时如何安全卸载上一关的资源而不影响常驻层？
