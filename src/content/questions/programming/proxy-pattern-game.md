---
title: "代理模式（Proxy）在游戏中如何应用？和适配器、装饰器、外观有什么区别？"
category: "programming"
level: 2
tags: ["设计模式", "代理模式", "资源加载", "懒加载", "访问控制", "引用计数"]
related: ["programming/adapter-pattern-game", "programming/facade-pattern-game", "programming/asset-management-async"]
hint: "不是简单包装——是控制访问：懒加载、权限校验、远程调用、引用计数都靠代理拦截"
---

## 参考答案

### ✅ 核心要点

1. **代理模式的本质是"访问控制"**：为一个真实对象（RealSubject）提供一个代理（Proxy），客户端不直接接触真实对象，而是通过代理间接访问。代理持有真实对象的引用，可以在访问前后插入额外逻辑——这是它与装饰器"加行为"、适配器"转接口"的根本区别。
2. **虚拟代理（Virtual Proxy）做延迟创建**：对开销大的资源（高清纹理、模型、AudioClip、预制体）先用一个轻量代理占位，直到真正被使用时才触发加载。游戏首屏 200+ 资源如果全预加载会卡 3-5 秒，用代理把它们摊到首帧渲染后逐步加载。
3. **远程代理（Remote Proxy）屏蔽网络细节**：客户端调用本地代理对象，代理内部做参数序列化、网络发送、结果反序列化。玩家调用 `shopService.buy(itemId)` 像调本地方法，实际跨网络到战斗服——代理让 RPC 和本地调用语法一致。
4. **保护代理（Protection Proxy）做权限校验**：在访问真实方法前先检查调用者权限。GM 命令、付费内容、敏感操作（删角色、改昵称）先过代理的 `checkPermission()`，没权限直接拒绝，真实对象永远不暴露给非法调用方。
5. **智能引用代理（Smart Reference）做引用计数**：代理在每次 `acquire` 时计数 +1、`release` 时 -1，归零时自动卸载真实资源。纹理、音效被多处共享时，裸引用极易泄漏或提前释放，智能引用代理把这套手工簿记自动化。
6. **四种"包装类"意图不同，别混用**：代理控制访问（保持接口不变）、适配器转换接口（A→B）、装饰器叠加行为（动态增强）、外观简化子系统（提供新门面）。面试官最爱追问这四个的边界，混淆是常见扣分点。

### 📖 深度展开

**1. 虚拟代理：大资源懒加载（最常用的场景）**

```typescript
// 真实主题：实际持有纹理数据，构造即解码（开销大）
class RealTexture {
  constructor(public readonly name: string) {
    // 模拟解码：4K 纹理解码约 8-15ms
    console.log(`[decode] ${name} cost 12ms`);
  }
  draw(x: number, y: number): void {
    console.log(`draw ${this.name} at (${x},${y})`);
  }
  dispose(): void { console.log(`free ${this.name}`); }
}

// 虚拟代理：构造时代价为零，首次 draw 才真正加载
class LazyTextureProxy {
  private real: RealTexture | null = null;
  constructor(private readonly name: string) {}  // 仅记录名字，不解码

  draw(x: number, y: number): void {
    if (!this.real) this.real = new RealTexture(this.name);  // 懒加载触发点
    this.real.draw(x, y);
  }
  dispose(): void { this.real?.dispose(); this.real = null; }
}

// 场景初始化：100 个图标瞬间创建代理，0ms 解码开销
const icons = iconNames.map(n => new LazyTextureProxy(n));
// 首帧只渲染视口内 8 个图标 → 只解码 8 张，其余等滚动到才解码
visibleIcons.forEach(t => t.draw(0, 0));
```

**2. 智能引用代理：自动引用计数，防泄漏/防提前释放**

```typescript
// 共享资源的智能引用代理：多次 acquire/release 自动管理生命周期
class SharedAssetProxy<T extends { dispose(): void }> {
  private refCount = 0;
  constructor(private factory: () => T, private asset?: T) {}

  acquire(): T {
    this.refCount++;
    if (!this.asset) this.asset = this.factory();  // 首次 acquire 才创建
    return this.asset;
  }
  release(): void {
    if (--this.refCount <= 0 && this.asset) {
      this.asset.dispose();  // 引用归零 → 自动卸载
      this.asset = undefined;
    }
  }
}

// 使用：UI 面板打开时 acquire，关闭时 release，不用关心何时释放纹理
class SkillPanel {
  private icon: ReturnType<SharedAssetProxy<RealTexture>['acquire']>;
  constructor(private tex: SharedAssetProxy<RealTexture>) {
    this.icon = this.tex.acquire();  // 多个面板共享同一纹理，计数 +1
  }
  onClose(): void { this.tex.release(); }  // 计数 -1，最后一个关闭才真卸载
}
```

**保护代理 + 远程代理：权限校验与 RPC 屏蔽（合并示例）**

