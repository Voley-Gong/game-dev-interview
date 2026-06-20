---
title: "TypeScript 的 Branded Type（名义类型）怎么用？为什么游戏里 PlayerId 和 EntityId 不该都是 number？"
category: "programming"
level: 3
tags: ["TypeScript", "类型系统", "Branded Type", "名义类型", "类型安全", "编译期检查"]
related: ["programming/typescript-advanced-types-game", "programming/slot-map-generational-index", "programming/error-handling-result-type"]
hint: "TypeScript 是结构类型——两个结构相同的类型可互相赋值。游戏里 PlayerId、EntityId、ItemId 都是 number，传错参数编译器不报错，运行时才崩。Branded Type 用交叉类型模拟名义类型，让 bug 在编译期暴露。"
---

## 参考答案

### ✅ 核心要点

1. **TypeScript 是结构类型系统（Structural Typing），不是名义类型（Nominal Typing）**。结构类型的判断标准是「形状相同即可赋值」——只要两个类型的属性结构一致，TS 就认为它们兼容。这意味着 `type PlayerId = number` 和 `type EntityId = number` 在 TS 眼里是同一个东西，你可以把 `PlayerId` 传给需要 `EntityId` 的函数，编译器完全不报错。而名义类型（如 Rust、F#、Swift 的 typealias + 标记）则是「名字不同就是不同类型」，即使底层都是 i32 也不能混用。游戏项目里 ID 满天飞（玩家、实体、物品、技能、公会全是 number），结构类型会让「传错 ID」这类 bug 潜伏到运行时。
2. **Branded Type（品牌类型）用交叉类型 + 唯一幽灵字段模拟名义类型**。核心套路：`type PlayerId = number & { readonly __brand: 'PlayerId' }`。这个 `__brand` 字段在运行时根本不存在（不占内存、不影响序列化），纯粹是编译期的「防伪标记」。两个 branded type 即使底层都是 number，因为 `__brand` 字面量不同（'PlayerId' vs 'EntityId'），TS 会判定为不兼容类型，互相赋值直接编译报错。零运行时成本，纯编译期保护。
3. **构造 branded value 必须通过受控的「铸造函数」，不能直接赋值**。普通的 `const id: PlayerId = 123` 会报错（因为 123 没有 `__brand` 字段），这正是我们要的防护。要创建 branded 值，需要一个 `as` 断言函数：`const toPlayerId = (n: number): PlayerId => n as PlayerId`。这个函数是唯一的「入口」，集中了所有「从裸 number 到类型安全 ID」的转换——你可以在里面加校验（如 ID 必须为正整数），让非法 ID 在构造时就暴露，而不是等到用的时候。
4. **Branded Type 的真正价值是「让整个调用链的类型签名成为文档和防护」**。当一个函数签名是 `grantItem(playerId: PlayerId, itemId: ItemId, count: number)` 时，编译器强制你必须传入正确类型的 ID，把「参数顺序写反」「玩家ID传成实体ID」这类低级但极难排查的 bug 直接消灭在编译期。重构时如果改了参数类型，所有调用点立即飘红，不会漏改。这是用类型系统把「运行时崩溃」前移为「编译时错误」的典型实践。
5. **Branded Type 不止用于 ID，还可用于「带单位的数值」「状态机状态」「已验证数据」**。任何「底层是基础类型，但语义上需要区分」的场景都适用：`HP` vs `MP` vs `Gold`（防止单位混算）、`UnvalidatedInput` vs `SanitizedInput`（区分是否过消毒）、`Ready` vs `Firing` vs `Cooldown`（状态机）。这种「用类型表达业务约束」的思路叫 Parse Don't Validate——把校验结果编码进类型系统，编译器保证你拿不到非法状态。

### 📖 深度展开

#### 1. Branded Type 的实现与「铸造函数」

