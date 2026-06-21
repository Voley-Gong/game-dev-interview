---
title: "ET / HybridCLR / GameFramework / NPBehavior 等主流游戏框架各自的特点和适用场景？"
category: "architecture"
level: 4
tags: ["游戏框架", "ET", "HybridCLR", "GameFramework", "热更新", "架构选型"]
related: ["architecture/ecs-architecture", "architecture/ui-framework"]
hint: "不是选最强——是选最匹配团队规模、热更新方案和双端一致性需求的那一个。"
---

## 参考答案

### ✅ 核心要点

1. **ET 框架（Egametang）**：基于 C# 的全栈 ECS + Actor 模型框架，客户端与服务端共享同一套 Entity-Component 代码，天然支持双端逻辑一致。适合中大型 MMO/SLG 项目，但学习曲线陡峭，对团队 C# 水平要求高，小团队难以驾驭其 20+ 子模块（网络、资源、配置、AI、行为树）的完整心智模型。

2. **HybridCLR（原 huatuo）**：Unity 原生 C# 热更新方案，通过 AOT + 解释器混合执行实现完整 C# 类型系统热更。无需 Lua、无需 ILRuntime 的跨语言桥接，反射、泛型、委托全部原生支持。代价是首次加载补充元数据有开销，且对 Unity 版本和 IL2CPP 版本有强耦合。

3. **GameFramework（GF）**：轻量级通用框架，核心是 16 个标准模块（Event/FSM/UI/Procedure/DataNode/Network/Resource/Sound...），引擎无关、可移植。适合中小项目快速搭脚手架，侵入性低。缺点是不提供 ECS、不提供行为树，需要自行扩展或搭配第三方库。

4. **NPBehavior / 行为树系**：基于可视化节点编辑器的 AI 行为框架（NPBehavior 的特点是全 C# 节点 + Excel/JSON 配置）。适合重度 NPC 行为的 SLG/RPG，策划可直接在编辑器里配技能连招、Boss AI。但要警惕节点图爆炸（一个 Boss 行为树 200+ 节点时维护噩梦）。

5. **xLua / ILRuntime（热更方案层）**：Lua 路线（xLua/ToLua）跨平台兼容性最好、久经考验，但有 C#/Lua 双语言心智负担和 GC bridge 性能开销；ILRuntime 走 C# 解释器路线，类型系统比 Lua 完整但不如 HybridCLR 原生。

6. **选型三要素**：热更新方案（Lua / ILRuntime / HybridCLR / 无热更）决定技术栈底座；双端一致性需求（是否 C# Server+Client 共享）决定 ET 还是 GF；团队规模与引擎绑定度决定轻量还是全家桶——没有银弹，框架侵入性越高，迁移成本越大。

### 📖 深度展开

**1. 热更新方案深度对比（HybridCLR vs xLua vs ILRuntime）**

| 维度 | HybridCLR | xLua | ILRuntime |
|------|-----------|------|-----------|
| 语言 | C#（原生） | Lua | C#（解释执行） |
| 类型系统 | 完整（反射/泛型/委托全支持） | 受限（需手写 wrap） | 较完整（部分反射受限） |
| 首次加载 | ~800ms（加载 AOT 补充元数据） | ~50ms（Lua VM 启动） | ~200ms |
| 运行性能 | 接近 AOT（解释部分慢 2-3 倍） | 慢（跨语言 bridge 开销） | 慢 5-10 倍 |
| iOS 兼容 | 需 Unity 2020.3+ / IL2CPP | 优秀 | 优秀 |
| 团队心智 | 低（纯 C#） | 高（C#+Lua 双语言） | 中（C# 但解释器 quirks 多） |

```typescript
// HybridCLR 的核心优势：热更代码里可以正常用泛型和反射，
// 而传统方案需要预生成 wrap。对比 xLua 的调用方式：
// xLua: 需要先 CS.UnityEngine.GameObject.Find("Player")
// HybridCLR: 直接 GameObject.Find("Player") —— 与非热更代码完全一致

// ET 6.0 基于 HybridCLR 的双端入口示意
interface IFramework {
  readonly version: string;
  start(): void;
}
class ETEntry implements IFramework {
  readonly version = "ET 6.0 + HybridCLR";
  start(): void {
    // 客户端与服务端共享同一份 ECS 代码
    // 通过不同的 Assembly 加载不同的 System 实现
    this.loadHotUpdateAssembly("HotUpdate.dll");
    this.registerSystems(); // 注册战斗/移动/AI 的 System
  }
  private loadHotUpdateAssembly(path: string): void { /* ... */ }
  private registerSystems(): void { /* ... */ }
}
```

**2. ET 框架架构（ECS + Actor + 网络同步）**

ET 的核心设计哲学是「Entity 是 Actor」，每个 Entity 拥有独立的消息邮箱，系统间通过消息而非直接调用解耦：

