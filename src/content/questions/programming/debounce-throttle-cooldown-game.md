---
title: "游戏里的防抖、节流、冷却、退避有什么区别？技能 CD、网络重试、输入采样分别该用哪个？"
category: "programming"
level: 2
tags: ["异步编程", "防抖", "节流", "冷却", "退避", "输入处理", "网络优化", "性能优化"]
related: ["programming/event-loop-task-scheduling", "programming/promise-concurrency-pool", "programming/game-loop-fixed-timestep"]
hint: "防抖是「停下来才执行」、节流是「固定频率执行」、冷却是「执行后锁定一段时间」、退避是「失败后越来越慢地重试」。四个时间门控模式长得很像，但语义和适用场景完全不同，用错就会出现「技能放不出来」或「断线重连风暴」。"
---

## 参考答案

### ✅ 核心要点

1. **防抖（Debounce）：只在「事件停止涌入一段时间后」执行一次**。核心思想是「以最后一次触发为准」——每次事件到来都重置计时器，只有当事件连续静止超过 `delay` 毫秒才真正执行。典型场景：搜索框输入（用户停手才搜索）、窗口 resize（停止拖动才重排）。游戏里的用途：聊天输入框联想、设置面板「自动保存」（玩家改完设置停手 2 秒才存盘，避免每次滑动都写盘）。防抖适合「只需要最终结果、中间过程无意义」的场景。
2. **节流（Throttle）：保证「最多每 delay 毫秒执行一次」，中间触发被丢弃**。核心思想是「固定频率采样」——第一次立即执行，之后每 `delay` 毫秒最多执行一次，期间到来的事件全部忽略。典型场景：滚动事件处理、鼠标移动追踪、触摸拖拽。游戏里的用途：摇杆输入采样（固定 60Hz 采样方向，不随触屏事件频率波动）、小地图拖动、技能轮盘。节流适合「需要持续响应但要限制频率」的场景。
3. **冷却（Cooldown）：执行一次后「锁定」一段时间，期间禁止再次执行**。和节流的区别在于「节流是周期性放行，冷却是单次触发后整段锁死」。游戏里最典型的就是技能 CD——释放技能后进入冷却，CD 结束前不能再次释放。冷却的关键是「状态 + 剩余时间」：UI 要显示倒计时扇形/进度条，服务器要校验防止客户端作弊绕过 CD。冷却还分「全局冷却（GCD，放任何技能都触发）」和「技能独立冷却」，实现上用时间戳记录 `lastCastTime + cooldown` 即可判断。
4. **退避（Backoff）：失败后「越来越慢地」重试，避免雪崩**。核心公式是重试间隔指数增长（`delay = base * 2^n`，通常加上随机抖动 jitter 防止多个客户端同步重试）。典型场景：断线重连、网络请求失败重试、限流后的退避。游戏断线重连如果不加退避，几万玩家同时重连会瞬间打爆服务器（雷鸣效应）；加上指数退避 + 抖动，重连请求会被「摊平」到几十秒内，服务器得以喘息。退避必须有「最大重试次数」和「最大延迟上限」，否则永远重试浪费电量。
5. **四者本质都是「时间门控」，但触发条件、执行次数、失败语义完全不同**。防抖看「是否停止」、节流看「是否到周期」、冷却看「上次执行距今」、退避看「上次是否失败」。混淆它们会导致典型 bug：用防抖实现技能 CD（快速连点会被合并成一次，技能「丢失」）、用节流实现断线重连（固定 1 秒重试，服务器压力不降）、用冷却实现搜索联想（第一次输入后要等 CD 结束才能再次联想）。正确选型的前提是搞清楚你要的是「去抖」「限频」「锁死」还是「渐缓」。

### 📖 深度展开

#### 1. 四种模式的实现与触发时序对比

