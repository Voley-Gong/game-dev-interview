---
title: "游戏架构中如何使用依赖注入（DI）与服务定位器解耦模块？"
category: "programming"
level: 2
tags: ["设计模式", "架构模式", "依赖注入", "IoC", "解耦"]
related: ["programming/event-bus-architecture", "programming/ecs-architecture"]
hint: "当 Audio、Network、Config 到处被 new 出来、改一处牵连全身时，如何用 IoC 反转控制？"
---

## 参考答案

### ✅ 核心要点

1. **IoC 反转控制是核心思想**：传统写法是「使用者自己 new 依赖」（正向控制），IoC 把「创建和注入依赖」的职责交给外部容器，使用者只声明「我需要什么」，控制权从模块内部反转到容器。
2. **依赖注入（DI）是 IoC 的主流实现**：通过构造函数参数、属性赋值或接口标记，把依赖对象从外部传进来。游戏引擎中 Unity 的 VContainer / Zenject、Cocos 的自定义容器都是这个模式。
3. **服务定位器（Service Locator）是轻量替代**：模块不直接接收依赖，而是向一个全局注册表 `locator.get(AudioManager)` 主动索取。更简单但隐式耦合，适合小型项目或引擎层基础设施。
4. **生命周期管理决定正确性**：单例（Singleton，全局唯一）、瞬时（Transient，每次 new）、作用域（Scoped，如每局对局一份）三种生命周期必须按场景配置，配错会导致状态串台或内存泄漏。
5. **最大价值是可测试性和可替换性**：依赖面向接口（如 `IAudioService`）注入后，单测可用 Mock 实现替换真实的音频系统，换平台时只改注册不改业务代码。

### 📖 深度展开

#### 1. 问题根源：硬编码依赖的蔓延

```typescript
// ❌ 反面教材：到处 new，改一个构造函数要改十处
class BattleSystem {
  private audio = new AudioManager();        // 硬依赖具体实现
  private network = new NetworkClient();     // 无法替换、无法 Mock
  private config = new GameConfig();         // 重复加载、内存浪费
}

// ✅ 依赖注入：声明需求，不关心来源
class BattleSystem {
  constructor(
    private audio: IAudioService,    // 面向接口
    private network: INetworkClient,
    private config: GameConfig,
  ) {}
}
```

#### 2. 极简 DI 容器实现

```typescript
type Lifecycle = 'singleton' | 'transient';
interface Binding<T> { factory: (c: Container) => T; lifecycle: Lifecycle; }

class Container {
  private bindings = new Map<string, Binding<any>>();
  private instances = new Map<string, any>(); // 单例缓存

  /** 注册：token → 工厂 + 生命周期 */
  register<T>(token: string, factory: (c: Container) => T, lifecycle: Lifecycle = 'singleton') {
    this.bindings.set(token, { factory, lifecycle });
  }

  /** 解析：递归注入依赖，按生命周期实例化 */
  resolve<T>(token: string): T {
    const binding = this.bindings.get(token);
    if (!binding) throw new Error(`未注册的依赖: ${token}`);
    if (binding.lifecycle === 'singleton' && this.instances.has(token)) {
      return this.instances.get(token); // 复用单例
    }
    const instance = binding.factory(this); // 工厂内可继续 resolve 子依赖
    if (binding.lifecycle === 'singleton') this.instances.set(token, instance);
    return instance;
  }
}

// 使用：一次注册，处处注入
const container = new Container();
container.register('IAudioService', c => new WebAudioService());
container.register('INetworkClient', c => new WebSocketClient(c.resolve('Config')));
container.register('BattleSystem', c => new BattleSystem(
  c.resolve('IAudioService'),
  c.resolve('INetworkClient'),
  c.resolve('GameConfig'),
));

const battle = container.resolve<BattleSystem>('BattleSystem');
```

#### 3. 架构层级与依赖流向

```
                   ┌─────────────────┐
                   │   Container     │  ← 注册所有绑定（组合根）
                   │  (组合根/入口)   │
                   └────────┬────────┘
        ┌──────────┬────────┼────────┬──────────┐
        ▼          ▼        ▼        ▼          ▼
   ┌─────────┐ ┌────────┐ ┌──────┐ ┌────────┐ ┌───────┐
   │ Battle  │ │  UI    │ │ Shop │ │ Social │ │ Quest │  ← 业务层
   │ System  │ │ Manager│ │System│ │ System │ │System │   (只依赖接口)
   └────┬────┘ └───┬────┘ └──┬───┘ └───┬────┘ └───┬───┘
        │ IAudio   │INet      │IData    │INet      │IData
        ▼          ▼          ▼         ▼          ▼
   ┌──────────────────────────────────────────────────┐
   │  IAudioService  INetworkClient  IDataStore  ...  │  ← 接口层
   └──────────────────────────────────────────────────┘
        ▲ 实现可替换            ▲
   ┌────┴────┐           ┌──────┴──────┐
   │WebAudio │           │WebSocket    │   ← 基础设施层（可Mock/换平台）
   │Service  │           │Client       │
   └─────────┘           └─────────────┘

依赖方向永远单向：业务 → 接口 ← 实现，无循环依赖
```

#### 4. DI vs Service Locator vs 全局单例对比

| 维度 | 全局单例 | 服务定位器 | 依赖注入 |
|------|----------|------------|----------|
| 耦合度 | 最高（硬编码全局引用） | 中（隐式索取） | 最低（显式声明） |
| 可测试性 | 差（难 Mock 全局） | 中（可替换注册项） | **好（构造函数直接传 Mock）** |
| 依赖可见性 | 隐藏 | 隐藏（运行时才报错） | **编译期/签名可见** |
| 初始化顺序 | 容易循环依赖 | 容易循环依赖 | 容器拓扑排序解决 |
| 适用规模 | 小型 Demo | 中型 / 引擎基础设施 | **中大型项目** |
| 典型代表 | `GameManager.instance` | `ServiceLocator.get()` | VContainer / Zenject |

### ⚡ 实战经验

- **警惕循环依赖**：A 依赖 B、B 又依赖 A 时容器会无限递归。解法是重构拆分（抽出公共的 C），或对其中一方用惰性初始化（`Lazy<T>`）。曾有项目音频系统依赖事件系统、事件系统又回调音频，导致启动栈溢出。
- **不要把所有东西都注入**：值对象（Vector3、Config）、纯工具函数不需要进容器。过度 DI 会让简单代码变成层层 resolve 的「XML 配置地狱」。原则：只注入有状态、有副作用、需替换的系统级服务。
- **生命周期错配是隐蔽 bug 源**：曾把「每局对战的房间状态」注册成单例，结果上一局数据泄漏到下一局。作用域（Scoped）生命周期在「进入房间时建子容器、退出时销毁」的方案下最稳妥。
- **性能敏感路径绕过 DI**：每帧执行的战斗逻辑里不要频繁 `resolve`，DI 容器的 Map 查找和工厂调用有开销。正确做法是初始化时 resolve 一次缓存引用，运行时直接用——零运行时开销。

### 🔗 相关问题

- 依赖注入与 ECS 架构中的 System 依赖管理有什么异同？
- 如何在 Cocos Creator / Unity 中实现轻量级 DI 容器而不引入重型框架？
- 服务定位器模式为什么被认为「反模式」？它在什么场景下仍是合理选择？
