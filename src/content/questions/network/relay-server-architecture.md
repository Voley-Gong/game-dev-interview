---
title: "游戏中继服务器（Relay Server）架构是怎样的？何时该用 Relay 而非 P2P？"
category: "network"
level: 2
tags: ["中继服务器", "Relay", "网络拓扑", "NAT穿透", "TURN"]
related: ["network/nat-traversal", "network/network-topology", "network/p2p-mesh-coop-games"]
hint: "P2P 连不通时怎么办？Relay 服务器只是转发数据包这么简单吗？"
---

## 参考答案

### ✅ 核心要点

1. **Relay 是回退方案**：当 NAT 穿透失败或 P2P 延迟过高时，中继服务器代理转发玩家间的数据
2. **无状态转发**：Relay 服务器只做数据包路由，不运行游戏逻辑，不对包内容做逻辑处理
3. **部署位置关键**：Relay 节点需要靠近玩家群体，通常利用全球 CDN/边缘节点降低附加延迟
4. **成本权衡**：Relay 的带宽和服务器成本由开发商/发行商承担，P2P 则由玩家承担（Host 机器）
5. **混合架构**：现代游戏多采用「先尝试 P2P，失败回退 Relay」的混合模式（类似 ICE 协议）

### 📖 深度展开

#### P2P vs Dedicated Server vs Relay 对比

```
方案A: P2P (Peer-to-Peer)
  Player A ←────────────────→ Player B
            直接连接（NAT穿透成功）

方案B: Dedicated Server (专用服务器)
  Player A ──→ ┌──────────┐ ←── Player B
               │ Game Logic│
               │ Authority │
               └──────────┘
  服务器运行完整游戏逻辑

方案C: Relay Server (中继服务器)
  Player A ──→ ┌──────────┐ ←── Player B
               │  Forward  │
               │  (No Logic)│
               └──────────┘
  服务器只转发，不运行游戏逻辑
```

| 维度 | P2P | Dedicated Server | Relay Server |
|------|-----|-------------------|--------------|
| 服务器成本 | 最低（无） | 最高 | 中等 |
| 附加延迟 | 最低（直连） | 低（就近部署） | 中（多一跳） |
| 实现复杂度 | NAT穿透复杂 | 游戏逻辑服务器化 | 相对简单 |
| 公平性 | Host优势 | 完全公平 | 客户端权威 |
| 反作弊 | 困难 | 容易 | 中等 |
| 断线影响 | Host断=全员断 | 服务器断=全员断 | Relay断可切换 |

#### Relay 服务器的工作流程

```
连接建立流程：

  Client A          Matchmaker          Relay Server          Client B
     │                  │                    │                    │
     ├─ Match Request ─→│                    │                    │
     │                  │←─ Match Request ────────────────────────┤
     │                  │                    │                    │
     │←─ Relay Info ────┤                    │                    │
     │  (relayAddr,     ├─ Relay Info ──────────────────────────→│
     │   sessionId)     │                    │                    │
     │                  │                    │                    │
     ├─ Connect(sess=A)─┼───────────────────→│                    │
     │                  │                    │←─ Connect(sess=B)──┤
     │                  │                    │                    │
     │                  │                    │  绑定 A↔B 到同一路由 │
     │←───────────── 路由就绪 ─────────────────────────────────────┤
     │                   │                    │                    │
     ├═════════════ 游戏数据双向转发 ════════════════════════════════┤
     │                   │                    │                    │
```

#### Relay 实现核心代码（概念）