```typescript
// ★ 防抖：连续触发只保留最后一次，停止后 delay 才执行
function debounce<A extends unknown[]>(fn: (...a: A) => void, delay: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer) clearTimeout(timer);             // 每次都重置，以最后一次为准
    timer = setTimeout(() => { fn(...args); timer = null; }, delay);
  };
}

// ★ 节流：固定频率放行，周期内的触发全部丢弃
function throttle<A extends unknown[]>(fn: (...a: A) => void, interval: number) {
  let last = 0;
  return (...args: A) => {
    const now = Date.now();
    if (now - last >= interval) {               // 距上次执行超过周期才放行
      last = now;
      fn(...args);
    }
  };
}

// ★ 冷却：执行后锁定 cooldown 毫秒，期间返回剩余时间供 UI 显示
class Cooldown {
  private until = 0;                            // 下次可用的时间戳
  constructor(private readonly ms: number) {}
  tryFire(): number {                           // 返回 0=成功，>0=剩余冷却ms
    const now = Date.now();
    if (now >= this.until) { this.until = now + this.ms; return 0; }
    return this.until - now;
  }
  get remaining(): number { return Math.max(0, this.until - Date.now()); }
}

// ★ 指数退避 + 抖动：重试间隔翻倍并加随机量，防止同步风暴
async function backoffRetry<T>(fn: () => Promise<T>, opts: {
  maxRetries = 5; baseMs = 500; maxMs = 30000;
} = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt >= opts.maxRetries) throw e;
      const exp = Math.min(opts.baseMs * 2 ** attempt, opts.maxMs);
      const jitter = Math.random() * exp * 0.3;  // ★ 抖动：0~30% 随机增量
      await new Promise(r => setTimeout(r, exp + jitter));
    }
  }
}
```

```
四种模式面对「连续 5 次触发」的时序对比（delay=100ms，每 20ms 触发一次）：

时间轴(ms):  0   20   40   60   80  100  120  140 ... 200
触发事件:    ●    ●    ●    ●    ●
-----------------------------------------------------------
防抖(100ms): ──────── 重置 ──────── 重置 ── 等100ms ──→ ★执行(最后一次,t≈180)
             （中间全部丢弃，只执行最后一次）

节流(100ms): ★执行(首次)  丢  丢  丢  丢 │  ★执行(t=100)│  ★执行(t=200)
             （固定 100ms 一次，无视中间触发）

冷却(100ms): ★执行(首次) ───── 锁定中(返回剩余时间) ──── → t=100解锁
             （执行一次后整段锁死，UI 显示倒计时）

退避:        失败→ 等500ms ─ 失败→ 等1000ms ─ 失败→ 等2000ms ─ ... (间隔翻倍)
             （只在失败时触发，间隔越来越长）
```

#### 2. 游戏实战：技能系统的冷却 + 网络层退避

```typescript
// ★ 技能管理器：独立冷却 + 全局冷却（GCD），服务器双端校验
class SkillManager {
  private cds = new Map<SkillId, Cooldown>();
  private gcd = new Cooldown(1500);             // 全局冷却 1.5 秒

  cast(skill: SkillId, skillTable: Record<SkillId, SkillDef>): boolean {
    const def = skillTable[skill];
    if (def.gcd && this.gcd.tryFire() > 0) return false;  // GCD 未结束
    let cd = this.cds.get(skill);
    if (!cd) { cd = new Cooldown(def.cooldownMs); this.cds.set(skill, cd); }
    if (cd.tryFire() > 0) return false;          // 技能独立 CD 未结束
    this.execute(def);
    return true;
  }
}

// ★ 断线重连：指数退避 + 抖动，防止万人同时重连打爆服务器
class ReconnectManager {
  private attempt = 0;
  async connect(url: string) {
    return backoffRetry(async () => {
      this.attempt++;
      const ws = new WebSocket(url);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });
      this.attempt = 0;                          // 成功则重置计数
      return ws;
    }, { maxRetries: Infinity, baseMs: 1000, maxMs: 30000 });
  }
  // 重试间隔序列（含抖动）：~1s, ~2s, ~4s, ~8s, ~16s, ~30s, ~30s ...
}
```

#### 3. 四种模式选型决策表

| 需求描述 | 应选模式 | 游戏典型场景 | 用错的后果 |
|---------|---------|------------|-----------|
| 「用户停下来才处理」 | **防抖** | 设置自动保存、聊天联想 | 用节流→停手后还在执行残留 |
| 「固定频率采样」 | **节流** | 摇杆输入(60Hz)、滚动加载 | 用防抖→拖动中无任何响应 |
| 「执行后锁死一段时间」 | **冷却** | 技能 CD、道具使用间隔 | 用节流→CD 期间仍周期性触发 |
| 「失败后越来越慢重试」 | **退避** | 断线重连、限流重试 | 用固定间隔→重连风暴打爆服务器 |
| 「连点只生效一次」 | 防抖或冷却 | 双击放大、按钮防连按 | 无处理→一秒触发几十次 |