```typescript
// 保护代理：访问前先校验权限，没权限直接拒绝，真实 GMService 永不暴露给非法调用方
class GMServiceProxy implements IGMService {
  constructor(private real: GMService, private user: User) {}
  giveItem(playerId: string, itemId: string, count: number): Result<void> {
    if (!this.user.hasRole('gm')) return err('权限不足');  // 代理拦截
    if (count <= 0 || count > 9999) return err('数量非法'); // 参数校验也归代理
    return ok(this.real.giveItem(playerId, itemId, count));  // 通过才调真实对象
  }
}

// 远程代理：本地调用语法，代理内部做序列化 + 网络传输 + 反序列化
class ShopRemoteProxy implements IShopService {
  constructor(private endpoint: string) {}
  async buy(itemId: string): Promise<Result<Order>> {
    try {
      const resp = await fetch(`${this.endpoint}/buy`, {   // 网络细节藏在代理里
        method: 'POST', body: JSON.stringify({ itemId }),
      });
      return ok(await resp.json());                        // 真实对象"在服务器"
    } catch (e) { return err((e as Error).message); }       // 代理统一异常处理
  }
}
// UI 层调用 shopProxy.buy('sword_01') 看起来像本地方法，实际跨网络——代理让 RPC 透明
```

**3. 四种"包装类"意图对比 + 代理的 UML 结构**

```
            ┌──────────┐  Subject 接口 (shared)
            │  IAsset  │<<interface>>
            └────┬─────┘
        ┌────────┴────────┐
        ▼                 ▼
┌───────────────┐   ┌───────────────┐
│ RealTexture   │   │ TextureProxy  │
│ (真实对象)     │◄──│  -real: Real  │  持有引用 + 访问前后插入逻辑
│ draw(){...}   │   │  draw(){懒加载/计数/权限} │
└───────────────┘   └───────────────┘
   客户端 ─────────────► 只认识 IAsset，不区分真实/代理
```

| 模式 | 意图 | 接口关系 | 游戏典型场景 | 与代理的区别 |
|------|------|----------|-------------|-------------|
| **代理 Proxy** | 控制访问 | 同接口（IS-A） | 懒加载纹理、RPC、权限、引用计数 | —（本体） |
| 适配器 Adapter | 转换接口 A→B | 不同接口 | 第三方 SDK 接入、回调转 Promise | 代理不改接口，适配器必须改 |
| 装饰器 Decorator | 叠加行为 | 同接口（IS-A） | Buff 属性叠加、技能修饰链 | 装饰器增功能，代理控访问 |
| 外观 Facade | 简化子系统 | 提供新门面 | ResourceManager 统一入口 | 外观是新接口，代理保持原接口 |

### ⚡ 实战经验

- **懒加载代理把首屏从 4.2s 降到 1.1s**：背包有 240 个道具图标，启动时全量解码 4K 纹理卡顿明显（Profiler 显示 4.2s）。改成 `LazyTextureProxy` 后首屏只解码可见的 12 张（约 150ms），其余滚动到视口时按需解码，滚动偶发 1 帧抖动但整体流畅，用 LRU 上限 60 张兜底内存。
- **引用计数代理救回一个 OOM 崩溃**：战斗中频繁切技能图标，裸引用管理忘了 dispose，纹理内存从 80MB 涨到 480MB 后被系统杀进程。换成 `SharedAssetProxy` 后 acquire/release 配对自动计数，内存稳定在 95MB（含 LRU 缓存），彻底消灭这类泄漏。
- **远程代理要处理网络异常，不能让真实对象接口泄露**：早期 `shopProxy.buy()` 直接把网络异常透传给 UI，导致 UI 层满是 try-catch。后来代理内部统一 catch，转成 `Result<Ok, Err>` 返回，UI 只关心成功/失败两态——代理的职责就是让"远程"看起来像"本地"，异常处理属于这个职责。
- **保护代理别只在前端校验**：GM 命令的权限校验放在客户端代理里，结果有玩家反编译改了代理直接调用真实 GMService，刷了大量金币。教训：客户端保护代理只是 UX 优化（隐藏无权限按钮），真正的权限边界必须在服务器端再校验一次。
- **代理 vs 装饰器在 Buff 系统里混用**：技能图标用代理（懒加载纹理），但 Buff 属性叠加用装饰器（多层修饰实时叠加）。曾误用代理做 Buff，结果代理是"一对一"持有真实对象，无法链式叠加多层修饰；改回装饰器后 Buff 链自然支持 N 层嵌套。

### 🔗 相关问题

1. 远程代理（RPC）和本地异步调用（Promise/async）在游戏架构中如何统一？跨服战斗时玩家操作该走代理还是事件总线？
2. Cocos/Unity 的资源管理器（`resources.load` / `Addressables`）内部是否就是虚拟代理？框架自带的引用计数和你手写的智能引用代理有何重叠？
3. 动态代理（Dynamic Proxy，如 ES6 `Proxy` / Java 反射代理）相比静态代理（手写 Proxy 类）在热更新场景下有什么优势？性能开销差多少？
