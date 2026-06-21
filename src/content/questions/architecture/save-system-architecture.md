---
title: "如何设计一个健壮的游戏存档系统？需要考虑哪些维度？"
category: "architecture"
level: 3
tags: ["存档系统", "序列化", "持久化", "版本迁移", "架构设计", "数据安全"]
related: ["architecture/event-driven-vs-data-driven", "architecture/scriptableobject-architecture"]
hint: "存档不止是「写个 JSON」——版本兼容、损坏恢复、防篡改、异步不卡帧、多槽位管理，每一个都是生产事故的高发地。"
---

## 参考答案

### ✅ 核心要点

1. **序列化格式选型**：JSON（可读、易调试）/ 二进制（紧凑、防窥）/ Protobuf（跨平台、Schema 演进友好）按需求取舍，大型项目常混合使用（玩家存档二进制、配置 JSON）。
2. **版本兼容与迁移**：每个存档必须带 `schemaVersion`，加载时按版本号执行迁移链（v1→v2→v3），保证老玩家不丢档。
3. **原子写入防损坏**：写入时先写临时文件（`.tmp`），成功后原子 rename 覆盖目标文件，避免写到一半崩溃导致存档损坏。
4. **防篡改与完整性校验**：关键字段加密（AES）+ 全文校验和（HMAC-SHA256），防止玩家手改存档刷金币；云端存档还要防重放。
5. **异步分片不卡帧**：大存档（MB 级）序列化和写盘放到子线程，主线程只做内存快照，避免存档瞬间掉帧。

### 📖 深度展开

**1. 存档数据模型设计**

```csharp
// 存档根结构 —— 必须带版本号、时间戳、校验信息
[Serializable]
public class SaveFile {
    public int schemaVersion;        // Schema 版本，迁移用
    public long saveTimestamp;       // 存档时间戳
    public string playerId;
    public PlayerData player;        // 玩家核心数据
    public WorldState world;         // 世界/关卡状态
    public List<string> unlockedAchievements;
    // 校验与加密在「包装层」处理，不进这个结构
}

[Serializable]
public class PlayerData {
    public int level;
    public long exp;
    public Vector3Ser position;      // 用可序列化的包装类型
    public InventoryData inventory;
    public Dictionary<string, int> flags; // 任务/剧情标记
}
```

**2. 写入流程：原子写 + 校验**

```
存档写入流程（防损坏核心）：

  ① 内存中序列化 → byte[]
  ② 计算 HMAC-SHA256(payload + secretKey) → checksum
  ③ 加密 payload（AES-CBC，key 派生自设备指纹）
  ④ 写入临时文件 save.json.tmp
  ⑤ fsync（确保落盘，非 OS 缓存）
  ⑥ 原子 rename: save.json.tmp → save.json
       （rename 在同文件系统内是原子的，崩溃也不会半写）

崩溃场景分析：
  - 写 .tmp 中途崩溃 → .tmp 不完整，原 save.json 完好 ✓
  - rename 中途崩溃 → 极少数 OS 下可能丢失，启动时检测 .tmp 残留并清理
  - rename 完成后崩溃 → 新存档完整 ✓
```

```csharp
public async Task SaveAsync(SaveFile data) {
    string json = JsonSerializer.Serialize(data);
    byte[] payload = Encoding.UTF8.GetBytes(json);

    // ① 校验和 ② 加密
    string checksum = HmacSha256(payload, _secretKey);
    byte[] encrypted = AesEncrypt(payload, _key);

    // ③ 写临时文件 ④ fsync ⑤ 原子 rename
    string tmpPath = SavePath + ".tmp";
    await File.WriteAllBytesAsync(tmpPath, encrypted);
    _fsync(tmpPath); // 关键：强制刷盘
    File.Move(tmpPath, SavePath); // rename，原子操作
}
```

**3. 版本迁移链（最容易被忽视的灾难源）**

每次发版加字段，老存档加载时缺少新字段 → NullRef。必须实现迁移链：

```csharp
// 迁移注册表：每个版本一个迁移函数
private static readonly Dictionary<int, Action<SaveFile>> _migrations = new() {
    { 1, MigrateV1ToV2 },  // v1 → v2：加了 stamina 字段
    { 2, MigrateV2ToV3 },  // v2 → v3：inventory 结构重构
    { 3, MigrateV3ToV4 },  // v3 → v4：flags 从 List 改成 Dict
};

public SaveFile LoadAndMigrate(byte[] raw) {
    var save = DecryptAndDeserialize(raw);
    int current = SaveSchema.LATEST; // 当前版本，如 4
    while (save.schemaVersion < current) {
        int v = save.schemaVersion;
        if (!_migrations.ContainsKey(v))
            throw new UnsupportedSaveVersion(v);
        _migrations[v](save);      // 依次执行迁移
        save.schemaVersion = v + 1;
    }
    return save; // 现在是最新版本
}
```

```
v1 存档  →  migrate(1→2)  →  migrate(2→3)  →  migrate(3→4)  →  可用
（绝不跳级迁移，保证每个迁移函数只处理「上一版→当前版」的增量）
```

**4. 序列化格式对比**

| 维度 | JSON | 二进制（BinaryFormatter） | Protobuf | MessagePack |
|------|------|--------------------------|----------|-------------|
| 可读性 | ✅ 强 | ❌ | ❌ | ❌ |
| 体积 | 大 | 中 | 小 | 小 |
| 解析速度 | 慢 | 中 | 快 | 快 |
| Schema 演进 | 手动迁移 | ⚠️（已不推荐，安全漏洞） | 字段编号天然兼容 | 类似 Protobuf |
| 跨语言 | ✅ | ❌（C# 专属） | ✅ | ✅ |
| 防窥探 | ❌ 明文 | 弱 | 弱 | 弱 |
| 适用 | 配置/调试 | 老项目 | 跨端存档 | 高性能存档 |

> ⚠️ `BinaryFormatter` 在 .NET 5+ 已被标记为不安全（反序列化 RCE 漏洞），新项目禁用。

### ⚡ 实战经验

- **永远别信任客户端存档**：单机游戏也要做服务端校验或至少本地校验和——玩家改存档刷道具是高发问题，关键字段加密 + HMAC 是底线。
- **多槽位 + 自动备份最近 N 版**：保留最近 3 个版本的存档备份（`save.json.bak1/bak2/bak3`），存档损坏时可回滚。这是玩家投诉「丢档」时唯一的救命稻草。
- **跨平台路径用 `persistentDataPath`**：别硬编码路径，Steam/Epic/iOS/Android 各不相同；云存档还要处理多设备同步冲突（最后写入胜出 or 字段级合并）。
- **序列化闭坑**：Unity 的 `Vector3`、`Color` 等部分类型 JSON 序列化行为不一致，建议封装成 `[Serializable]` 的纯字段结构（`Vector3Ser { float x,y,z }`）；避免循环引用，否则会无限递归栈溢出。
- **存档时机要克制**：每次小改动（捡个金币）就写盘会磨损闪存且卡帧——用「脏标记 + 定时落盘（如每 60 秒）+ 关键节点（通关/退出）强写」组合策略。

### 🔗 相关问题

- 玩家在两台设备上同时玩了同一个存档，云存档冲突如何解决？
- 如何设计一个支持「回退到任意历史存档点」的版本化存档系统（类似 Git for saves）？
- 大世界开放游戏的存档（位置 + 几千个 NPC 状态 + 几万个物品）如何控制存档体积和加载时间？
