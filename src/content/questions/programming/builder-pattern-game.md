---
title: "建造者模式（Builder）在游戏配置与角色构建中如何应用？"
category: "programming"
level: 2
tags: ["设计模式", "建造者模式", "创建型模式", "流式API", "不可变对象"]
related: ["programming/factory-pattern-game", "programming/prototype-pattern-game", "programming/strategy-pattern-game"]
hint: "构造函数 10 个参数时怎么办？——把构造过程拆成一步步可读的链式调用，还能集中校验。"
---

## 参考答案

### ✅ 核心要点

1. **解决"过多构造参数"问题**：当一个对象有 10+ 个可选参数（角色：种族、职业、初始属性、技能、装备、出生点、难度……），构造函数 `new Character(race, job, str, agi, int, ...)` 既难读又易错（参数顺序搞混、漏填难发现）。Builder 把每个参数变成一个方法 `builder.race('elf').job('mage').str(8)`，调用方一目了然。
2. **分离构造与表示**：同样的构建步骤可以产出不同表示——`CharacterBuilder` 配 JSON 读取器读配置、配随机生成器做怪物刷新、配网络解析器从服务器同步。Director（导演类）编排"按什么顺序调哪些 with"，Builder 决定"每步具体填什么"，二者解耦，换数据源只换 Director。
3. **流式 API（Fluent Interface）是现代实现主流**：每个 setter 返回 `this`，链式调用 `b.a().b().c().build()`，比传统 GoF 的 Director+AbstractBuilder 写法更轻量。TypeScript 里 `class Builder { withX(x) { this.x = x; return this; } }` 即可。
4. **不可变对象的最佳搭档**：目标类所有字段 `readonly`，只能通过 Builder 构造后不再可变——函数式编程推崇的不可变性，配合 Builder 让"构造复杂不可变对象"变得可行，比 setter 链（破坏不可变性）更安全。
5. **支持分步校验和默认值**：`build()` 时统一校验（"法师智力不能 < 6"），失败抛异常而非构造出半残对象；未设置的参数用 `defaultValue`，避免 `undefined` 污染下游逻辑。部分校验也可前置到 `with` 方法里更早失败。
6. **别滥用：3 个参数不需要 Builder**。Builder 适合参数多（≥5）、可选参数多、需要不可变性、需要多表示的场景；简单 DTO 直接构造函数 + 对象字面量更清晰。过度使用会让代码啰嗦。

### 📖 深度展开

**1. 流式 Builder + 不可变角色**

```typescript
class Character {                              // 目标类：全 readonly，构造后不可变
  constructor(
    readonly race: string, readonly job: string,
    readonly str: number, readonly agi: number, readonly int: number,
    readonly skills: readonly string[], readonly spawnPoint: Vec3,
  ) {}
}

class CharacterBuilder {
  private race = 'human'; private job = 'warrior';
  private str = 10; private agi = 10; private int = 10;
  private skills: string[] = [];
  private spawn = new Vec3(0, 0, 0);

  withRace(r: string)  { this.race = r;  return this; }
  withJob(j: string)   { this.job = j;   return this; }
  withInt(v: number)   {                               // 前置校验更早失败
    if (v < 1 || v > 20) throw new Error('int 越界');
    this.int = v; return this;
  }
  withSkill(s: string) { this.skills.push(s); return this; }  // 可重复调用
  withSpawn(p: Vec3)   { this.spawn = p; return this; }

  build(): Character {
    this.validate();                           // 集中校验
    return new Character(this.race, this.job, this.str, this.agi, this.int,
      [...this.skills], this.spawn.clone());   // ★ 防御性拷贝
  }
  private validate() {
     if (this.job === 'mage' && this.int < 6) throw new Error('法师智力必须 ≥ 6');
   }
}

// 调用：可读、可缺省、可重复设置
const hero = new CharacterBuilder()
  .withRace('elf').withJob('mage').withInt(18)
  .withSkill('fireball').withSkill('teleport')
  .withSpawn(new Vec3(100, 0, 50))
  .build();
```

**2. Director 模式：从配置/网络数据驱动构建**