```cpp
// Relay Server: 每个路由对（Routing Pair）维护两个端点
struct RelayRoute {
    uint32_t sessionId;
    Endpoint clientA;    // Address + Port
    Endpoint clientB;
    uint64_t lastActive;  // 用于超时回收
    uint64_t bytesForwarded;
};

class RelayServer {
    std::unordered_map<uint32_t, RelayRoute> routes_;
    std::unordered_map<Endpoint, uint32_t> endpointToSession_;

public:
    void OnPacketReceived(Endpoint from, const uint8_t* data, size_t len) {
        // 1. 查找该端点所属的路由
        auto it = endpointToSession_.find(from);
        if (it == endpointToSession_.end()) {
            // 可能是新连接请求，交给握手处理
            HandleHandshake(from, data, len);
            return;
        }

        // 2. 找到目标端点并转发
        auto& route = routes_[it->second];
        Endpoint to = (from == route.clientA) ? route.clientB : route.clientA;

        // 3. 可选：限速 / 统计
        route.bytesForwarded += len;
        route.lastActive = Now();

        // 4. 零拷贝转发
        SendTo(to, data, len);
    }

    void HandleHandshake(Endpoint from, const uint8_t* data, size_t len) {
        // 解析 sessionId，绑定端点到路由
        uint32_t sessionId = ParseSessionId(data, len);
        auto& route = routes_[sessionId];

        if (route.clientA.IsEmpty()) {
            route.clientA = from;
        } else if (route.clientB.IsEmpty()) {
            route.clientB = from;
            // 双方都已连接，可以开始转发
            NotifyRouteReady(route);
        }

        endpointToSession_[from] = sessionId;
    }
};
```

#### Relay 的延迟分析

```
P2P 直连延迟:
  A ──── RTT/2 ────→ B     单程延迟 = RTT_direct / 2

Relay 中继延迟:
  A ──── hop1 ────→ Relay ──── hop2 ────→ B
  总单程延迟 = hop1 + hop2

  附加延迟 = (hop1 + hop2) - RTT_direct / 2

  理想情况下 Relay 部署在两人之间的网络路径上：
  hop1 + hop2 ≈ RTT_direct / 2 → 附加延迟 ≈ 0

  最差情况下 Relay 绕路：
  hop1 + hop2 >> RTT_direct / 2 → 附加延迟可达 30-100ms
```

#### 何时选择 Relay？

| 场景 | 推荐方案 | 原因 |
|------|----------|------|
| MOBA / FPS 竞技 | Dedicated Server | 公平性 + 反作弊 |
| 合作 PVE（2-4人） | P2P + Relay 回退 | 成本低，NAT穿透失败时可用 |
| 手游休闲（H5/小程序） | Relay 或 WebSocket Relay | 移动网络NAT复杂，P2P成功率低 |
| 大逃杀（100人） | Dedicated Server | 规模大、需要权威服务器 |
| 格斗游戏（1v1） | P2P + Rollback | 延迟最低，回滚网code补偿 |

#### 现代 Relay 优化技术

1. **边缘 Relay**：利用 Cloudflare Workers / AWS Edge Locations 部署 Relay，降低绕路延迟
2. **Relay 选择算法**：根据两个客户端到各 Relay 节点的 RTT，选择中转延迟最小的节点
3. **UDP Relay 而非 TCP**：游戏数据用 UDP 中继，避免 TCP 队头阻塞
4. **连接迁移**：Relay 维护 sessionId 而非 IP 绑定，客户端网络切换时无缝迁移

### ⚡ 实战经验

- **Relay 不是 Dedicated Server**：很多团队把游戏逻辑塞进 Relay 服务器，导致变成低配版 Dedicated Server。保持 Relay 的纯粹转发职责，游戏逻辑另放
- **超时回收很重要**：玩家断线后 Relay 路由不回收会导致内存泄漏和连接表膨胀。设置 30~60 秒无活动自动回收路由
- **安全审计**：Relay 应验证转发的包格式合法性，不能盲转发。恶意客户端可能利用 Relay 做流量放大攻击
- **云服务商的 GameLift / Agones**：AWS GameLift Relay 和 Google Agones 提供了现成的 Relay + 匹配基础设施，小团队优先考虑而非自建

### 🔗 相关问题

- NAT 穿透（STUN/TURN/ICE）在游戏中的实现细节是什么？
- Dedicated Server 架构下如何降低服务器带宽成本？
- WebRTC Data Channel 的 Relay 机制（ICE Candidate）和传统游戏 Relay 有何区别？
