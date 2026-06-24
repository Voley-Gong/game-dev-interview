---
title: "跨平台联机（Cross-Play）网络架构如何设计？PC、主机、手机如何互通？"
category: "network"
level: 3
tags: ["Cross-Play", "跨平台", "网络架构", "兼容性", "协议设计", "认证"]
related: ["network/protocol-versioning-compatibility", "network/network-topology", "network/serialization-compression"]
hint: "PC 玩家和手机玩家同服对战，网络协议、账号体系、输入差异——架构怎么扛？"
---

## 参考答案

### ✅ 核心要点

1. **统一协议层**：平台无关的消息格式（Protobuf / FlatBuffers），隔离平台差异
2. **统一账号体系**：跨平台身份映射（Steam ID ↔ PSN ID ↔ Xbox Live ID ↔ QQ OpenID）
3. **版本兼容是最大挑战**：不同平台更新节奏不同，必须做协议版本协商
4. **平台政策限制**：Sony / Nintendo / Microsoft 各有联网认证、聊天、商店限制
5. **输入差异影响公平性**：键鼠 vs 手柄 vs 触屏，可能需要匹配隔离或辅助瞄准

### 📖 深度展开

#### 跨平台联机的网络拓扑

```
                    ┌─────────────────────┐
                    │   Cross-Play        │
                    │   Gateway / Proxy   │
                    └──────┬──────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     ┌──────┴──────┐ ┌────┴─────┐ ┌──────┴──────┐
     │ PC Player   │ │ PS5      │ │ Mobile      │
     │ Steam Auth  │ │ PSN Auth │ │ WeChat Auth │
     │ UDP 60fps   │ │ UDP      │ │ TCP/WSS     │
     │ net 50ms    │ │ net 40ms │ │ net 120ms   │
     └─────────────┘ └──────────┘ └─────────────┘
```

#### 统一身份认证：跨平台账号映射

跨平台联机的第一步是**把不同平台的身份打通**：

```
认证流程：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 客户端向平台 SDK 获取 Token
   - Steam: GetAuthSessionTicket()
   - PSN: ID Token (OAuth 2.0)
   - Xbox: XToken (XSTS)
   - WeChat: Code → access_token

2. 客户端将 Token 发给游戏认证服务器

3. 认证服务器向各平台 backend 验证 Token
   ┌──────────────────────────────────┐
   │  Game Auth Server                │
   │  ├── POST steam/authenticate    │
   │  ├── POST sony/authenticate     │
   │  ├── POST microsoft/authenticate│
   │  └── POST tencent/authenticate  │
   └──────────────────────────────────┘

4. 验证通过后，生成游戏内统一的 SessionToken
   - 将平台账号与游戏角色绑定
   - 后续所有通信使用 SessionToken
```

```cpp
struct PlayerIdentity {
    uint64_t gameId;            // 游戏内唯一 ID
    Platform platform;          // PC / PS5 / Xbox / Mobile
    std::string platformId;     // 平台账号 ID
    std::string sessionToken;   // 统一会话令牌
};

// 跨平台好友系统
class CrossPlatformFriends {
    // 统一好友列表，聚合各平台好友
    std::vector<PlayerIdentity> getFriends(uint64_t gameId) {
        auto friends = std::vector<PlayerIdentity>{};

        // 1. 游戏内好友
        friends += gameDB.getFriends(gameId);

        // 2. 各平台好友（需要各平台 API 权限）
        if (hasSteamPermission(gameId))
            friends += steamBridge.getFriends(gameId);
        if (hasPSNPermission(gameId))
            friends += psnBridge.getFriends(gameId);

        return deduplicate(friends);
    }
};
```

#### 版本兼容设计：渐进式协议升级

不同平台审核周期不同（Steam 1 天、PSN 3-7 天、App Store 1-3 天），**同一时刻不同平台可能运行不同版本**：

