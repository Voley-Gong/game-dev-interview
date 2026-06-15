---
title: "游戏存档系统怎么设计？序列化、版本迁移和防作弊怎么做？"
category: "programming"
level: 2
tags: ["序列化", "存档系统", "数据持久化", "版本兼容", "防作弊"]
related: ["programming/design-patterns-game", "programming/memory-gc-optimization"]
hint: "存档不只是 JSON.stringify——版本迁移、增量存储、防篡改、崩溃恢复，每个都是上线后才暴雷的坑。"
---

## 参考答案

### ✅ 核心要点

1. **存档 = 序列化 + 持久化 + 反序列化**：把运行时的游戏状态（角色数据、背包、任务进度、场景状态）转换成可存储的字节流写入本地/云端，读档时还原。核心难点不是「存」，而是「版本兼容」——v1.0 的存档在 v1.2 新增字段后不能崩。
2. **JSON 易读但体积大、Binary 紧凑但难调试**：JSON 存一个角色背包可能 5KB，二进制协议压缩到 800B。单机游戏用 JSON 足够（开发调试方便），网络游戏和存档频繁的场景必须上二进制——尤其是微信小游戏 10MB 本地存储限制下，差 6 倍体积就是能不能存得下的区别。
3. **版本迁移（Migration）是存档系统的灵魂**：v1.0 的存档没有 `guildId` 字段，v1.2 读取时要自动补默认值。做法是每个存档写入版本号 `version: 12`，读取时按版本号依次执行迁移函数 `migrate_11_to_12(data)`，像数据库 migration 一样逐步升级——千万别用 `if (!data.guildId)` 散落在代码各处。
4. **增量存档优于全量存档**：每次存档只写变化的数据块（如只存背包变化，不重写整个角色），用 Chunk 索引 + 偏移量定位。大世界游戏存档可能 50MB，全量写入需要 2-3 秒（卡帧），增量写入 200ms——玩家在 Boss 战自动存档时感受不到卡顿。
5. **防篡改：校验和 + 加密 + 服务器校验**：单机存档用 MD5/SHA256 校验和防止玩家手动改金币；进阶用 AES 加密存档内容；网络游戏的关键数据（等级、货币）必须以服务器为准，本地存档只是缓存——客户端永远不可信。
6. **崩溃恢复与原子写入**：存档过程中断电/崩溃会导致存档文件损坏（写了一半）。正确做法：先写入临时文件 `save.tmp`，完整写入后原子重命名为 `save.dat`（`fs.rename` 是原子操作）——要么存成功，要么还是上一次的完整存档，不会出现半损坏状态。

### 📖 深度展开

**1. 存档数据模型与序列化**

```typescript
// 存档根模型：版本号 + 校验和 + 分块数据
interface SaveFile {
  version: number;           // 存档版本号（用于迁移）
  checksum: string;          // 数据校验和（防篡改）
  createdAt: number;         // 创建时间戳
  updatedAt: number;         // 最后更新时间
  playTime: number;          // 游戏时长（秒）
  chunks: {                  // 分块存储：每个系统独立存取
    player: PlayerData;
    inventory: InventoryData;
    quests: QuestData;
    world: WorldData;
    settings: SettingsData;
  };
}

// 序列化：运行时对象 → 可存储的纯数据（去掉引擎引用、函数、循环引用）
function serializePlayer(player: Player): PlayerData {
  return {
    id: player.id,
    name: player.name,
    level: player.level,
    exp: player.exp,
    position: { x: player.node.position.x, y: player.node.position.y, z: player.node.position.z },
    // ❌ 不能存 player.node（引擎对象）、player.rigidbody（组件引用）
    // ✅ 只存纯数据，反序列化时重新挂到场景节点上
    skills: player.skills.map(s => ({ id: s.id, level: s.level, cooldownEnd: s.cooldownEnd })),
    equipment: player.equipment.serialize(),  // 每个系统自己负责序列化
  };
}

// 反序列化：纯数据 → 运行时对象
function deserializePlayer(data: PlayerData, sceneNode: Node): Player {
  const player = sceneNode.getComponent(Player)!;
  player.level = data.level;
  player.exp = data.exp;
  sceneNode.setPosition(data.position.x, data.position.y, data.position.z);
  player.skills = data.skills.map(s => SkillFactory.create(s.id, s.level, s.cooldownEnd));
  return player;
}
```

