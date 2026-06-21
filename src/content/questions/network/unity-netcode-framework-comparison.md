---
title: "Unity 网络框架 Mirror、Photon、FishNet、Netcode for GameObjects 如何选型对比？"
category: "network"
level: 2
tags: ["Unity", "网络框架", "Mirror", "Photon", "FishNet", "Netcode"]
related: ["network/protocol-selection", "network/server-authority-vs-client-trust", "network/network-topology"]
hint: "从授权模式、传输层、同步模型、社区生态、适用项目规模五个维度做横向对比。"
---

## 参考答案

### ✅ 核心要点

1. **Netcode for GameObjects (NGO)**：Unity 官方开源框架，服务器权威模型，免费无限制，适合中小型项目和团队入门
2. **Mirror**：Unet 社区继承者，开源免费，API 简洁，社区生态丰富，适合中大型独立项目和服务端权威游戏
3. **Photon (PUN2 / Fusion)**：商业化方案，提供托管服务器 + Relay，开箱即用，适合快速上线但按 MAU/CCU 收费
4. **FishNet**：新一代开源框架，面向性能设计，支持模块化传输层和高级同步，适合对性能和灵活性要求高的项目
5. **选型核心维度**：授权模式（免费/付费）、托管 vs 自建服务器、同步策略（状态/帧/混合）、社区与文档、性能要求

### 📖 深度展开

#### 框架横向对比表

| 维度 | NGO (Unity 官方) | Mirror | Photon Fusion | FishNet |
|------|------------------|--------|---------------|---------|
| 授权 | 免费开源 (MIT) | 免费开源 (MIT) | 商业付费（按 CCU） | 免费开源 (MIT) |
| 传输层 | Unity Transport (TCP/UDP) | 多传输（Telepathy/KCP/SimpleWebTransport等） | Photon Cloud (UDP/WebSocket) | 多传输（含 Tugbird/KCP/Steamworks等） |
| 服务器模型 | Dedicated Server | Dedicated Server / Host | Cloud / Self-Hosted / P2P | Dedicated / Host |
| 同步模型 | 状态同步（NetworkTransform） | 状态同步 + RPC | 状态同步 + 预测 + 插值 | 状态同步 + 高级预测 |
| 客户端预测 | 基础（ClientNetworkedTransform） | 需自行实现 | 内置高级预测/调和 | 内置预测/平滑模块 |
| WebGL 支持 | 有限（WebSocket） | 支持（SimpleWebTransport） | 原生支持 | 支持 |
| 文档质量 | 中等（改善中） | 优秀（社区驱动） | 优秀（商业维护） | 良好（持续完善） |
| 适用规模 | 小型 ~ 中型 | 小型 ~ 中大型 | 小型 ~ 大型（FPS/MOBA） | 中型 ~ 大型 |
| 学习曲线 | 低 ~ 中 | 低 | 中（概念较多） | 中 ~ 高 |

#### 架构模式对比

```
┌─────────────────────────────────────────────────────┐
│                  Photon Fusion 架构                   │
│                                                       │
│  Client ←→ Photon Cloud (Name Server + Game Server)  │
│           无需自建服务器，按量付费                      │
│  优势: 快速上线、全球 Relay、自动扩容                   │
│  劣势: 费用随 CCU 增长、定制性受限、数据不在自己手里     │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              Mirror / FishNet 架构                    │
│                                                       │
│  Client ←→ 自建 Dedicated Server (Linux/Docker)      │
│           完全自主可控，需要运维能力                    │
│  优势: 免费、完全定制、数据自主                         │
│  劣势: 服务器运维成本、Relay 需自行搭建                 │
└─────────────────────────────────────────────────────┘
```

#### 代码风格对比：同步一个变量

```csharp
// === NGO (Netcode for GameObjects) ===
public class PlayerHealth : NetworkBehaviour {
    private NetworkVariable<int> health = new(100);
    void Update() {
        if (IsServer) health.Value -= 1; // 服务器权威修改
    }
}

// === Mirror ===
public class PlayerHealth : NetworkBehaviour {
    [SyncVar] int health = 100;
    [Server] public void TakeDamage(int dmg) {
        health -= dmg; // [Server] 标记确保只在服务端执行
    }
}

// === Photon Fusion ===
public class PlayerHealth : NetworkBehaviour {
    [Networked] int Health { get; set; }
    public override void FixedUpdateNetwork() {
        if (Object.HasStateAuthority) Health -= 1; // 状态权威
    }
}

// === FishNet ===
public class PlayerHealth : NetworkBehaviour {
    [SyncVar] private int _health = 100;
    [ServerRpc]
    private void TakeDamage(int dmg) { _health -= dmg; }
}
```

#### 选型决策流程

```
项目需求分析
    │
    ├── 预算有限 + 开源优先？
    │     ├── Unity 项目 → Mirror（生态成熟）或 NGO（官方背书）
    │     └── 高性能需求 → FishNet
    │
    ├── 需要快速上线 + 不想运维？
    │     └── Photon Fusion（托管服务器 + 全球 Relay）
    │
    ├── 需要完全控制 + 大规模 MMO？
    │     └── 自研 + Mirror/FishNet 底层 + 自定义传输
    │
    └── WebGL / H5 游戏？
          └── Photon（WebSocket 原生支持最好）
```

### ⚡ 实战经验

- **Mirror 的 SyncVar 序列化效率需注意**：大量 SyncVar 同步会占用带宽，对高频变化数据考虑使用 `SyncList` + Delta 或自定义序列化
- **Photon Fusion 的 State Authority vs Input Authority 概念需理解透彻**：它不是传统意义的 Server Authority，弄混会导致预测/调和逻辑写反
- **NGO 的性能在大型项目上需自行补充**：缺少内置客户端预测，FPS/动作类游戏需自己实现预测/调和层
- **FishNet 虽新但迭代快**：API 变动频率高于 Mirror，生产项目需锁定版本并关注 Release Notes

### 🔗 相关问题

- 如何评估一个网络框架是否支持「服务器权威 + 客户端预测」？
- Mirror 从 Unet 迁移的兼容性如何？遗留 Unet 项目能平滑迁移吗？
- Photon Quantum 和 Photon Fusion 的区别？帧同步 vs 状态同步在 Photon 生态中怎么选？
