---
title: "Cocos Creator 游戏存档系统如何设计与实现？"
category: "cocos"
level: 2
tags: ["存档系统", "数据持久化", "存档安全", "架构设计"]
related: ["cocos/asset-encryption-security", "cocos/scene-management"]
hint: "从 localStorage 到加密存档，如何设计一个安全可靠的存档系统？"
---

## 参考答案

### ✅ 核心要点

1. **存储介质选择** → localStorage（Web）/ sys.localStorage（原生）/ File System（原生大文件）
2. **序列化方案** → JSON 为主，复杂数据考虑 Protobuf / MessagePack
3. **存档安全** → 加密（AES/XOR）+ 校验（MD5/SHA）+ 版本迁移
4. **存档架构** → 分离玩家数据、关卡数据、设置数据，支持多存档槽
5. **云同步** → 接入平台 SDK（微信云存储 / 自建服务器同步）

### 📖 深度展开

#### 存储介质对比

| 平台 | 方案 | 容量限制 | 同步性 | 适用场景 |
|------|------|----------|--------|----------|
| Web/H5 | localStorage | 5~10MB | 同步 | 简单存档 |
| Web/H5 | IndexedDB | 几乎无限 | 异步 | 大量数据 |
| 微信小游戏 | wx.setStorageSync | 10MB | 同步 | 小游戏存档 |
| 原生 (iOS) | NSUserDefaults / File | 无限制 | 同步 | 设置/存档 |
| 原生 (Android) | SharedPreferences / File | 无限制 | 同步 | 设置/存档 |

**Cocos 跨平台封装：**

```typescript
// storage-manager.ts — 统一存档管理器
import { sys } from 'cc';

export enum StorageType {
    Local = 'local',       // 本地存储
    Cloud = 'cloud',       // 云端存储
    Hybrid = 'hybrid',     // 本地+云端混合
}

interface SaveData {
    version: number;          // 存档版本号（用于迁移）
    timestamp: number;        // 最后保存时间
    checksum: string;         // 校验和
    data: Record<string, any>; // 实际数据
}

export class StorageManager {
    private static instance: StorageManager;
    private encryptionKey: string = 'game-secret-key';

    static get instance(): StorageManager {
        if (!this.instance) this.instance = new StorageManager();
        return this.instance;
    }

    /** 存储数据（带加密 + 校验） */
    save(key: string, data: any): boolean {
        const saveData: SaveData = {
            version: 1,
            timestamp: Date.now(),
            checksum: '',
            data: data,
        };

        // 1. 序列化
        const jsonStr = JSON.stringify(saveData.data);

        // 2. 计算校验和
        saveData.checksum = this.computeChecksum(jsonStr);

        // 3. 加密
        const encrypted = this.encrypt(
            JSON.stringify(saveData),
            this.encryptionKey
        );

        // 4. 存储
        try {
            sys.localStorage.setItem(key, encrypted);
            return true;
        } catch (e) {
            console.error('存档失败:', e);
            return false;
        }
    }

    /** 读取数据（解密 + 校验） */
    load<T>(key: string): T | null {
        const encrypted = sys.localStorage.getItem(key);
        if (!encrypted) return null;

        try {
            // 1. 解密
            const decrypted = this.decrypt(encrypted, this.encryptionKey);
            const saveData: SaveData = JSON.parse(decrypted);

            // 2. 校验数据完整性
            const expectedChecksum = this.computeChecksum(
                JSON.stringify(saveData.data)
            );
            if (saveData.checksum !== expectedChecksum) {
                console.warn('存档校验失败，数据可能被篡改');
                return null;
            }

            // 3. 版本迁移
            return this.migrate<T>(saveData);
        } catch (e) {
            console.error('读档失败:', e);
            return null;
        }
    }

    private computeChecksum(data: string): string {
        // 简易哈希（生产环境建议用 SHA-256）
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0;
        }
        return hash.toString(16);
    }

    private encrypt(data: string, key: string): string {
        // XOR 加密（演示用，生产环境用 AES）
        let result = '';
        for (let i = 0; i < data.length; i++) {
            result += String.fromCharCode(
                data.charCodeAt(i) ^ key.charCodeAt(i % key.length)
            );
        }
        // Base64 编码（避免特殊字符存储问题）
        return btoa(result);
    }

    private decrypt(data: string, key: string): string {
        const decoded = atob(data);
        let result = '';
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(
                decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length)
            );
        }
        return result;
    }

    /** 存档版本迁移 */
    private migrate<T>(saveData: SaveData): T | null {
        const currentVersion = 1;
        if (saveData.version === currentVersion) {
            return saveData.data as T;
        }

        // 按版本号逐步迁移
        let data = saveData.data;
        // while (data.version < currentVersion) {
        //     data = this.migrateFromVersion(data, data.version);
        // }
        return data as T;
    }

    /** 删除存档 */
    delete(key: string): void {
        sys.localStorage.removeItem(key);
    }

    /** 清空所有存档 */
    clear(): void {
        sys.localStorage.clear();
    }
}
```

