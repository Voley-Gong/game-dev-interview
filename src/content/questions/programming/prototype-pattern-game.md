---
title: "原型模式在游戏配置系统中有什么用？深拷贝有哪些坑？"
category: "programming"
level: 2
tags: ["设计模式", "原型模式", "配置系统", "深拷贝", "克隆"]
related: ["programming/factory-pattern-game", "programming/deep-vs-shallow-copy"]
hint: "不是 new + 逐字段赋值——是克隆已有对象生成变体，适合武器模板、关卡复制这类'基础版+微调'的创建场景。"
---

## 参考答案

### ✅ 核心要点

1. **原型模式的核心是"通过克隆已有对象创建新对象"**：当创建新对象需要大量重复配置（一个武器有 20 个字段），或对象构造很昂贵时，复制一个已配置好的"原型"再微调几个字段，比从头 new + 赋值高效得多。GoF 定义：用原型实例指定创建对象的种类，并通过拷贝这些原型创建新对象。
2. **游戏场景：武器模板系统、关卡编辑器复制、技能派生、怪物变体**：一把"铁剑"作为原型，克隆出"火焰铁剑"（改伤害类型）、"诅咒铁剑"（改属性），都是铁剑的变体。关卡编辑器里复制一个已摆好的房间当起点。技能系统里"火球术"派生出"大火球术""连发火球术"。本质都是"80% 字段相同 + 20% 微调"。
3. **深拷贝是原型模式的技术核心也是最大陷阱**：浅拷贝（`Object.assign`、展开运算符）只复制第一层，嵌套对象仍共享引用——克隆两把剑，给 A 加附魔，B 也变了。必须深拷贝嵌套结构，但深拷贝要处理循环引用、原型链污染、函数/Date/Map 等特殊类型。
4. **原型模式 vs 工厂模式：创建方式根本不同**：工厂模式从零开始组装对象（读配置表 → 逐字段赋值），适合"全新创建"；原型模式从已有对象复制，适合"变体创建"。两者常配合——工厂负责从配置表创建一批原型存进注册表，需要变体时从注册表取原型克隆。
5. **原型注册表（Prototype Registry）是落地的关键结构**：维护一个 `Map<string, Prototype>`，把所有基础原型（"铁剑模板""法师模板"）预加载进去。运行时按 key 取出克隆，避免每次都深拷贝完整配置。注册表 + 克隆是 RPG/卡牌游戏"角色生成器"的常见架构。
6. **性能考量：深拷贝不是免费的**：递归深拷贝一个含 50 个字段、3 层嵌套的武器对象，约 0.05-0.2ms。批量克隆 1000 个怪物可能花 50-200ms。对热路径（每帧创建的子弹）必须用对象池而非原型克隆；原型克隆适合低频的"配置型"创建（武器实例化、关卡加载）。

### 📖 深度展开

**1. 武器模板原型系统：Cloneable 接口 + 原型注册表**

```typescript
// 原型接口：所有可克隆对象实现 clone()
interface Prototype<T> {
  clone(): T;
}

// 武器配置：嵌套结构，必须深拷贝
interface Enchant { name: string; level: number; tags: string[]; }

class Weapon implements Prototype<Weapon> {
  constructor(
    public id: string,
    public name: string,
    public damage: number,
    public damageType: 'physical' | 'magical',
    public enchants: Enchant[],        // 嵌套数组——浅拷贝会共享
    public stats: { critRate: number; critDmg: number },  // 嵌套对象
  ) {}

  clone(): Weapon {
    // ✅ 深拷贝：每一层都重新创建，互不影响
    return new Weapon(
      this.id + '_copy', this.name, this.damage, this.damageType,
      this.enchants.map(e => ({ ...e, tags: [...e.tags] })),  // 数组+对象逐层拷
      { ...this.stats },  // 浅对象可用展开，但嵌套更深要递归
    );
  }
}

// 原型注册表：预加载基础模板，运行时按 key 克隆
class WeaponPrototypeRegistry {
  private prototypes = new Map<string, Weapon>();
  register(key: string, w: Weapon) { this.prototypes.set(key, w); }
  create(key: string): Weapon {
    const proto = this.prototypes.get(key);
    if (!proto) throw new Error(`未知武器原型: ${key}`);
    return proto.clone();  // 每次返回独立副本
  }
}

// 使用：从"铁剑"原型克隆出火焰变体
const registry = new WeaponPrototypeRegistry();
registry.register('iron_sword', new Weapon('w1', '铁剑', 50, 'physical',
  [{ name: '锋利', level: 1, tags: ['base'] }], { critRate: 0.1, critDmg: 1.5 }));

const fireSword = registry.create('iron_sword');  // 克隆
fireSword.name = '烈焰铁剑';
fireSword.damageType = 'magical';
fireSword.enchants.push({ name: '烈焰', level: 3, tags: ['fire'] });
// ✅ 原型 iron_sword 的 enchants 不受影响（深拷贝生效）
```

**2. 三种深拷贝方式对比：各自适用场景和坑**

| 方式 | 实现 | 循环引用 | 特殊类型 | 性能 | 适用场景 |
|------|------|---------|---------|------|---------|
| `structuredClone` | 内置 API | ✅ 支持 | ✅ Date/Map/Set | 中 | **现代首选（推荐）** |
| `JSON.parse(JSON.stringify())` | 序列化往返 | ❌ 栈溢出 | ❌ 丢函数/Date/undefined | 快 | 纯数据配置 |
| 手写递归 clone | 自实现 | ✅（需处理） | ✅ 完全可控 | 可优 | 复杂对象/性能敏感 |
| `Object.assign` / `...` | 浅拷贝 | - | - | 最快 | ❌ 原型模式禁用 |

