---
title: "游戏网络拓扑有哪些模式？Dedicated Server、P2P、Relay、Mesh 怎么选？"
category: "network"
level: 2
tags: ["网络架构", "Dedicated Server", "P2P", "Relay", "网络拓扑"]
related: ["network/server-authority-vs-client-trust", "network/matchmaking-room-server"]
hint: "从权威性、延迟、成本、可扩展性四个维度对比四种拓扑模式"
---

## 参考答案

### ✅ 核心要点

1. **Dedicated Server（专用服务器）**：独立服务器跑权威模拟，公平且反作弊强，竞技游戏标配
2. **Listen Server（主机即服）**：一个玩家兼做服务器，成本低但有主机优势（Host Advantage）
3. **Relay / Proxy（中继服务器）**：服务器只转发数据不做模拟，适合跨地区组网和 NAT 穿透辅助
4. **Full Mesh / P2P（端对端直连）**：所有客户端互相直连，延迟最低但连接数 O(n²)，仅适合 ≤4 人小局
5. **选型关键**：竞技公平性 > 成本 → Dedicated；快速开黑 > 公平性 → Listen/Relay；人数 ≤4 且无服务器 → Mesh

### 📖 深度展开

#### 四种拓扑模式对比

| 维度 | Dedicated Server | Listen Server | Relay Server | Full Mesh |
|------|-----------------|---------------|--------------|-----------|
| 权威节点 | 独立服务器 | 主机玩家 | 无（仅转发） | 各客户端各自权威 |
| 服务器成本 | 高（需租用/自建） | 无 | 中（轻量转发） | 无 |
| 典型延迟 | 中（到服务器往返） | 主机极低，其他较高 | 中高（多一跳） | 最低（直连） |
| 公平性 | ✅ 完全公平 | ❌ 主机优势 | ✅ 公平（纯转发） | ❌ 各玩家间延迟不同 |
| 反作弊 | ✅ 强（服务端权威） | ❌ 弱（主机可篡改） | ⚠️ 中（需额外验证） | ❌ 弱（无中心权威） |
| 连接数/人 | 1（C→S） | 1（C→Host） | 1（C→R） | N-1（与所有人连） |
| 适用人数 | 不限 | 2-16 | 2-32 | 2-4 |
| 断线影响 | 服务器断=全员断 | 主机断=全房断 | Relay 断需切换 | 一人断=少一人，局继续 |

#### 架构图

**1. Dedicated Server（专用服务器）**

```
         ┌──────────────┐
         │  Game Server │  ← 跑完整游戏模拟
         │  (权威状态)   │
         └──────┬───────┘
        ┌───────┼───────┐
        │       │       │
     Player1 Player2 Player3
```

- 所有客户端连到独立服务器
- 服务器跑游戏逻辑，拥有权威状态
- 客户端只发送输入，接收状态快照
- **代表**：CS:GO、Valorant、League of Legends

**2. Listen Server（主机即服）**

```
         ┌──────────────┐
         │  Host Player │  ← 既是玩家也是服务器
         │  (Server+Client)│
         └──────┬───────┘
           ┌────┼────┐
           │    │    │
        Player2 Player3
```

- 一个玩家同时运行客户端和服务器逻辑
- 其他玩家连到主机玩家
- **主机优势**：主机延迟为 0，其他玩家有网络延迟
- **代表**：Minecraft 联机、Don't Starve Together、很多合作游戏

**3. Relay Server（中继服务器）**

```
         ┌──────────────┐
         │  Relay Server│  ← 只做数据转发，不跑游戏逻辑
         │  (无状态)     │
         └──────┬───────┘
        ┌───────┼───────┐
        │       │       │
     Player1 Player2 Player3
```

- 服务器只负责在玩家之间转发消息
- 游戏逻辑由某个客户端（或分布式）跑
- **用途**：NAT 穿透失败时的回退方案；跨地区低延迟中转
- **代表**：很多 P2P 游戏的"快速匹配"底层其实是 Relay

**4. Full Mesh（全网状互连）**

