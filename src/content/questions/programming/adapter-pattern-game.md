---
title: "适配器模式在跨平台游戏中如何使用？和外观模式、桥接模式有何区别？"
category: "programming"
level: 2
tags: ["设计模式", "适配器模式", "跨平台", "结构型模式", "SDK封装", "第三方库"]
related: ["programming/facade-pattern-game", "programming/factory-pattern-game", "programming/dependency-injection-game"]
hint: "目标接口和现有类对不上——不要改两边任何一方，中间塞一个适配器转接。一份游戏代码要同时跑在微信小游戏、抖音、H5、原生 App，靠的就是这层'插头转换器'。"
---

## 参考答案

### ✅ 核心要点

1. **适配器模式的本质是\"接口转换器\"**：当\"客户端期望的接口\"（Target）和\"现有类实际提供的接口\"（Adaptee）不兼容时，不修改任何一方，而是在中间加一个 Adapter 类——它实现 Target 接口，内部持有 Adaptee 实例，把 Target 的方法调用\"翻译\"成 Adaptee 的方法调用。就像出国带的电源转换插头：插座（Adaptee）和电器插头（Target）都不改，转接头（Adapter）让两者对接。
2. **跨平台/多渠道是它最典型的战场**：同一套游戏逻辑要跑在微信小游戏、抖音小游戏、Facebook Instant、原生 iOS/Android、H5 浏览器，每个平台的登录、支付、分享、广告、存储 API 完全不同。定义一套统一的 `IPlatformService` 接口（Target），每个平台写一个 `WechatAdapter`、`DouyinAdapter` 实现，上层逻辑只依赖接口，`factory` 按运行环境注入对应适配器——新增平台只加适配器，核心代码零改动。
3. **类适配器 vs 对象适配器是两种实现形态**。类适配器用\"继承\"（`Adapter extends Adaptee implements Target`），能直接复用父类方法但要求语言支持多继承且 Adaptee 是类而非 final；对象适配器用\"组合\"（`Adapter implements Target` 内部 `new Adaptee()`），更灵活、不挑语言、可适配 Adaptee 的子类。现代工程几乎只用对象适配器——\"组合优于继承\"原则下，继承带来的强耦合和单继承限制得不偿失。
4. **适配器解决\"已存在的不兼容\"，不是\"设计新系统\"**。它的前提是 Adaptee 已经存在且无法/不应修改（第三方 SDK、遗留代码、平台原生 API）。如果两个接口都是你自己在设计，应该直接统一接口而不是事后补适配器——适配器是\"亡羊补牢\"的工具，频繁出现适配器说明抽象层设计有问题（接口粒度没对齐平台差异）。
5. **双向适配器（Two-Way Adapter）能同时适配两个方向**：一个 Adapter 既实现 Target 接口又继承 Adaptee，既能被\"期望 Target 的客户端\"用，也能被\"期望 Adaptee 的客户端\"用。少见但有用——例如旧系统调用新系统、新系统也调用旧系统的双向迁移期，一个双向适配器省去两份转换代码。
6. **适配器是无状态转换，别把它当业务容器**。Adapter 只做\"接口翻译\"，不该堆积业务逻辑（缓存、校验、流程编排那是 Facade/Service 的事）。如果一个适配器里写了 500 行业务代码，说明职责越界了——应该拆成\"纯转换的 Adapter\"+\"处理业务的 Service\"，保持适配器薄而纯粹，方便测试和复用。

### 📖 深度展开

#### 1. 跨平台 SDK 适配器（对象适配器标准实现）