```
版本协商握手：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Client → Server: Hello {
    protocolVersion: 5,
    platform: "PS5",
    clientVersion: "1.2.3"
}

Server → Client: Welcome {
    protocolVersion: 5,
    compatibleVersions: [3, 4, 5],   // 服务器兼容的协议版本
    features: ["ranked", "voice"],   // 当前可用功能
    deprecatedFields: ["oldScore"]   // 即将废弃的字段
}
```

**协议设计原则**：

| 原则 | 做法 | 反面教材 |
|------|------|---------|
| **字段可选** | 新增字段默认值，老客户端忽略不认识的字段 | 用固定数组下标访问字段 |
| **版本号嵌入** | 每条消息或每个 session 协商版本 | 假设所有客户端版本一致 |
| **向后兼容** | 新版本能读旧数据，不删字段只标记废弃 | 直接删除旧字段 |
| **前向兼容** | 旧版本能跳过不认识的新字段 | 用硬编码 offset 解析消息 |

```protobuf
// Protobuf 天然支持向前/向后兼容
// 规则：只增不减字段号，optional 标记
message PlayerSnapshot {
    uint32 id        = 1;  // 必须字段
    float  x         = 2;
    float  y         = 3;
    // uint32 old_hp  = 4;  // [已废弃] 不要删，标记 deprecated
    float  shield    = 5;  // 新版本新增
    uint32 skin_id   = 6;  // 新版本新增
    // 老版本客户端读到 5、6 不认识，自动忽略
    // 新版本客户端读老数据，shield 和 skin_id 取默认值
}
```

#### 公平性：输入差异与匹配隔离

```
匹配策略（按公平性敏感程度排列）：

严格隔离（竞技类）：
  → 键鼠池 / 手柄池 / 触屏池  分别匹配
  → 跨平台只有好友组队时才互通

混合匹配（休闲类）：
  → 全平台混合匹配
  → 辅助瞄准（Aim Assist）弥补手柄劣势

输入补偿（FPS 类）：
  → 手柄：开启强力辅助瞄准 + 轻微扩圈
  → 键鼠：无辅助瞄准
  → 触屏：自动射击 + 大幅辅助瞄准
  → 但核心弹道精度相同，保证射击结果一致
```

#### 平台特殊限制速查

| 限制 | Sony (PSN) | Microsoft (Xbox) | Nintendo | Steam | 移动端 |
|------|-----------|-------------------|----------|-------|--------|
| 跨平台通信 | 需审核 | 允许 | 严格审核 | 无限制 | 无限制 |
| 语音聊天 | 需用 PSN API | 需用 Xbox API | 有限支持 | 自由 | 自由 |
| 支付 | 必须走 PSN | 必须走 Xbox | 必须走 eShop | Steam Pay | 苹果/谷歌内购 |
| 数据存储 | 云存档受限 | 云存档受限 | 本地为主 | Steam Cloud | 自行实现 |
| 更新审核 | 3-7 天 | 1-3 天 | 1-2 周 | 即时 | 1-3 天 |

### ⚡ 实战经验

- **协议版本测试矩阵是噩梦**：N 个平台 × M 个版本 = N×M 种组合。建立自动化 CI 跨版本兼容测试，不要靠人肉测
- **热更新是跨平台的救命稻草**：核心逻辑用 Lua / LuaET / JS 热更，绕过平台审核延迟。但 Sony/Nintendo 对热更代码有审查要求
- **认证 Token 续期要做无感**：Token 过期后不要断线重连，用 refresh_token 静默续期，否则跨平台体验极差
- **主机平台的第一方 SDK 坑很深**：PSN 的 Session/Lobby API 和 Xbox Live 的 MPSD 差异巨大，尽早封装抽象层，业务逻辑不直接依赖平台 SDK

### 🔗 相关问题

- 如何设计跨平台的热更新系统，让所有平台同步更新逻辑层？
- 不同平台的网络延迟差异很大（PC 20ms vs Mobile 150ms），匹配和同步策略如何补偿？
- 主机平台对跨平台好友邀请有严格限制，如何设计优雅的好友邀请流程？