```typescript
// ★ 核心：用交叉类型给 number 打上编译期的「品牌标记」
declare const __brand: unique symbol;           // 唯一 symbol，防冲突
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// 游戏里常见的几种 ID —— 底层都是 number，但语义绝不能混
type PlayerId = Brand<number, 'PlayerId'>;
type EntityId = Brand<number, 'EntityId'>;
type ItemId   = Brand<number, 'ItemId'>;
type SkillId  = Brand<number, 'SkillId'>;

// 带单位的数值——防止 HP 和 Gold 直接相加
type HP    = Brand<number, 'HP'>;
type Gold  = Brand<number, 'Gold'>;

// ★ 受控构造器：所有「裸 number → 类型安全值」的唯一入口
const pid = (n: number): PlayerId => {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`非法 PlayerId: ${n}`);
  return n as PlayerId;                          // 只在这个函数里 as 断言
};
const eid = (n: number): EntityId => n as EntityId;
const iid = (n: number): ItemId   => n as ItemId;

// ★ 编译期防护：传错类型直接报错
grantItem(pid(1001), eid(2002), 5);              // ✅ 编译通过
grantItem(eid(2002), pid(1001), 5);              // ❌ 编译报错：参数顺序反了
grantItem(1001, 2002, 5);                        // ❌ 编译报错：裸 number 不能赋值

function grantItem(playerId: PlayerId, itemId: ItemId, count: number): void {
  // 函数体内，playerId 和 itemId 的类型保证了「绝不可能传反」
  sendToClient(playerId, { op: 'grant', itemId, count });
}
```

```
Branded Type 的编译期工作原理：

  裸 number  ──┐
               │  pid() 铸造函数（唯一 as 断言入口）
  PlayerId  ──┘     ↓ 加上 { __brand: 'PlayerId' } 幻影标记
               ┌────────────────────────────────────┐
               │  PlayerId = number & {             │
               │    readonly [__brand]: 'PlayerId'  │  ← 编译期存在
               │  }                                 │  ← 运行时不存在（0 开销）
               └────────────────────────────────────┘
                          ↓
  赋值检查：PlayerId → EntityId ?
  TS 对比 { __brand: 'PlayerId' } vs { __brand: 'EntityId' }
  字面量类型 'PlayerId' ≠ 'EntityId'  →  ❌ 编译报错
```

#### 2. 结构类型 vs 名义类型 vs Branded Type 对比

| 维度 | 结构类型（TS 默认） | 名义类型（Rust/Swift） | Branded Type（TS 模拟） |
|------|---------------------|----------------------|------------------------|
| 判定依据 | 属性结构相同即可 | 类型名不同即不同 | 幽灵字段字面量不同 |
| `PlayerId`→`EntityId` | ✅ 允许（都是 number） | ❌ 拒绝 | ❌ 拒绝 |
| 运行时开销 | 无 | 无 | **无（幽灵字段不存在）** |
| 实现成本 | 零 | 语言内置 | 需定义 Brand + 铸造函数 |
| 序列化影响 | 无 | 无 | **无（品牌在运行时不可见）** |
| 游戏项目收益 | 低（ID 易混） | 高 | **高（编译期消灭 ID 混用）** |

```typescript
// 结构类型的「灾难现场」——没有 Branded Type 时
function dealDamage(targetId: number, skillId: number, damage: number) {}
dealDamage(skillId, targetId, damage);   // ✅ 编译通过！但逻辑全错
// 策划反馈「技能打不出伤害」，你排查两小时才发现参数传反了

// 有 Branded Type 后
function dealDamage(target: EntityId, skill: SkillId, dmg: HP) {}
dealDamage(skill, target, dmg);          // ❌ 编译报错：SkillId 不能赋给 EntityId
// bug 在写代码的瞬间被编译器抓住，而不是上线后由玩家发现
```

#### 3. 进阶：状态机与「已验证数据」的品牌化

