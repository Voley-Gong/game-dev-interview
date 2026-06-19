---
title: "空对象模式（Null Object）在游戏中怎么用？为什么消灭 null 检查比处理 null 更优雅？"
category: "programming"
level: 1
tags: ["设计模式", "空对象模式", "防御式编程", "多态", "TypeScript"]
related: ["programming/strategy-pattern-game", "programming/state-pattern-game", "programming/error-handling-result-type"]
hint: "满屏的 if(x===null) 防御检查——如果那个「空」本身就是一个合法的、什么都不做的对象呢？"
---

## 参考答案

### ✅ 核心要点

1. **空对象的本质是「用一个『什么都不做』的真实对象代替 null」**：它实现与正常对象相同的接口，但所有方法都是 no-op（空操作/返回默认值）。调用方拿到它后照常调用，无需任何 null 判断——多态替你处理了「缺失」这件事。
2. **消灭的是散落在各处的 `if (x === null) return` 防御代码**：没有空对象时，每个使用点都要写 null 检查，漏一处就 NPE 崩溃。空对象把这些检查收敛到「对象创建/注入」的一个点：要么给真对象，要么给 NullObject，调用方永远拿到一个能安全响应的东西。
3. **典型游戏场景是「优雅降级」和「占位槽位」**：音频设备初始化失败时注入 `NullAudio`（play() 静默成功，游戏不崩）；装备槽没装武器时返回 `NullWeapon`（攻击造成 0 伤害、getRange 返回 0，AI 自然不会用它打人）；未配置的成就回退到 `NullAchievement`。系统在缺件时仍能运行，而非崩溃。
4. **空对象必须无状态、可单例共享**：它对所有调用方行为一致（都是 no-op），所以一个全局单例实例就够了，到处 `new` 反而浪费。它返回的默认值（0、空数组、false）要选择「不会引发后续错误」的语义，例如 NullWeapon 的伤害返回 0 而非 NaN。
5. **空对象 ≠ Optional/Result，也别用它掩盖真 Bug**：Optional 表达「有/无」让调用方显式处理；空对象表达「缺失即合法的默认行为」。只有当「什么都不做」是**正确的业务语义**时才用——比如静音时播放静默是合理的。如果是「不该为空却为空」的配置错误，用空对象会掩盖 bug，此时应抛异常。区分「合法缺失」和「非法缺失」是核心判断。

### 📖 深度展开

#### 1. 经典实现：音频与装备槽的空对象

```typescript
// === 统一接口：真音频和空音频实现同一套方法 ===
interface IAudio {
  play(soundId: string): void;
  setVolume(v: number): void;
}

// 真实实现：调用底层音频引擎
class RealAudio implements IAudio {
  play(id: string): void { engine.play(id); }
  setVolume(v: number): void { engine.masterVolume = v; }
}

// ★ 空对象：所有方法 no-op / 安全默认值，单例共享
class NullAudio implements IAudio {
  static readonly INSTANCE = new NullAudio();
  play(_id: string): void { /* 静默：什么都不做，不报错 */ }
  setVolume(_v: number): void { /* 忽略 */ }
}

// === 工厂：根据环境返回真对象或空对象，调用方无感知 ===
function createAudio(): IAudio {
  return engine.isAvailable() ? new RealAudio() : NullAudio.INSTANCE;
}

// === 装备槽：未装备时返回空武器，AI/战斗逻辑无需判空 ===
interface IWeapon {
  getDamage(): number;
  getRange(): number;
  swing(): void;
}

class NullWeapon implements IWeapon {
  static readonly INSTANCE = new NullWeapon();
  getDamage(): number { return 0; }     // 安全默认：0 伤害
  getRange(): number { return 0; }      // 射程 0 → AI 不会尝试用它攻击
  swing(): void { /* 空挥，无特效 */ }
}

class Character {
  private weapon: IWeapon = NullWeapon.INSTANCE;   // 默认空装备
  equip(w: IWeapon): void { this.weapon = w; }
  attack(): number {
    this.weapon.swing();                  // ★ 永不 null，无 if 判断
    return this.weapon.getDamage();
  }
}
```