```typescript
// 循环引用陷阱：JSON 方案直接崩溃
const quest: any = { name: '主线' };
quest.subQuests = [quest];  // 循环引用
// JSON.parse(JSON.stringify(quest))  // ❌ TypeError: Converting circular structure

// structuredClone 正确处理
const cloned = structuredClone(quest);  // ✅ 保留循环结构

// 手写深拷贝处理循环引用（用 WeakMap 记录已访问对象）
function deepClone<T>(obj: T, seen = new WeakMap()): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj as object)) return seen.get(obj as object);  // 命中循环引用
  const copy = Array.isArray(obj) ? [] : Object.create(Object.getPrototypeOf(obj));
  seen.set(obj as object, copy);
  for (const key of Reflect.ownKeys(obj as object)) {
    (copy as any)[key] = deepClone((obj as any)[key], seen);
  }
  return copy;
}
```

**3. 关卡编辑器克隆：原型模式 + 脏标记避免重复计算**

```
关卡编辑器：选中一个已布置好的房间，复制 10 份铺满走廊
┌─────────────────────────────────────────────────────┐
│  原型房间 (Room_A)                                   │
│  ├── tiles: Tile[64]      (已算好碰撞/AO/光照)       │
│  ├── enemies: Enemy[5]    (已配好 AI/掉落)          │
│  └── triggers: Trigger[3] (已绑好事件)              │
└─────────────────────────────────────────────────────┘
          │ room.clone() × 10
          ▼
┌─────────┐ ┌─────────┐ ┌─────────┐     ┌─────────┐
│ Room_A1 │ │ Room_A2 │ │ Room_A3 │ ... │ Room_A10│
│ 独立副本 │ │ 独立副本 │ │ 独立副本 │     │ 独立副本 │
└─────────┘ └─────────┘ └─────────┘     └─────────┘
  ✅ 改 Room_A3 的敌人不影响 Room_A1（深拷贝生效）
  ⚠️ 但共享的 Tile 贴图资源不应深拷贝——用引用 + 引用计数
```

```typescript
// 关键：区分"需要独立的逻辑数据"和"可共享的资源引用"
class Room implements Prototype<Room> {
  clone(): Room {
    const r = new Room();
    r.tiles = this.tiles.map(t => t.clone());     // 逻辑数据：深拷贝
    r.enemies = this.enemies.map(e => e.clone());  // 每个敌人独立
    r.texture = this.texture;                       // 资源：共享引用！
    assetManager.retain(r.texture);                 // 引用计数 +1
    return r;
  }
}
// 陷阱：把贴图也深拷贝会复制 GPU 纹理，显存翻倍，帧率暴跌
```

| 克隆对象 | 嵌套数据 | 资源引用 | 克隆耗时（典型） | 备注 |
|---------|---------|---------|----------------|------|
| 武器实例 | 全深拷贝 | 无 | ~0.1ms | 低频，安全克隆 |
| 关卡房间 | 逻辑深拷贝 | 资源共享+计数 | ~2-5ms | 必须区分数据/资源 |
| 怪物变体 | 配置深拷贝 | 共享 | ~0.5ms | 注册表批量克隆 |
| 子弹 | ❌ 用对象池 | - | - | 热路径禁用克隆 |

### ⚡ 实战经验

- **浅拷贝导致全局 Buff 串台**：怪物生成器用 `Object.assign({}, goblinTemplate)` 克隆地精模板，结果 `template.buffs` 数组被所有地精共享——给 1 号地精加中毒 Buff，全场 50 只地精一起掉血。改用 `structuredClone` 后串台消失，但要确保模板里没有函数（函数会被 `structuredClone` 丢弃）。
- **JSON 序列化丢失 undefined 字段引发默认值 Bug**：用 `JSON.parse(JSON.stringify(weapon))` 克隆，`enchant.bonus` 字段值是 `undefined` 时被 JSON 直接丢弃，克隆出来的武器访问 `enchant.bonus.damage` 报错。改用 `structuredClone` 保留 undefined，或显式处理缺失字段走默认值分支。
- **克隆资源引用吃爆显存**：关卡克隆时把 `texture` 字段也深拷贝了，复制 20 个房间后纹理显存从 80MB 涨到 1.6GB，移动端直接闪退。规则：资源（Texture/Audio/Prefab）永远共享引用 + 引用计数，只有纯逻辑数据深拷贝。
- **原型注册表预加载 vs 懒加载**：游戏启动时把 200 个武器原型全 `structuredClone` 预热进注册表，Loading 多了 300ms。改成懒加载（首次 create 时才克隆并缓存原型）后首屏快了，但首次克隆某武器时有 0.1ms 卡顿。权衡：常用原型预热，冷门原型懒加载。
- **原型模式 + 工厂模式配合做数据驱动生成**：策划在 Excel 配 `"base": "iron_sword", "overrides": {"damage": 80}`，工厂读配置→从注册表克隆铁剑原型→应用 overrides 覆盖几个字段。这套组合让策划不用懂代码就能派生新武器，某项目用它管理了 3000+ 武器变体，零代码新增。

### 🔗 相关问题

1. 深拷贝一个含有 `Map`、`Set`、`Date`、正则、类实例的复杂对象，`structuredClone` 和手写 clone 各有什么局限？类实例的原型链如何保留？
2. 原型模式和享元模式（Flyweight）都涉及对象复用，区别是什么？什么时候该用原型克隆，什么时候该用享元共享不可变内部状态？
3. 在帧同步游戏中，用原型模式克隆初始战斗状态做"回滚快照"（rollback snapshot），深拷贝的性能和确定性如何保证？能否用结构化克隆 + 二进制序列化做网络同步？
