---
title: "游戏的配置表系统怎么设计？Excel 导出 JSON 后如何保证类型安全和热重载？"
category: "programming"
level: 2
tags: ["配置系统", "数据驱动", "Schema校验", "热重载", "工程化"]
related: ["programming/serialization-save-system", "programming/builder-pattern-game"]
hint: "不是 JSON.parse 一行搞定——是数据驱动的实体生成 + 强类型校验 + 热重载 + 版本兼容的工程系统"
---

## 参考答案

### ✅ 核心要点

1. **静态配置 vs 动态配置**：静态配置（Excel/CSV → JSON，构建期冻结、强类型校验）适合数值表、装备表、关卡表；动态配置（ScriptableObject/Lua DSL）适合技能效果、剧情事件，运行时可改但校验弱。游戏里通常两种共存——数值平衡走静态表，玩法调试走动态脚本，各取所长。

2. **Schema 校验三层防御**：第一层是 Zod/Ajv 在构建期校验类型（string/number/array/enum），第二层是引用完整性校验（怪物表的 dropTableId 必须在掉落表中存在），第三层是业务规则校验（HP > 0、price >= 0、boss 的 hp >= 10000）。三层缺一不可，少一层都会让策划的脏数据在生产环境爆炸。

3. **数据驱动实体生成**：配置 → 工厂注册表 → 实例化，新增一个怪物只改 JSON 不改代码。关键是 typeId 到构造器的映射用注册表（Map<number, () => Entity>）替代 switch-case，否则每加一种怪就要改一处巨型 switch，违反开闭原则。

4. **热重载机制**：开发期用 fs.watch 监听配置文件变化，触发"重新解析 → Diff → 通知订阅者"管线；生产期只做增量推送（下发 patch JSON，客户端合并）。热重载必须支持回滚——解析失败要保留旧配置，否则策划改错一行 JSON 就让战斗系统当场崩溃。

5. **版本兼容策略**：配置字段只增不删（删除字段 = 断老客户端）、新增字段必须有默认值、不兼容变更走 Migration 脚本（v1→v2 自动转换）。客户端启动时校验配置版本号，过新则拒绝、过老则下载补丁，保证新老客户端共存。

### 📖 深度展开

#### 1. Schema 校验三层防御（Zod + 引用 + 业务）

使用 Zod 定义强类型 Schema，是数据驱动系统的第一道闸门：

```typescript
import { z } from "zod";

// 第一层：类型与结构校验
const MonsterSchema = z.object({
  typeId: z.number().int().positive(),
  name: z.string().min(1).max(20),
  hp: z.number().int().positive(),           // HP 必须 > 0
  attack: z.number().nonnegative(),
  defense: z.number().min(0).max(9999),
  dropTableId: z.string(),                    // 引用掉落表
  aiType: z.enum(["passive", "aggressive", "boss"]),
  skills: z.array(z.number()).max(4),         // 最多 4 个技能
});

type MonsterConfig = z.infer<typeof MonsterSchema>;

// 第二层：引用完整性（foreign key 校验）
function validateReferences(
  monsters: MonsterConfig[],
  dropTables: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const m of monsters) {
    if (!dropTables.has(m.dropTableId)) {
      errors.push(`怪物 ${m.name} 引用了不存在的掉落表 ${m.dropTableId}`);
    }
  }
  return errors;
}

// 第三层：业务规则（跨字段一致性）
const businessRules = (m: MonsterConfig): string[] =>
  [
    m.hp > 0 || "HP 必须 > 0",
    m.aiType !== "boss" || m.hp >= 10000 || "Boss HP 必须 >= 10000",
    m.aiType !== "boss" || m.skills.length > 0 || "Boss 必须至少一个技能",
  ].filter((r): r is string => typeof r === "string");
```

校验流程可视化：

```
Excel/JSON 原始数据
   ↓ Zod.parse()              —— 类型/结构
   ↓ validateReferences()     —— 外键完整性
   ↓ businessRules()          —— 业务一致性
   ↓
✅ 通过 → 生成强类型配置表（type-safe，CI 放行）
❌ 失败 → 阻断 CI 构建，报告精确行号 + 字段名
```

三层校验的分工对比：

| 校验层 | 检查内容 | 失败后果 | 实现时机 |
|--------|----------|----------|----------|
| Schema (Zod) | 类型、范围、枚举 | 运行时 NaN/undefined 崩溃 | 构建期 |
| 引用完整性 | 外键存在 | 怪物不掉宝、技能无效 | 构建期 |
| 业务规则 | 跨字段一致性 | Boss 不抗打、装备白送 | 构建期 + 灰度 |