```typescript
// ★ Target：上层游戏逻辑依赖的统一接口（与平台无关）
interface IPlatformService {
  login(): Promise<{ uid: string; token: string }>;
  pay(productId: string, amount: number): Promise<boolean>;
  share(title: string, imageUrl: string): Promise<void>;
  getStorage(key: string): string | null;
  setStorage(key: string, value: string): void;
}

// Adaptee：微信小游戏 SDK（接口形态和 Target 完全不同）
declare const wx: {
  login(cb: (res: { code: string }) => void): void;
  requestPayment(params: { timeStamp: string; package: string; sign: string },
                 cb: (res: { errMsg: string }) => void): void;
  shareAppMessage(opts: { title: string; imageUrl: string }): void;
  getStorageSync(key: string): string;          // 同步存储
  setStorageSync(key: string, value: string): void;
};

// Adapter：把 wx 的回调式 API 适配成 Target 的 Promise 式接口
class WechatAdapter implements IPlatformService {
  login(): Promise<{ uid: string; token: string }> {
    return new Promise((resolve, reject) => {          // ★ 回调 → Promise 转换
      wx.login(res => {
        if (res.code) resolve({ uid: res.code, token: 'wx_' + res.code });
        else reject(new Error('微信登录失败'));
      });
    });
  }
  pay(productId: string, amount: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      wx.requestPayment({ timeStamp: String(Date.now()), package: productId, sign: '' },
        res => resolve(!res.errMsg.includes('fail')));
    });
  }
  share(title: string, imageUrl: string): Promise<void> {
    wx.shareAppMessage({ title, imageUrl });           // 微信分享是同步触发，直接调用
    return Promise.resolve();
  }
  getStorage(key: string) { return wx.getStorageSync(key) || null; }
  setStorage(key: string, value: string) { wx.setStorageSync(key, value); }
}

// 工厂按运行环境注入正确的适配器，上层对此完全无感
class PlatformFactory {
  static create(): IPlatformService {
    if (typeof wx !== 'undefined') return new WechatAdapter();
    if (typeof tt !== 'undefined') return new DouyinAdapter();   // 抖音
    return new WebAdapter();                                     // H5 兜底
  }
}

// 上层业务：只依赖 IPlatformService，换平台不改一行
const platform = PlatformFactory.create();
const { uid } = await platform.login();
await platform.pay('diamond_100', 6);
```

#### 2. 适配器 vs 外观模式 vs 桥接模式（极易混淆的结构型三兄弟）

```
三种模式都是\"中间加一层\"，但意图完全不同：

适配器 Adapter：让【不兼容的现有接口】能被使用           （事后补救，1对1转换）
  Client ─expects─> Target <─implements─ Adapter ─holds─> Adaptee(改不了的旧类)

外观 Facade：为【复杂的子系统集合】提供一个简化入口       （主动简化，1对多聚合）
  Client ─uses─> Facade ─delegates─> [A, B, C, D]（复杂子系统，直接用太难）

桥接 Bridge：把【抽象维度】和【实现维度】分离独立变化      （预先设计，正交解耦）
  Abstraction ─holds─> Implementor（两个维度各自继承体系，运行时组合）

记忆：适配器是\"转接头\"，外观是\"总机\"，桥接是\"插槽分离\"。
```

| 维度 | 适配器 Adapter | 外观 Facade | 桥接 Bridge |
|------|---------------|-------------|-------------|
| **意图** | 转换不兼容接口 | 简化复杂子系统访问 | 分离抽象与实现，独立扩展 |
| **触发时机** | 接口已存在且不兼容（事后） | 子系统太复杂（主动设计） | 多维度变化（预先设计） |
| **关系** | 1 Adapter : 1 Adaptee | 1 Facade : N 子系统 | 抽象层 ∞ × 实现层 ∞ |
| **改变接口** | ✅ 是（转换成 Target） | ✅ 提供新简化接口 | ❌ 不转换，只分离维度 |
| **游戏场景** | 多平台 SDK 适配 | 引擎子系统统一入口 | 渲染 API × 平台 矩阵 |

#### 3. 第三方广告/统计 SDK 多家接入的适配器矩阵