```
存档写入流程（原子写入 + 校验和）：

  游戏状态 ──► serialize() ──► SaveData 对象
                                   │
                          ┌────────┴────────┐
                          │                 │
                    计算 checksum      写入 save.tmp
                          │                 │
                          └────────┬────────┘
                                   │
                          rename(save.tmp → save.dat)
                                   │  ← 原子操作，崩溃也不损坏
                                   │
                              写入完成 ✅

  崩溃恢复：如果 save.tmp 存在 → 上次写入中断 → 删除 tmp，保留旧 save.dat
```

**2. 版本迁移：让旧存档在新版本中正常工作**

```typescript
// 迁移函数注册表：每个版本升级对应一个迁移函数
const migrations: Map<number, (data: any) => any> = new Map();

// v11 → v12：新增 guildId 字段
migrations.set(11, (data) => {
  data.player.guildId = data.player.guildId ?? '';  // 补默认值
  return data;
});

// v12 → v13：背包结构重构（从数组改成 Map）
migrations.set(12, (data) => {
  const oldItems = data.inventory.items as { id: string; count: number }[];
  data.inventory.items = {};  // 改用对象存储
  for (const item of oldItems) {
    data.inventory.items[item.id] = item.count;
  }
  return data;
});

// v13 → v14：任务系统增加「日常任务」分类
migrations.set(13, (data) => {
  data.quests.daily = [];  // 旧存档没有日常任务，补空数组
  return data;
});

// 核心迁移引擎：从存档当前版本逐步迁移到最新版本
const CURRENT_VERSION = 14;

function migrateSave(data: any): SaveFile {
  let version = data.version ?? 1;
  while (version < CURRENT_VERSION) {
    const migrator = migrations.get(version);
    if (!migrator) throw new Error(`缺少迁移函数: v${version} → v${version + 1}`);
    data = migrator(data);   // 逐步升级
    version++;
    console.log(`存档迁移: v${version - 1} → v${version}`);
  }
  data.version = CURRENT_VERSION;
  return data as SaveFile;
}
// 好处：v1 的存档能一路迁移到 v14，每个迁移函数只关心相邻版本差异
// 新增字段只需写一个迁移函数，不用改所有反序列化代码
```

**3. 增量存档与存储格式对比**

```typescript
// 增量存档：只写变化的 Chunk，用脏标记驱动
class SaveManager {
  private dirtyChunks = new Set<string>();  // 标记哪些块被修改了

  markDirty(chunkName: string) {
    this.dirtyChunks.add(chunkName);  // 背包变化时 markDirty('inventory')
  }

  // 定时自动存档（如每 60 秒）：只存脏块
  async autoSave(): Promise<void> {
    if (this.dirtyChunks.size === 0) return;  // 没变化不存

    const save = this.loadSaveFile();  // 读已有存档
    for (const chunkName of this.dirtyChunks) {
      save.chunks[chunkName] = this.serializeChunk(chunkName);  // 只序列化脏块
    }
    save.updatedAt = Date.now();
    await this.writeAtomically(save);
    this.dirtyChunks.clear();
    // 全量 50MB → 增量只写了变化的 2MB，耗时从 3s 降到 200ms
  }
}
```