#### 多存档槽设计

```typescript
// 多存档槽管理
export class SaveSlotManager {
    private maxSlots = 3;
    private slotPrefix = 'save_slot_';

    // 存档槽元信息（用于 UI 显示）
    getSlotInfo(slotIndex: number): SlotInfo | null {
        const data = StorageManager.instance.load<SaveSlotData>(
            `${this.slotPrefix}${slotIndex}`
        );
        if (!data) return null;

        return {
            slotIndex,
            level: data.playerLevel,
            playTime: data.playTime,
            lastSaveTime: data.lastSaveTime,
            chapter: data.currentChapter,
        };
    }

    // 写入存档槽
    saveToSlot(slotIndex: number, data: SaveSlotData): boolean {
        return StorageManager.instance.save(
            `${this.slotPrefix}${slotIndex}`,
            data
        );
    }

    // 全部存档槽列表
    listAllSlots(): (SlotInfo | null)[] {
        const slots: (SlotInfo | null)[] = [];
        for (let i = 0; i < this.maxSlots; i++) {
            slots.push(this.getSlotInfo(i));
        }
        return slots;
    }
}

interface SlotInfo {
    slotIndex: number;
    level: number;
    playTime: number;        // 游戏时长（秒）
    lastSaveTime: number;    // 最后保存时间戳
    chapter: string;         // 当前章节
}
```

#### 存档架构分层

```
存档系统架构
├── PlayerData（玩家数据）
│   ├── 属性：等级、经验、金币
│   ├── 背包：物品、装备
│   └── 成就：解锁列表、进度
├── LevelData（关卡数据）
│   ├── 星级评价
│   ├── 最快通关时间
│   └── 收集物状态
├── SettingsData（设置数据）
│   ├── 音量、画质、语言
│   └── 按键映射
├── MetaData（元数据）
│   ├── 总游戏时长
│   ├── 登录天数
│   └── 版本号
└── CloudSync（云同步层）
    ├── 上传存档
    ├── 下载存档
    └── 冲突解决
```

#### 微信小游戏云存储同步

```typescript
// 微信小游戏云存储
export class WeChatCloudStorage {
    // 上传存档到微信云
    async upload(key: string, data: any): Promise<boolean> {
        return new Promise((resolve) => {
            wx.setUserCloudStorage({
                KVDataList: [{
                    key: key,
                    value: JSON.stringify(data),
                }],
                success: () => resolve(true),
                fail: () => resolve(false),
            });
        });
    }

    // 从微信云下载存档
    async download(key: string): Promise<any | null> {
        return new Promise((resolve) => {
            wx.getUserCloudStorage({
                keyList: [key],
                success: (res: any) => {
                    const kvList = res.KVDataList || [];
                    const found = kvList.find((kv: any) => kv.key === key);
                    if (found) {
                        resolve(JSON.parse(found.value));
                    } else {
                        resolve(null);
                    }
                },
                fail: () => resolve(null),
            });
        });
    }

    // 云存档冲突解决（本地 vs 云端，选择较新的）
    resolveConflict(local: SaveData, cloud: SaveData): SaveData {
        if (local.timestamp > cloud.timestamp) {
            return local;
        }
        return cloud;
    }
}
```

### ⚡ 实战经验

1. **存档损坏是最常见的线上事故**：玩家清缓存、手机断电、存储空间不足都会导致存档损坏。务必做 **双写备份**（写 `save_slot_0` 的同时写 `save_slot_0_bak`），读取失败时尝试备份
2. **不要存 everything**：临时状态（当前技能 CD、当前 buff 列表）不要存。只存持久化数据，临时状态在加载时重新初始化
3. **存档膨胀问题**：背包里 999 个道具全部序列化？不！只存道具 ID + 数量，用查表方式还原。必要时对存档做 **差分存储**（只存与默认值的差异）
4. **防作弊**：单机游戏的金币、钻石如果纯本地存储，玩家改 localStorage 就能作弊。关键数值必须加密 + 校验，联网验证时做服务端校验

### 🔗 相关问题

- 游戏数据序列化：JSON vs Protobuf vs FlatBuffers 各有什么优劣？
- 如何实现存档的热迁移（玩家不感知的版本升级）？
- 离线 RPG 的防修改方案有哪些？
