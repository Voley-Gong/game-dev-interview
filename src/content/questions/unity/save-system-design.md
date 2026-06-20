---
title: "Unity 存档系统如何设计？序列化、加密与版本兼容怎么处理？"
category: "unity"
level: 3
tags: ["存档系统", "序列化", "加密", "版本兼容"]
related: ["unity/jsonutility-serialization-comparison", "unity/serialization-system"]
hint: "存档不仅仅是写文件——序列化格式、数据迁移、加密防篡改都需要考虑"
---

## 参考答案

### ✅ 核心要点

1. **存档格式选择**：JSON（可读、易调试）、BinaryFormatter（已不推荐）、MessagePack/Protobuf（紧凑高效）
2. **存储路径规范**：`Application.persistentDataPath` 是唯一正确的跨平台持久化路径
3. **版本兼容设计**：存档内置版本号 + 迁移链（Migration Chain），支持向前兼容
4. **加密防篡改**：AES 加密存档体 + HMAC 校验完整性，防止玩家手动修改
5. **异步写入策略**：避免主线程卡顿，使用独立线程或协程写入

### 📖 深度展开

#### 存档系统架构总览

```
游戏状态 (Game State)
  ↓ 序列化 (Serialize)
存档数据对象 (Save Data DTO)
  ↓ 版本标记 (Version Tag)
迁移处理器 (Migration) ← 版本号不匹配时触发
  ↓ 加密 (Encrypt)
密文 + HMAC签名
  ↓ 写入 (Write)
Application.persistentDataPath / 云存储
```

#### 存储路径对比

| 平台 | persistentDataPath 实际路径 | 备注 |
|------|---------------------------|------|
| Windows | `%userprofile%\AppData\LocalLow\<company>\<product>` | |
| Android | `/storage/emulated/0/Android/data/<package>/files` | 卸载即清除 |
| iOS | `Library/Caches` 或 `Documents` | iCloud 备份取决于配置 |
| WebGL | 浏览器 IndexedDB | 有容量限制（通常 50MB-1GB） |

> ⚠️ **不要用 `Application.dataPath`**，那是只读资源目录。`Application.streamingAssetsPath` 也只适合打包初始数据。

#### 序列化方案对比

| 方案 | 速度 | 体积 | 可读性 | 安全性 | 推荐度 |
|------|------|------|--------|--------|--------|
| JsonUtility | ⭐⭐⭐⭐ | ⭐⭐⭐ | ✅ | ❌ | 中（不支持Dict/多态） |
| Newtonsoft Json.NET | ⭐⭐⭐ | ⭐⭐⭐ | ✅ | ❌ | 高（功能完善） |
| MessagePack-CSharp | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ❌ | ✅ | 高（极致性能） |
| Protobuf-net | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ❌ | ✅ | 高（跨语言） |
| BinaryFormatter | ⭐⭐ | ⭐⭐ | ❌ | ❌❌ | **禁用**（安全漏洞） |

#### 完整存档系统实现

