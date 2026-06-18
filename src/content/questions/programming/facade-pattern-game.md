---
title: "外观模式如何简化游戏复杂子系统的调用？"
category: "programming"
level: 1
tags: ["设计模式", "外观模式", "子系统封装", "迪米特法则", "结构型模式"]
related: ["programming/mediator-pattern-game", "programming/singleton-service-locator", "programming/adapter-pattern-game"]
hint: "不是中介者协调多对象交互——是给一堆复杂子系统套一个统一入口，调用方只认一个 API，本质是减少耦合面。"
---

## 参考答案

### ✅ 核心要点

1. **为复杂子系统提供一个统一的高层接口**：外观(Facade)是一个包装类，把多个子系统类的协作编排成一个简洁入口。调用方只依赖 Facade，不再各自 `new` 一堆子系统对象、记一堆调用顺序。本质是"减少依赖面"，让上层代码不必了解子系统内部结构。
2. **外观是"简化访问"不是"加业务逻辑"**：Facade 内部只把请求转发、按正确顺序调子系统，本身不含领域决策——它编排调用但不做业务判断。这是它与中介者(Mediator)的核心区别：中介者内部有协调/仲裁逻辑，外观只是薄薄的转发层，复杂度远低于中介者。
3. **不阻塞对子系统的直接访问**：外观是"附加"的便捷层，子系统类依然可以单独使用。需要精细控制时（如要调用 Facade 没暴露的底层 API）可以直接穿透 Facade 调底层，Facade 只服务大多数常见场景，不强制独占入口。
4. **游戏典型场景极其密集**：`ResourceManager`（统一 bundle 加载+LRU 缓存+解码+引用计数）、`AudioSystem`（播放/停止/混音/3D 音效一个 API）、`SaveSystem`（序列化+版本迁移+校验+落盘）、`SDKFacade`（登入/支付/分享/广告统一封装多平台差异）、`InputManager`（键盘/手柄/触屏归一化）。
5. **外观可以分层，避免沦为上帝对象**：系统级 Facade（引擎层 `AudioEngine`）→ 业务级 Facade（`BattleAudioFacade` 专管战斗音效）→ 场景级 Facade（`BossSceneAudio`）。按领域拆分成多个 Facade，单一 Facade 只暴露一个领域的入口，否则会退化成什么都往里塞的上帝类。
6. **常与单例/服务定位器/适配器配合**：Facade 通常作为单例或注册到服务定位器，提供全局访问；面对多平台 SDK 时，Facade 内部组合一组适配器(Adapter)，对外屏蔽平台差异。但 Facade 是结构型模式（封装结构），适配器是接口转换，两者职责不同、常一起用。

### 📖 深度展开

**1. ResourceManager Facade：封装 4 个子系统**

```typescript
// 4 个底层子系统，调用方原本要分别打交道
class AssetBundleLoader { async loadBundle(name: string): Promise<Bundle> { /* ... */ } }
class LruTextureCache { get(id: string): Texture | null { /* ... */ } put(t: Texture): void { /* ... */ } }
class TextureDecoder { decode(bytes: Uint8Array): Texture { /* ... */ } }
class RefCounter { retain(id: string): void { /* ... */ } release(id: string): void { /* ... */ } }

// Facade：对外只暴露一个 loadTexture，内部编排 4 个子系统
class ResourceManager {
  private loader = new AssetBundleLoader();
  private cache = new LruTextureCache(512);   // 最多缓存 512 张
  private decoder = new TextureDecoder();
  private refs = new RefCounter();

  async loadTexture(texId: string): Promise<Texture> {
    // 1. 缓存命中直接返回
    const cached = this.cache.get(texId);
    if (cached) { this.refs.retain(texId); return cached; }
    // 2. 未命中：加载 bundle → 解码 → 入缓存 → 计数
    const bundle = await this.loader.loadBundle(`tex/${texId}`);
    const bytes = bundle.getBytes(texId);
    const tex = this.decoder.decode(bytes);   // 编排：顺序由 Facade 锁定
    this.cache.put(tex);
    this.refs.retain(texId);
    return tex;
  }
  release(texId: string): void { this.refs.release(texId); } // 调用方只管 release
}
// 业务代码：const tex = await rm.loadTexture("hero_01"); // 一行搞定
```

```
调用方（业务层）
     │  只依赖 ResourceManager
     ▼
┌─────────────────────────────────────────┐
│            ResourceManager (Facade)      │
│  loadTexture() / release() / preload()  │
└────┬──────────┬──────────┬─────────┬────┘
     │          │          │         │  Facade 内部编排（调用方不可见）
     ▼          ▼          ▼         ▼
 AssetBundle  LruCache   Decoder   RefCounter
   Loader                (子系统)
```

**2. 外观 vs 中介者 vs 适配器 vs 直接访问**