| 格式 | 体积（1MB 状态） | 读写速度 | 可读性 | 版本兼容 | 适用场景 |
|------|-----------------|----------|--------|----------|----------|
| JSON | 1.0 MB（基准） | 慢（解析+字符串） | ✅ 人可读 | ⚠️ 需手动处理缺字段 | 单机、开发调试、配置 |
| JSON + Gzip | 0.3 MB | 中（压缩开销） | ❌ 压缩后不可读 | ⚠️ 同上 | 移动端单机、云端存档 |
| MessagePack | 0.4 MB | 快 3-5x | ❌ 二进制 | ⚠️ 需 schema | 高性能序列化 |
| Protobuf | 0.25 MB | 最快 5-10x | ❌ 二进制 | ✅ 自动兼容 | 网络游戏、频繁存档 |
| 自定义二进制 | 0.15 MB | 最快 | ❌ 二进制 | ❌ 需手写迁移 | 极致体积优化（小游戏） |
| SQLite | 按需查询 | 快（索引） | ⚠️ 工具可读 | ✅ ALTER TABLE | 大型 RPG、复杂查询 |

```typescript
// 防篡改：校验和 + 密钥盐
import { createHash, createHmac } from 'crypto';

function signSave(data: SaveFile, secretKey: string): string {
  // 把数据（不含 checksum）序列化后做 HMAC-SHA256
  const { checksum, ...payload } = data;
  const json = JSON.stringify(payload);
  return createHmac('sha256', secretKey).update(json).digest('hex');
}

function verifySave(data: SaveFile, secretKey: string): boolean {
  const expected = signSave(data, secretKey);
  return expected === data.checksum;  // 校验和不匹配 → 存档被篡改
}
// 注意：密钥硬编码在客户端会被反编译提取，真正防作弊要靠服务器校验
```

### ⚡ 实战经验

- **循环引用导致 JSON.stringify 崩溃**：角色对象引用了所在场景，场景又引用了角色——`JSON.stringify(player)` 直接抛 `Converting circular structure to JSON`。解决方案：不直接序列化运行时对象，每个类实现 `serialize()` 方法只返回纯数据；或用 `flatted` 库（支持循环引用的 JSON 替代品），但体积会膨胀 30%。
- **版本迁移漏写默认值导致白屏**：v1.1 新增了 `settings.audioVolume` 字段，忘记写迁移函数。v1.0 的老玩家升级后读档，UI 代码 `settings.audioVolume.toFixed(2)` 在 `undefined` 上调用直接崩溃，整个存档界面白屏。教训：所有反序列化字段都要用 `data.field ?? defaultValue` 兜底，迁移函数和默认值双重保险。
- **存档文件损坏的灾难**：玩家玩了 200 小时的存档因为写入时手机低电量自动关机，文件只写了一半——`JSON.parse` 直接报语法错误，存档彻底无法读取。加了原子写入（先写 `.tmp` 再 rename）+ 双备份（保留上一版存档 `save.dat.bak`）后，这类客诉从每周 5-10 个降到零。
- **微信小游戏 10MB 存储限制**：RPG 游戏存档包含背包、地图探索、对话记录，JSON 存下来 15MB 超出限制。改用 Protobuf 二进制序列化后压到 3MB，再把不常用的数据（已完成对话记录）拆分到独立文件按需加载，主存档降到 2MB。提前规划存储格式比后期重构省 10 倍成本。
- **自动存档时机选错导致卡顿**：Boss 战中每 30 秒自动存档，全量序列化 + 写入花了 400ms，正好卡在 Boss 释放大招的帧上，玩家被秒杀。改为「场景切换时全量存 + 战斗中只存 checkpoint（当前位置+HP）」，战斗中的增量存档控制在 50ms 以内，玩家完全无感。

### 🔗 相关问题

1. 大型开放世界游戏（如原神）如何实现「随时存档」且存档体积可控？是否需要把整个世界状态都序列化？
2. 云存档同步冲突怎么处理？玩家在两台设备上同时游玩，本地存档和云存档不一致时该以谁为准？
3. 存档加密的密钥如果被反编译提取了怎么办？单机游戏的防作弊做到什么程度就够了？