```csharp
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

// 存档数据结构 —— 使用 [Serializable] 兼容 JsonUtility
[Serializable]
public class SaveData
{
    public int saveVersion = 1; // 版本号，每次结构变更 +1
    public string playerId;
    public int level;
    public float playTime;
    public long saveTimestamp;
    public SerializableDictionary<string, int> inventory;
}

public static class SaveSystem
{
    private const int CURRENT_VERSION = 3;
    private static readonly byte[] AesKey = Encoding.UTF8.GetBytes("32-byte-key-here-for-aes-256!!!"); // 实际从安全配置读取
    private static readonly byte[] AesIV  = Encoding.UTF8.GetBytes("16byte-iv-here!!");

    private static string SavePath => Path.Combine(Application.persistentDataPath, "save.slot");

    // ===== 保存 =====
    public static async void Save(SaveData data)
    {
        data.saveVersion = CURRENT_VERSION;
        data.saveTimestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        string json = JsonUtility.ToJson(data);
        byte[] plainBytes = Encoding.UTF8.GetBytes(json);

        byte[] cipherBytes = AesEncrypt(plainBytes);
        byte[] hmac = ComputeHmac(cipherBytes);

        // 写入：[4字节HMAC长度][HMAC][密文]
        using var fs = new FileStream(SavePath, FileMode.Create, FileAccess.Write);
        await fs.WriteAsync(BitConverter.GetBytes(hmac.Length));
        await fs.WriteAsync(hmac);
        await fs.WriteAsync(cipherBytes);
    }

    // ===== 加载 =====
    public static SaveData Load()
    {
        if (!File.Exists(SavePath)) return null;

        byte[] fileBytes = File.ReadAllBytes(SavePath);

        // 解析 HMAC 和密文
        int hmacLen = BitConverter.ToInt32(fileBytes, 0);
        byte[] storedHmac = new byte[hmacLen];
        byte[] cipherBytes = new byte[fileBytes.Length - 4 - hmacLen];
        Buffer.BlockCopy(fileBytes, 4, storedHmac, 0, hmacLen);
        Buffer.BlockCopy(fileBytes, 4 + hmacLen, cipherBytes, 0, cipherBytes.Length);

        // 完整性校验
        byte[] computedHmac = ComputeHmac(cipherBytes);
        if (!ConstantTimeEquals(storedHmac, computedHmac))
        {
            Debug.LogError("[SaveSystem] 存档已被篡改！");
            return null;
        }

        // 解密 + 反序列化
        byte[] plainBytes = AesDecrypt(cipherBytes);
        string json = Encoding.UTF8.GetString(plainBytes);
        SaveData data = JsonUtility.FromJson<SaveData>(json);

        // 版本迁移
        data = Migrate(data);

        return data;
    }

    // ===== 版本迁移链 =====
    private static SaveData Migrate(SaveData data)
    {
        // v1 → v2: 添加 playTime 字段
        if (data.saveVersion < 2)
        {
            data.playTime = 0f;
            data.saveVersion = 2;
        }
        // v2 → v3: inventory 从 List 改为 Dictionary
        if (data.saveVersion < 3)
        {
            data.inventory = new SerializableDictionary<string, int>();
            data.saveVersion = 3;
        }
        return data;
    }

    // ===== AES 加解密 =====
    private static byte[] AesEncrypt(byte[] plainBytes)
    {
        using var aes = Aes.Create();
        aes.Key = AesKey;
        aes.IV = AesIV;
        using var encryptor = aes.CreateEncryptor();
        return encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);
    }

    private static byte[] AesDecrypt(byte[] cipherBytes)
    {
        using var aes = Aes.Create();
        aes.Key = AesKey;
        aes.IV = AesIV;
        using var decryptor = aes.CreateDecryptor();
        return decryptor.TransformFinalBlock(cipherBytes, 0, cipherBytes.Length);
    }

    // ===== HMAC-SHA256 =====
    private static byte[] ComputeHmac(byte[] data)
    {
        using var hmac = new HMACSHA256(AesKey);
        return hmac.ComputeHash(data);
    }

    private static bool ConstantTimeEquals(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return false;
        int diff = 0;
        for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }
}
```

#### 多存档槽位设计

```csharp
// 槽位管理器 —— 支持多个存档
public class SaveSlotManager
{
    private string GetSlotPath(int slotIndex)
        => Path.Combine(Application.persistentDataPath, $"save_{slotIndex}.slot");

    public SaveData LoadSlot(int slot) { /* ... */ }
    public void SaveSlot(int slot, SaveData data) { /* ... */ }
    public void DeleteSlot(int slot) => File.Delete(GetSlotPath(slot));

    public List<SaveMeta> GetAllSlots()
    {
        var metas = new List<SaveMeta>();
        for (int i = 0; i < MAX_SLOTS; i++)
        {
            if (File.Exists(GetSlotPath(i)))
            {
                var data = LoadSlot(i);
                metas.Add(new SaveMeta
                {
                    slotIndex = i,
                    level = data.level,
                    playTime = data.playTime,
                    timestamp = data.saveTimestamp
                });
            }
        }
        return metas;
    }
}
```

### ⚡ 实战经验

1. **永远不要在 `OnApplicationQuit` 里做大量序列化**——在某些平台（尤其 iOS、Android）这个回调的时间窗口很短，可能写一半就被系统杀掉。正确做法是关键节点自动存档（关卡完成、获得道具等），`OnApplicationQuit` 只做最后的兜底快写。
2. **JsonUtility 不支持 `Dictionary` 和多态类型**——如果存档里有大量字典数据，要么用 Newtonsoft.Json，要么自己实现 `ISerializationCallbackReceiver` 做 List 中转。千万别为了迁就 JsonUtility 去改业务数据结构。
3. **BinaryFormatter 在 .NET 5+ 已被标记为不安全**——存在反序列化漏洞（RCE），微软官方建议永远不要使用。如果老项目还在用，尽快迁移到其他方案。
4. **云存档冲突合并**——多设备云同步时必须处理冲突。常见策略：取时间戳最新的版本；或者做字段级 merge（如金币取较高值、关卡取较高值、道具做并集）。务必在存档里记录 `lastModifiedTime`。

### 🔗 相关问题

- Unity 序列化系统（SerializeReference、ISerializationCallbackReceiver）底层原理是什么？
- 如何实现云存档同步和冲突解决？
- WebGL 平台的存档持久化有哪些坑？