```
数据源                  Director（编排步骤）              Builder（填值）
─────────              ────────────────────              ─────────────
config.json  ─────┐                                     withRace(...)
                   ├──► CharacterDirector.build() ───►  withJob(...)
network.msg  ─────┘    （读字段、按顺序调 with*）         withInt(...)
                                                            ↓
                                                       build() → Character

价值：Director 管"按什么顺序、根据什么数据调哪些 with"，
      Builder 管"每个字段怎么存、build 怎么校验"。换数据源只换 Director。
```

```typescript
class CharacterDirector {
  constructor(private b: CharacterBuilder) {}
  fromJSON(cfg: CharacterConfig): Character {
    return this.b.withRace(cfg.race).withJob(cfg.job)
      .withInt(cfg.attrs.int).withSpawn(new Vec3(...cfg.spawn)).build();
  }
  random(level: number): Character {          // 同一 Builder，不同编排：换数据源只换 Director
    return this.b.withRace(pick(['human', 'elf', 'dwarf']))
      .withJob(level > 5 ? 'mage' : 'warrior')
      .withInt(6 + Math.floor(Math.random() * 12)).build();
  }
}
```

**3. Builder vs 其他创建型模式对比**

| 维度 | 直接构造函数 | 工厂模式 | 原型模式 | 建造者模式 |
|------|-------------|----------|----------|------------|
| 参数多 | ❌ 难读易错 | ❌ 同样多参数 | ✅ 克隆现成 | ✅ 链式清晰 |
| 可选参数 | 对象字面量凑合 | 多个工厂方法 | 复制后改 | ✅ withX 链 |
| 不可变性 | 配 readonly | 配 readonly | ❌ 可变克隆 | ✅ 最佳搭档 |
| 多种表示 | ❌ | ✅ 多工厂 | ✅ 多原型 | ✅ Director 切换 |
| 分步校验 | ❌ 构造中抛 | 部分 | ❌ | ✅ build() 集中 |
| 适用场景 | 简单 DTO | 按类型创建 | 复制昂贵对象 | 复杂多参数对象 |

### ⚡ 实战经验

- **`withSkill` 忘了 `return this`**：链式调用在中间断掉，后续 `withX` 报 `undefined.withX is not a function`。这是新手最常踩的坑。用泛型 `class Builder<T extends Builder<T>>` + 返回 `this` 让类型推断更稳，TS 编译期就能抓到。
- **防御性拷贝漏掉导致外部可变**：`build()` 直接把 `this.skills` 数组传出去，调用方 `push` 修改后所有引用该角色的系统都受影响。改成 `[...this.skills]` 浅拷贝（嵌套对象要深拷贝）后才安全。这类 bug 在异步任务队列里极难排查。
- **`build()` 校验太晚定位不准**：校验全放 `build()` 意味着所有 `with` 跑完才报错，堆栈指不到是哪个 `with` 写错。把范围校验前置到 `with` 方法（如 `withInt` 内查 1-20）能更早失败、更准定位；跨字段校验（"法师智力 < 6"）才放 `build()`。
- **配置表用 Builder 反而更慢**：10000 条角色配置从 JSON 加载，每条走 Builder 实例化 + 链式调用，比直接 `new Character(...cfg)` 慢 5-8 倍（额外对象分配 + 方法调用）。热路径批量加载还是直接构造函数，Builder 留给"少量、复杂、需要灵活配置"的场景。
- **可变 Builder 跨协程复用**：异步构建角色时 Builder 状态被多个 `await` 间穿插修改，`build()` 出来属性错乱。规则：Builder 一次性使用，`build()` 后丢弃。

### 🔗 相关问题

1. Builder 和 TypeScript 的"命名参数"（对象字面量解构 `{race, job, ...}`）相比有什么优势？什么时候用对象字面量就够了？
2. 如何用 Builder 实现一个"技能效果链" DSL——`damage(100).then(stun(2)).ifCrit(double)`？这种链式 DSL 的类型该怎么设计？
3. 不可变 Builder（每次 `with` 返回新 Builder）和可变 Builder（返回 `this`）各有什么取舍？函数式库为什么选前者？