```
依赖注入视角（注入点是唯一判断处，调用点零判断）：

  注入处（1 个）：createAudio() ──► RealAudio  或  NullAudio.INSTANCE
                                  │                    │
  调用处（N 个）：                 ▼                    ▼
   playBGM()    →  audio.play()   真实发声            静默成功
   playSfx()    →  audio.play()   真实发声            静默成功
   (每个调用点都无需 if(audio==null)，多态兜底)
```

#### 2. 空对象 vs Optional vs 默认值 vs null 检查

| 方案 | 调用方写法 | 缺失时行为 | 适合「合法缺失」 | 适合「非法缺失」 | 游戏典型 |
|------|-----------|-----------|----------------|----------------|---------|
| 裸 null + 检查 | `if(x) x.f()` | 漏检查即崩溃 | ❌ 啰嗦 | ✅ 显式 | 不推荐 |
| **空对象** | `x.f()` | 静默 no-op | ✅ 优雅 | ❌ 掩盖 bug | 静音/未装备槽 |
| Optional | `x?.f()` / `if(x)` | 显式处理或跳过 | 部分 | ✅ | 配置可选字段 |
| 抛异常 | `x!.f()` | 中断+堆栈 | ❌ | ✅ | 必需资源缺失 |

#### 3. 优雅降级：子系统初始化失败时游戏仍可运行

```typescript
// 游戏启动：逐个初始化子系统，失败的不阻断，注入空对象降级
class GameBootstrap {
  audio: IAudio;
  analytics: IAnalytics;
  haptics: IHaptics;

  init(): void {
    this.audio = tryInit(() => new RealAudio()) ?? NullAudio.INSTANCE;
    this.analytics = tryInit(() => new HttpAnalytics()) ?? NullAnalytics.INSTANCE;
    this.haptics = tryInit(() => new DeviceHaptics()) ?? NullHaptics.INSTANCE;
    // 即使音频引擎崩了、上报服务连不上，游戏照常跑——只是无声/无震动/无上报
  }
}

function tryInit<T>(factory: () => T): T | null {
  try { return factory(); } catch { return null; }
}
```

```
降级链：每个子系统独立「真对象 or 空对象」
  音频    RealAudio ─┐失败┐ NullAudio(静默)      ✓ 游戏继续
  上报    HttpAnalytics ─失败┘ NullAnalytics(丢弃) ✓ 不影响玩法
  震动    DeviceHaptics ─失败─ NullHaptics(no-op)  ✓ 仍可玩
  → 玩家体验：核心玩法 100% 可用，仅个别外围功能静默缺失，而非闪退
```

### ⚡ 实战经验

- **用空对象掩盖了配置缺失 Bug 拖了一周才暴露**：某角色 `NullWeapon.getDamage` 返回 0，策划忘了给 Boss 配主手武器，结果 Boss 打人全是 0 伤害，QA 以为是数值 bug 查了三天。教训：可玩对象的「缺失」不该用空对象——装备配置错应在校验阶段报红，空对象只用于「确实可有可无」的外围子系统。
- **空对象每次 new 导致 GC 压力**：装备栏每个空槽都 `new NullWeapon()`，一背包 40 槽 × 切换频繁，产生大量短命对象。改成 `static INSTANCE` 单例后零分配。规则：空对象必须是共享单例。
- **空对象返回了 NaN 引发连环错误**：`NullStat.getMultiplier` 返回了 `0/0=NaN`，伤害计算 `atk * NaN` 全部变 NaN，飘字显示「NaN」极其丑陋。改成返回 `1.0`（中性乘数）后正常。默认值要选「语义中性、不传染」的值。
- **音频设备热拔插时空对象无法切回真对象**：耳机拔出后切到 NullAudio，重新插入时仍停在 NullAudio（因为注入只发生在启动时）。解法：空对象方案配合「运行时重新注入」的开关，或监听设备变更事件重建真实实现。

### 🔗 相关问题

1. 空对象模式和「默认参数 / 默认策略」有什么区别？当默认行为本身较复杂（非纯 no-op）时，空对象还合适吗？
2. 在 ECS 架构里，一个实体「缺少某个组件」通常用「查询返回空」处理——这和空对象模式的取舍是什么？什么时候该用「空组件」占位？
3. 如何用 TypeScript 的 `never` / 类型守卫让空对象在编译期就被约束为「只能调用接口方法、不能访问额外字段」？