```
     Player1 ←──→ Player2
        ↕           ↕
     Player3 ←──→ Player4
```

- 每个客户端与所有其他客户端建立直连
- 连接数 = N × (N-1) / 2（组合爆炸）
- 4 人 = 6 连接，8 人 = 28 连接，16 人 = 120 连接
- **代表**：格斗游戏（2人）、Splatoon 局域网模式

#### 连接数增长对比

```
人数 │ Dedicated │ Listen │ Relay │ Full Mesh
─────┼──────────┼────────┼───────┼──────────
  2  │    2     │   1    │   2   │    1
  4  │    4     │   3    │   4   │    6
  8  │    8     │   7    │   8   │   28
 16  │   16     │  15    │  16   │  120
 32  │   32     │  31    │  32   │  496 (!)
```

> Full Mesh 在 8 人以上就不可行了，连接数和维护成本爆炸。

#### 现代混合架构：Dedicated + Edge Relay

大型竞技游戏通常采用**边缘计算 + 专用服务器**的混合方案：

```
                    ┌─────────────────┐
                    │  Matchmaking /  │
                    │  Room Service   │     ← 中央调度（匹配、房间管理）
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────┴───┐  ┌───────┴───┐  ┌──────┴────┐
     │ Edge DC #1 │  │ Edge DC #2│  │ Edge DC #3│   ← 边缘机房
     │ (Tokyo)    │  │(Singapore)│  │(Mumbai)   │     就近接入
     │ DS实例×N   │  │ DS实例×N  │  │ DS实例×N  │
     └────────────┘  └───────────┘  └───────────┘
```

- 匹配服务器在全球调度，把玩家分配到最近的 Edge DC
- 每个 Edge DC 运行多个 Dedicated Server 实例
- 玩家 RTT 通常 < 50ms（同区域）
- **代表**：Valorant（Riot 的全球服务器部署）、Fortnite（Epic 的矩阵机房）

#### 代码示例：连接管理器

```csharp
// 根据拓扑模式创建不同的网络连接
public enum NetworkTopology { Dedicated, ListenServer, Relay, Mesh }

public class ConnectionManager : MonoBehaviour
{
    public NetworkTopology topology;

    void StartHost()
    {
        switch (topology)
        {
            case NetworkTopology.Dedicated:
                // 连接到远程专用服务器
                ConnectToDedicated(serverIp, serverPort);
                break;

            case NetworkTopology.ListenServer:
                // 自己开服 + 自己进服
                NetworkServer.Listen(maxPlayers: 16);
                NetworkClient.Connect("127.0.0.1", serverPort);
                break;

            case NetworkTopology.Relay:
                // 连接到 Relay，由 Relay 转发到其他玩家
                ConnectToRelay(relayUrl, roomId);
                break;

            case NetworkTopology.Mesh:
                // 与所有已知的 peer 直连
                foreach (var peer in knownPeers)
                    DirectConnect(peer.ip, peer.port);
                break;
        }
    }
}
```

### ⚡ 实战经验

- **竞技游戏无脑选 Dedicated Server**：主机优势是公平性毒药，哪怕 30ms 的差异在 FPS 中也能感知。Valve 和 Riot 都证明了这一点
- **Listen Server 适合合作/PVE**：不想花钱租服务器的独立游戏首选，配合 Migration（主机迁移）可以在主机断线时转移服务器角色
- **Relay 不是"低端"方案**：很多看起来像 P2P 的商业游戏底层是 Relay。Relay 比 P2P 更稳定（NAT 穿透成功率不是 100%），比 Dedicated 便宜（不做模拟）
- **Mesh 只在 2-4 人时考虑**：格斗游戏（2P）用 Mesh 是完美的——延迟最低、无需服务器、确定性帧同步

### 🔗 相关问题

- 如何实现 Listen Server 的主机迁移（Host Migration）？
- Dedicated Server 如何做容量规划和弹性扩缩容？
- Relay Server 和 TURN Server 有什么区别？什么时候用哪个？