```typescript
// ★ 用 Branded Type 区分「未消毒输入」和「已验证输入」——Parse Don't Validate
type RawInput    = Brand<string, 'Raw'>;         // 来自网络的原始字符串
type Sanitized   = Brand<string, 'Sanitized'>;   // 已转义、可安全使用

// 消毒函数：唯一的 Raw → Sanitized 转换入口，内部做 XSS 过滤
function sanitize(raw: RawInput): Sanitized {
  const cleaned = raw.replace(/[<>\"']/g, '').slice(0, 200);
  return cleaned as Sanitized;
}
function renderChat(msg: Sanitized): void { /* 安全，已消毒 */ }

renderChat(msgFromNetwork as RawInput);          // ❌ 报错：Raw 不能直接渲染
renderChat(sanitize(msgFromNetwork as RawInput)); // ✅ 必须先消毒

// ★ 状态机：用品牌联合类型表达「只可能是合法状态」
type WeaponState =
  | Brand<'idle',     'Ready'>
  | Brand<'firing',   'Firing'>
  | Brand<'cooldown', 'Cooldown'>;

// 编译器强制 switch 穷举所有状态（exhaustiveness check）
function getAnimation(s: WeaponState): string {
  switch (s) {
    case 'idle' as WeaponState:     return 'idle_anim';
    case 'firing' as WeaponState:   return 'fire_anim';
    case 'cooldown' as WeaponState: return 'cd_anim';
    default: const _: never = s;    // ★ 漏写一个状态，这里编译报错
      return '';
  }
}
```

```
「Parse Don't Validate」数据流（Branded 保证的信任边界）：

  网络层          业务层              渲染层
  ┌────┐   sanitize()   ┌─────────┐   render()
  │ Raw │ ────────────→ │Sanitized│ ──────────→ 安全上屏
  └────┘  ★唯一入口     └─────────┘  ★类型保证已消毒
    │
    └──直接传给渲染层？❌ 编译报错，Sanitized 才行
```

### ⚡ 实战经验

- **ID 传反导致「给错玩家发邮件」事故**：邮件系统 `sendMail(targetId, itemId, count)`，某次调用把 `senderId` 当 `targetId` 传进去（都是 number，编译不报错），导致 **3000 封邮件发给了发送者自己**，收到大量客诉。全项目 ID 改成 Branded Type 后，这类参数错位在编译期就被拦住，半年内零复发。
- **HP 和 Gold 相加的隐藏 bug**：商店扣费 `gold -= price`，某处误写成 `gold -= hp`，玩家每次购买「用血量当钱扣」，导致买几瓶药自己就「负血」了。引入 `HP`/`Gold` 品牌类型后，`gold: Gold` 和 `hp: HP` 不能直接运算（需显式 `Number()` 拆包），误用立即编译报错，review 时一眼就能发现不该出现的拆包。
- **别忘记给 branded 值写 JSON 序列化适配**：Branded Type 底层就是 number/string，`JSON.stringify` 正常工作（幽灵字段不在运行时）。但反序列化时 `JSON.parse` 出来的是裸 number，必须重新过铸造函数 `pid(parsed.id)` 恢复类型——否则后续传递又会「降级」回裸 number 丢失保护。封装一个 `parsePlayer(data): { id: PlayerId }` 统一入口。
- **铸造函数别滥用 `as` 断言**：团队里有人图省事，在业务代码里到处写 `entityId as PlayerId` 绕过类型检查，Branded 形同虚设。规范是：全项目 `as Brand` 断言只能出现在铸造函数（`pid/eid/iid`）内部，用 ESLint 自定义规则 `no-unsafe-type-assertion` 禁止业务代码裸用 `as`，守住「唯一入口」原则。

### 🔗 相关问题

- **Branded Type 和泛型 Brand<T, B> 的 symbol key 为什么用 `unique symbol`？** —— 提示：普通 string key 可能被两个库的品牌冲突覆盖，`unique symbol` 保证全局唯一，即使两个文件都定义 `__brand` 也不会撞。
- **运行时如何验证一个值确实是 branded 的？（防御反序列化/外部数据）** —— 提示：Branded 是编译期概念，运行时无法区分；外部数据进来必须通过铸造函数 + 运行时校验（如 `zod` schema）重新建立信任边界，不能信任类型断言。
- **和 C# 的 `readonly struct PlayerId { public readonly int Value; }` 零分配 ID 相比，Branded Type 有没有运行时劣势？** —— 提示：没有。Branded 是纯编译期 trick，运行时就是 number，零分配零装箱；C# 那种值类型封装反而有结构体拷贝开销。