```
                    ┌──────────────────────────────────┐
                    │         ET 客户端入口              │
                    └──────────────┬───────────────────┘
                                   ▼
              ┌────────────────────────────────────────────┐
              │            Entity-Component 层              │
              │  Entity (Actor) = id + Component 列表        │
              │  ├─ UnitComponent (位置/朝向/模型)            │
              │  ├─ MoveComponent (移动逻辑)                  │
              │  ├─ CombatComponent (战斗属性)                │
              │  └─ AIComponent (行为树驱动)                  │
              └────────────────────┬───────────────────────┘
                                   ▼
              ┌────────────────────────────────────────────┐
              │            System 层（纯逻辑）              │
              │  MoveSystem / CombatSystem / AISystem       │
              │  每个 System 遍历拥有特定 Component 的 Entity │
              │  System 之间通过 EventSystem 投递消息        │
              └────────────────────┬───────────────────────┘
                                   ▼
          ┌────────────┬───────────┴───────────┬────────────┐
          ▼            ▼                       ▼            ▼
     网络同步层     资源加载层              配置表层      UI 事件层
     (Session)    (YooAsset)             (Luban)       (FairyGUI)
```

**3. GameFramework 的模块注册机制**

GF 的设计精髓是「模块即服务」，所有 16 个标准模块实现统一接口，通过 `GameFrameworkEntry` 注册和获取，引擎完全可替换：

```typescript
// GameFramework 风格的模块注册 —— 引擎无关，可替换 Cocos/Unity/自研
interface IGameFrameworkModule {
  readonly priority: number;     // 优先级决定更新顺序
  onUpdate(elapsedSeconds: number): void;
  shutdown(): void;
}
interface IGameFramework {
  getModule<T>(type: new () => T): T;
  registerModule(module: IGameFrameworkModule): void;
}
class GameFrameworkImpl implements IGameFramework {
  private modules: IGameFrameworkModule[] = [];
  getModule<T>(_type: new () => T): T { /* 按类型查找已注册模块 */ return null!; }
  registerModule(m: IGameFrameworkModule): void {
    this.modules.push(m);
    // 按 priority 排序：网络 > 事件 > 逻辑 > UI > 音效
    this.modules.sort((a, b) => a.priority - b.priority);
  }
}
// 16 个标准模块的典型优先级（越小越先执行）
// NetworkModule: 10, EventModule: 20, ProcedureModule: 30,
// DataNodeModule: 40, UIModule: 50, ResourceModule: 60,
// SoundModule: 70, SceneModule: 80
```

| 框架 | 代码规模 | 热更方案 | 双端一致 | 适用团队规模 | 典型项目 |
|------|---------|---------|---------|-------------|---------|
| ET | 大（全栈） | HybridCLR/xLua | ✅ 原生 | 20+ 人 | MMO/SLG |
| HybridCLR | 仅热更层 | 自身 | ❌（仅客户端） | 任何 Unity 项目 | 各类 Unity 手游 |
| GameFramework | 中（16 模块） | 自行集成 | ❌（仅客户端） | 5-15 人 | 中型卡牌/RPG |
| NPBehavior | 小（AI 专精） | 依赖宿主 | ❌ | 任何有 AI 需求的 | SLG/RPG Boss 战 |

### ⚡ 实战经验

- **ET 热重载 Entity id 漂移**：ET 6.0 的 Entity 在热更新重载时，组件实例的 id 映射如果序列化遗漏，会导致跨 System 消息投递到错误实体，表现为「技能打到了空气」。生产环境必须给每个 Entity 加版本号校验，重载后扫描一遍引用链。
- **HybridCLR 首次加载卡顿**：加载 AOT 补充元数据 dll 在中端安卓机上实测 ~800ms，会卡掉一帧。解决方案：在 Splash 画面期间用 splash loading 覆盖这段时间，或拆分成多个小 dll 按需加载，首包只加载核心战斗元数据。
- **xLua GC bridge spike**：iOS 上 C# → Lua 的委托调用每帧超过 2000 次时，GC bridge 会产生明显的帧时间尖峰（profiler 显示单帧 +5ms）。优化方向：把高频调用的逻辑下沉到 C# 侧，Lua 只做配置驱动。
- **GameFramework Procedure 并发陷阱**：GF 的流程（Procedure）状态机切换是同步的，在 OnLeave 里发起异步资源加载并直接切下一个 Procedure，会导致旧 Procedure 的清理和新 Procedure 的初始化交叉执行。务必等异步加载回调后再 `ChangeState`。
- **NPBehavior 节点图爆炸**：一个复杂 Boss（三阶段 + 10 种技能 + 仇恨/巡逻/逃跑）的行为树节点超过 150 个时，可视化编辑器会明显卡顿，且策划改一个条件分支容易引发连锁错误。建议拆成多个子树（战斗子树/移动子树/阶段切换子树），用黑板（Blackboard）通信。

### 🔗 相关问题

1. 如果团队只有 3 人做一款轻度热更的卡牌手游，你会推荐 ET 还是 GameFramework？为什么？
2. HybridCLR 的「完整 C# 热更新」相比 ILRuntime 牺牲了什么？什么场景下 ILRuntime 反而更合适？
3. ET 的 ECS 架构与 Unity DOTS 的 ECS 有何本质区别？能否在同一项目里混用？