#### 2. 热重载管线（开发期 fs.watch + 生产期增量）

```typescript
class ConfigReloader {
  private configs = new Map<string, unknown>();

  constructor(private dir: string) {
    // 开发期：监听文件变化
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filename?.endsWith(".json")) void this.reload(filename);
    });
  }

  private async reload(name: string): Promise<void> {
    const raw = await fs.readFile(`${this.dir}/${name}`, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`[Config] ${name} 解析失败，保留旧配置`);
      return; // 关键：解析失败绝不替换，战斗继续用旧数值
    }
    this.configs.set(name, parsed); // 只在成功后才替换
    console.log(`[Config] ${name} 热重载成功`);
  }
}
```

热重载流程图：

```
策划改 Excel → 导出 JSON → fs.watch 触发
   ↓
解析 + Schema 校验
   ├─ 失败 → 滚回旧配置 + 告警（战斗继续用旧数值）
   └─ 成功 → Diff → 推送增量给战斗系统
        ↓
   订阅者收到新配置（怪物血量等模板更新）
   注意：已实例化怪物的 hp 不变，新生成的才用新值
```

#### 3. 版本兼容与 Migration

配置版本演进时，老客户端可能拿不到新字段，必须做 Migration：

```typescript
interface VersionedConfig { version: number; data: unknown; }

// v1 → v2：dropId 从 number 改 string；v2 → v3：新增 rarity 默认值
const migrations: Record<number, (d: Record<string, unknown>) => unknown> = {
  1: (v1) => ({ ...v1, dropTableId: String(v1.dropId) }), // number→string
  2: (v2) => ({ ...v2, rarity: v2.rarity ?? "common" }),  // 新字段默认值
};

function migrate(cfg: VersionedConfig): VersionedConfig {
  let data = cfg.data;
  for (let v = cfg.version; migrations[v]; v++) data = migrations[v](data as never);
  return { version: Object.keys(migrations).length + 1, data };
}
```

版本兼容策略对比表：

| 变更类型 | 兼容性 | 处理方式 | 例子 |
|----------|--------|----------|------|
| 新增字段 | ✅ 向后兼容 | 默认值兜底 | v2 加 rarity 默认 "common" |
| 删除字段 | ❌ 不兼容 | 标记 deprecated，保留占位 | dropId 弃用但字段留着 |
| 改字段类型 | ❌ 不兼容 | Migration 脚本转换 | number → string |
| 改字段语义 | ⚠️ 危险 | 版本号 + 灰度发布 | HP 单位从千分比改百分比 |

### ⚡ 实战经验

- **字段重命名血案**：v1.2 把 `attack` 重命名为 `atk` 忘了写 Migration，100% 怪物攻击力变成 NaN，Boss 一刀被新手秒杀，紧急热修 30 分钟损失几十万流水。教训：字段改名必须走 Migration，且每个 Migration 必须有单测覆盖。

- **Excel 浮点精度坑**：策划在 Excel 里写 `=0.1+0.2` 当作暴击率，导出 JSON 变成 `0.30000000000000004`，Schema 校验通过（在 [0,1] 范围内）但概率计算偏差累积，10 万次暴击判定多触发约 4 次。修复：所有概率字段 Schema 用 `z.number().multipleOf(0.01)` 强制两位小数，把精度问题挡在构建期。

- **热重载时机陷阱**：在 Boss 战中策划热重载怪物表，Boss 当前 HP 从 50000 满血变成 8000（新配置 hp 调低），玩家已打到一半以为 Boss 快死了结果又被秒。修复：热重载只更新配置模板，已实例化怪物的 hp 保留运行时值，下次 spawn 才用新配置。

- **增量包大小优化**：全量配置 JSON 8MB，每次更新都下发全量导致弱网玩家加载 20 秒。改成 JSON-Patch 增量（RFC 6902），平均更新包降到 20-50KB，加载时间从 20s 降到 0.3s，弱网掉线率从 15% 降到 2%。

### 🔗 相关问题

- 存档系统的版本迁移和配置系统的 Migration 有什么共性和区别？（存档是用户数据不可丢弃，配置是设计数据可重建——容错策略完全不同）
- 如果配置表超大（10 万条怪物），内存和查询性能怎么优化？（分片懒加载、IndexedDB 持久化、二进制格式 MessagePack 替代 JSON 减小体积）
- 数据驱动和 ECS 架构怎么结合？（配置 → Component 纯数据 → Entity，工厂模式按 typeId 组装 Archetype）