| 维度 | 外观 Facade | 中介者 Mediator | 适配器 Adapter | 直接访问 |
|------|-------------|-----------------|----------------|----------|
| 核心目的 | 简化子系统访问入口 | 解耦多对象互相通信 | 转换不兼容接口 | —— |
| 方向 | 单向：外→内 | 多向：N-N 通信 | 单向：接口转换 | —— |
| 内部逻辑 | 薄转发+顺序编排 | 厚：仲裁/事务/协调 | 协议/数据格式转换 | —— |
| 子系统是否感知 | 不感知 Facade | 子系统持有中介者引用 | 被适配者不感知 | —— |
| 游戏场景 | ResourceManager/UI 总入口 | 背包-装备-属性联动 | 多平台 SDK 包装 | 一次性脚本 |
| 复杂度 | 低 | 高（易成上帝对象） | 低 | 视场景而定 |
| 是否阻塞底层 | 不阻塞，可穿透 | 通常强制走中介者 | 不阻塞 | —— |

**3. 多平台 SDK Facade：对外屏蔽差异**

```typescript
// 3 个平台适配器（Adapter），各自实现同一接口
interface IPlatformSDK {
  login(): Promise<string>;
  pay(orderId: string, amount: number): Promise<boolean>;
  share(title: string, img: string): Promise<void>;
}
class WechatSDK implements IPlatformSDK { /* wx.login / wx.requestPayment ... */ }
class DouyinSDK implements IPlatformSDK { /* tt.login / tt.pay ... */ }
class IosSDK implements IPlatformSDK { /* WKWebView bridge ... */ }

// Facade：对外统一 SDKFacade，内部按平台分发到对应适配器
class SDKFacade {
  private sdk: IPlatformSDK;
  constructor() {
    this.sdk = platform === 'wechat' ? new WechatSDK()
             : platform === 'douyin' ? new DouyinSDK() : new IosSDK();
  }
  async login(): Promise<string> {
    try {
      const uid = await this.sdk.login();
      Analytics.track('login_ok', { uid });   // Facade 可加横切逻辑（埋点）
      return uid;
    } catch (e) { Analytics.track('login_fail'); throw e; }
  }
  async pay(orderId: string, amount: number): Promise<boolean> {
    return this.sdk.pay(orderId, amount);     // 调用方完全不知道当前是哪个平台
  }
}
```

| 平台 | 登入 API | 支付 API | Facade 统一方法 |
|------|----------|----------|-----------------|
| 微信 | `wx.login` | `wx.requestPayment` | `sdkFacade.login()` |
| 抖音 | `tt.login` | `tt.pay` | `sdkFacade.pay()` |
| iOS | WKWebView bridge | StoreKit bridge | 同上 |
| Web | 账号密码 | Stripe | 同上 |

### ⚡ 实战经验

- **Facade 膨胀成上帝对象是头号反模式**：项目早期 `GameFacade` 塞了资源、音频、存档、网络、UI 共 87 个方法，任何改动都要 review 全文件，编译一次 12 秒。按领域拆成 `ResourceManager`/`AudioSystem`/`SaveSystem`/`NetManager` 四个 Facade 后，每个降到 15 个方法以内，改动隔离、编译降到 4 秒。规则：一个 Facade 超过 20 个方法就该拆。
- **别在 Facade 里塞业务判断**：曾把"VIP 用户免广告"逻辑写进 `AdFacade.show()`，结果后端调 VIP 接口的代码也直接 `new AdSDK()` 绕过了 Facade，导致 VIP 用户照样看到广告。业务规则必须放业务层或中介者，Facade 只做"转发+顺序"，保持纯粹才不会被绕过。
- **Facade 要做空实现降级**：移动端低端机不支持 3D 混音，`AudioSystem.play3D()` 在 Facade 层检测能力后降级为 2D 播放，业务代码无需感知。一个赛季前 audio 模块在某低端机崩溃率 0.3%，加 Facade 降级后归零——Facade 是做能力降级的天然位置。
- **热更新后 Facade 接口别破坏性变更**：`ResourceManager.loadTexture()` 改成返回 `Observable` 后，全项目 240 处调用全部编译失败。Facade 是公共契约，变更要向后兼容（保留旧签名 + 新增重载），或用版本号 `ResourceManagerV2` 并行迁移，绝不能直接改签名。
- **Facade 配合服务定位器方便测试**：把 `ResourceManager` 注册到 `ServiceLocator`，单元测试时注入一个返回假数据的 `MockResourceManager`，业务代码完全不感知。原来测试要 mock 4 个子系统、写 30 行 setup，现在 mock 1 个 Facade、3 行搞定，测试编写成本下降 80%。

### 🔗 相关问题

1. 外观模式和中介者模式都"封装了复杂性"，一个 UI 系统（背包、装备、属性面板互相联动）应该用哪个？判断标准是什么？
2. 当子系统升级（如资源系统从 Bundle 切到 Addressables）时，Facade 的接口如何保持稳定不波及调用方？版本化迁移策略有哪些？
3. Facade 作为全局入口常常被做成单例，这会和"可测试性"冲突吗？如何用服务定位器或依赖注入缓解？