```
选型决策树：

  要限制的是什么？
      │
      ├─ 事件涌入太频繁，只要最终结果？  → 防抖（搜索框、自动保存）
      │
      ├─ 要持续响应但限频？            → 节流（摇杆采样、滚动）
      │
      ├─ 成功一次后要锁死？            → 冷却（技能 CD、道具间隔）
      │
      └─ 失败要重试且不雪崩？          → 退避（断线重连、限流）
```

```typescript
// ★ 组合实战：摇杆输入用节流采样 + 发送用防抖合并
class JoystickInput {
  // 节流：摇杆方向每 16ms（60Hz）采样一次，不随触屏事件频率波动
  private sample = throttle((dir: Vec2) => {
    this.pendingDir = dir;
    this.flush.schedule();                       // 触发防抖发送
  }, 16);

  // 防抖：方向停止变化 50ms 后才发最终位置，合并中间抖动
  private flush = debounce(() => {
    this.sendToServer(this.pendingDir);
  }, 50);

  onTouch(dir: Vec2) { this.sample(dir); }       // 高频触摸 → 60Hz 采样 → 合并发送
}
```

### ⚡ 实战经验

- **用防抖实现技能 CD 导致「技能吞键」**：早期技能释放用 `debounce` 防连点，结果玩家快速连按两次技能键，防抖把它们合并成一次，第二个技能「放不出来」，手感极差被骂。技能 CD 必须用 `Cooldown` 类（首次立即执行 + 锁死），不能用防抖/节流——防抖会丢输入、节流会延迟首次触发。教训：手感相关的「即时响应」永远不能被防抖/节流吞掉。
- **断线重连没用退避，万人同时重连打爆登录服**：服务器重启后，全部玩家用固定 1 秒间隔重连，瞬间 **3 万 QPS** 把登录服打垮，重启后又被重连风暴打垮，形成死循环。改成指数退避（1s→2s→4s...→30s 上限）+ 30% 随机抖动后，重连请求被摊平到 2 分钟内，登录服峰值降到 **2000 QPS** 平稳度过。雷鸣效应是分布式系统的经典反面教材。
- **摇杆输入不节流，触屏高频事件吃满 CPU**：移动端 touchmove 事件每秒触发上百次，不节流直接处理每次都重算方向 + 发包，CPU 占用飙到 **40%**、网络包泛滥。加 16ms 节流（60Hz 采样）后 CPU 降到 **8%**、网络包减少 80%，手感没变化（人眼分辨不出 60Hz 以上的输入更新）。
- **节流的「首次延迟」坑了即时响应**：用 `leading=false` 的节流实现技能轮盘，第一次触摸要等一个周期（100ms）才响应，玩家觉得「卡顿」。改成 `leading=true`（首次立即执行 + 后续周期限频）后即时感恢复。节流默认要 leading-edge 触发，否则「第一次永远延迟」会毁掉即时交互手感。

### 🔗 相关问题

- **节流的 leading-edge 和 trailing-edge 有什么区别？游戏里怎么选？** —— 提示：leading 是「周期开始立即执行」，trailing 是「周期结束时补执行最后一次」。即时交互（摇杆、按钮）用 leading 保证首次响应；数据上报、滚动加载可用 trailing 保证不丢最后一次。
- **服务器端怎么做技能 CD 校验防作弊？客户端能不能本地判断 CD？** —— 提示：客户端本地判断 CD 只为「手感」，真正的权威在服务器——服务器记录每个技能的 `lastCastTime`，收到施法请求时校验 `now - lastCastTime >= cd`，不满足直接拒绝。客户端篡改本地 CD 只能让自己「看着能放」，服务器不认就不生效。
- **指数退避为什么要加随机抖动（jitter）？不加会怎样？** —— 提示：不加抖动时，所有同时断线的客户端会以完全相同的间隔重试（1s,2s,4s...），形成同步的「重试波峰」反复冲击服务器。加抖动后每个客户端的重试时间错开，请求被平滑分散——这是 AWS 架构博客经典文章《Exponential Backoff and Jitter》的核心结论。
