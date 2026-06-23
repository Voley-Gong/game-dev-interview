---
title: "游戏序列化架构怎么设计？如何处理存档版本迁移和向后兼容？"
category: "architecture"
level: 3
tags: ["序列化", "版本迁移", "向后兼容", "Protobuf", "数据持久化", "架构设计"]
related: ["architecture/save-system-architecture", "architecture/config-driven-architecture", "architecture/hot-update-architecture"]
hint: "序列化的难点不在'存下来'，而在游戏上线后改了字段结构，老玩家的旧存档怎么无损升级——版本号 + 迁移管线 + 字段只增不删。"
---

## 参考答案

### ✅ 核心要点

1. **格式选型决定一切**：Protobuf/FlatBuffers 适合高频网络包（紧凑、快），JSON 适合配置和调试（可读），自定义二进制适合存档（可控版本）
2. **版本号是迁移的基石**：每次写入数据都带 `version` 字段，加载时根据版本号走迁移管线（v1→v2→v3→…），逐级升级
3. **字段只增不删**：废弃字段标记 `deprecated` 但保留占位，新增字段给默认值——保证向前/向后兼容
4. **Schema 演进规则**：新增字段必须有默认值、字段类型不可改（int→long 需新字段）、枚举只追加不删
5. **反序列化是安全边界**：外部数据（存档/网络包/MOD）反序列化前必须校验长度、类型、嵌套深度，防止注入攻击和 OOM

### 📖 深度展开

**序列化格式对比：**

| 格式 | 体积 | 速度 | 可读性 | Schema/版本 | 典型用途 |
|------|------|------|--------|-------------|----------|
| JSON | 大 | 慢 | 强 | 无原生 | 配置表、调试、Web API |
| MessagePack | 中 | 快 | 弱 | 有扩展(type) | 存档、内部通信 |
| Protobuf | 小 | 很快 | 无 | 强（.proto） | 网络协议、热更数据 |
| FlatBuffers | 小 | 极快（零拷贝） | 无 | 强（.fbs） | 高频网络包、只读数据 |
| 自定义二进制 | 最小 | 最快 | 无 | 完全可控 | 回放录像、帧同步 |

**版本迁移管线（Migration Pipeline）——核心架构：**

```
存档文件（version=1）
    │
    ▼
读取 version=1 的原始数据
    │
    ▼
┌──────────────────────────────────────────┐
│  Migration Pipeline（逐级升级，幂等）       │
│                                            │
│  v1 → Migrate_v1_to_v2() → 加 coins 字段   │
│  v2 → Migrate_v2_to_v3() → hp 改名 health  │
│  v3 → Migrate_v3_to_v4() → inventory 重构   │
│  ...                                       │
│  vN → Migrate_vN_to_current()              │
└──────────────────────────────────────────┘
    │
    ▼
当前版本数据 → 注入游戏
```

```csharp
// 版本迁移管线：每个版本一个迁移函数，串成链
public static class SaveMigrator {
    private static readonly Dictionary<int, Func<SaveData, SaveData>> _migrations = new() {
        { 1, MigrateV1ToV2 },
        { 2, MigrateV2ToV3 },
        { 3, MigrateV3ToV4 },
        // 每次改结构，只在这里追加一行，不改老迁移函数
    };

    public static SaveData MigrateToCurrent(SaveData data, int fromVersion) {
        int current = SaveData.CURRENT_VERSION;  // 如 4
        for (int v = fromVersion; v < current; v++) {
            if (_migrations.TryGetValue(v, out var migrate))
                data = migrate(data);  // 逐级升级
        }
        data.Version = current;
        return data;
    }

    // v2 → v3：hp(int) 改名 health 并升级为 float，但旧字段 hp 必须保留兼容
    private static SaveData MigrateV2ToV3(SaveData v2) {
        v2.health = (float)v2.legacy_hp;  // 类型迁移
        // legacy_hp 不删，标记 deprecated，读取时忽略
        return v2;
    }
}
```

**Protobuf 的 Schema 演进规则（天然支持向后兼容）：**

```protobuf
// v1
message PlayerSave {
  int32 id = 1;
  string name = 2;
}

// v2 —— 安全的演进：加字段给默认值，改编号才安全
message PlayerSave {
  int32 id = 1;
  string name = 2;
  int64 coins = 3;       // 新增：旧存档没有 → 读到默认值 0 ✅
  // reserved 4;         // 删掉的字段必须 reserve 编号，防止复用
  // reserved "old_hp";  // 删掉的字段名也 reserve
  float health = 5;      // 用新编号，不覆用旧编号 ✅
}

// ⚠️ 危险操作（会破坏兼容）：
// - 把 int32 改成 int64（用旧编号）→ 旧数据解析错乱
// - 删掉字段不 reserve → 新版本可能复用该编号，数据串台
// - 改变字段编号的含义 → 致命
```

**大存档分块序列化——避免全量读写卡帧：**

```csharp
// 把存档拆成独立 chunk，按需加载/保存，而非一次性全序列化
public class ChunkedSave {
    public int Version;
    public PlayerChunk Player;          // 高频：每次都存
    public InventoryChunk Inventory;    // 中频：物品变化时存
    public WorldChunk World;            // 低频：退出场景时存
    public QuestChunk Quests;           // 中频：任务进度变化时存
}

// 只序列化变化的 chunk，减少 IO 和序列化开销
public async Task SaveChunk<T>(string chunkId, T data) {
    byte[] bytes = MessagePackSerializer.Serialize(data);
    await File.WriteAllBytesAsync($"{SaveDir}/{chunkId}.dat", bytes);
    // 加校验和，防止写入中断导致文件损坏
    await File.WriteAllBytesAsync($"{SaveDir}/{chunkId}.sum", 
                                   ComputeChecksum(bytes));
}
```

### ⚡ 实战经验

- **迁移函数必须幂等**：同一个 v1 存档无论迁移多少次，结果必须完全一致——绝不能在迁移函数里依赖随机数、当前时间或游戏运行时状态
- **永远保留废弃字段的编号/名称**：Protobuf 的 `reserved`、JSON 的忽略字段——一旦复用旧编号，老存档的数据会"串台"到新字段，排查到崩溃
- **存档写入要用临时文件 + 原子替换**：先写 `save.tmp`，校验成功后 `rename` 覆盖 `save.dat`——玩家断电时不会产生写了一半的损坏存档
- **线上游戏的迁移要服务端兜底**：客户端迁移代码可能被篡改，关键经济数据（钻石、货币）的迁移应由服务端验证，不能盲信客户端版本

### 🔗 相关问题

1. Protobuf 和 FlatBuffers 的零拷贝序列化原理是什么？什么场景下值得用 FlatBuffers？
2. 游戏热更新中，旧版本代码序列化的数据怎么和新版本代码兼容？
3. 如何设计存档的校验和与防篡改机制，防止玩家直接编辑存档文件？