```typescript
// 游戏常需接入多家广告 SDK（穿山甲/优量汇/Sigmob）做 mediation 聚合
// 每家回调风格、奖励规则、初始化流程都不同，用适配器统一成 IAdNetwork

interface IAdNetwork {
  init(appId: string): Promise<void>;
  showRewardVideo(): Promise<{ rewarded: boolean; amount: number }>;
}

// 穿山甲适配器：把它的\"异步回调+错误码\"适配成统一 Promise
class PangleAdapter implements IAdNetwork {
  private sdk: any;
  async init(appId: string) { this.sdk = await loadSDK('pangle', appId); }
  showRewardVideo(): Promise<{ rewarded: boolean; amount: number }> {
    return new Promise(resolve => {
      this.sdk.showRewardVideoAd({
        // 穿山甲的回调：onReward 验证通过、onError 失败、onClose 关闭
        onReward: () => resolve({ rewarded: true, amount: 50 }),
        onError: () => resolve({ rewarded: false, amount: 0 }),
        onClose: () => resolve({ rewarded: false, amount: 0 }),
      });
    });
  }
}

// 聚合层：根据 eCPM（千次展示收益）动态选哪家适配器，上层只调 showRewardVideo
class AdMediation {
  constructor(private networks: IAdNetwork[]) {}
  async showRewardVideo() {
    const best = this.pickHighestECPM();    // 策略选择，细节省略
    return best.showRewardVideo();          // ★ 无论哪家，接口一致
  }
}
```

### ⚡ 实战经验

- **适配器里偷偷写业务逻辑是最常见的架构腐化**：支付适配器里加了\"首充双倍\"\"VIP 折扣\"逻辑，结果换平台时这些规则要在每个适配器里重写一遍，Bug 频发。铁律：适配器只做协议转换（回调转 Promise、字段名映射），业务规则放独立的 `PaymentService`——适配器越薄，跨平台越省心。
- **微信/抖音回调式 API 转 Promise 漏掉错误分支**：`wx.login` 除了 `success` 还有 `fail`，早期只 wrap 了 success，网络失败时 Promise 永远 pending，登录界面卡死。适配回调式 API 必须同时处理 success/fail/complete 三个回调，fail 时 `reject`，否则会制造\"永不 resolve 也永不 reject\"的泄漏 Promise。
- **平台差异不只是 API 名字，还有行为差异**：微信 `shareAppMessage` 必须由用户点击触发（平台限制），不能在 `Promise.then` 里自动调；抖音的 `tt.login` 在某些版本返回的 uid 是临时码不是唯一 ID。适配器除了转接口，还要抹平这些\"行为约束\"——文档化每个平台的坑，否则上线后踩雷排查极痛苦。
- **过多适配器暗示抽象接口设计粒度错误**：项目里每接一个新平台适配器都要写 800 行，因为 `IPlatformService` 暴露了 40 个方法，每个平台实现成本爆炸。重构方向：拆成多个细粒度接口（`ILogin`、`IPay`、`IShare`、`IStorage`，接口隔离原则），平台按需实现，小型平台可以只支持核心几项，而不是被迫填满 40 个方法。
- **类适配器在 TS/Java 单继承下基本不可用**：想用 `class WechatAdapter extends WxSDK implements IPlatformService`，但 `WxSDK` 是第三方全局对象不是可继承的类，且 TS 类适配器会强耦合到具体实现无法 mock 测试。坚持用对象适配器（组合），依赖注入时注入 mock 的 Adaptee，单元测试才能脱离真实平台 SDK 跑。

### 🔗 相关问题

1. 当适配器需要适配的不只是接口、还有\"调用时序\"（如 Adaptee 要求先 init 再 login 再 pay，顺序固定）时，适配器如何封装这种协议级差异？
2. 适配器模式和扩展原生对象的\"猴子补丁\"（monkey patch）相比，各自的优缺点？为什么大型项目严禁 monkey patch 而推崇适配器？
3. 微服务架构中的 BFF（Backend for Frontend）层、gRPC-Gateway，本质是不是一种适配器模式？它们解决了什么\"接口不兼容\"问题？
