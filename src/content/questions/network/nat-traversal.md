---
title: "NAT 穿透与 STUN/TURN：如何让两个 NAT 后的玩家直连？"
category: "network"
level: 3
tags: ["NAT穿透", "STUN", "TURN", "P2P", "网络协议", "打洞"]
related: ["network/protocol-selection"]
hint: "两个玩家都在路由器后面，谁都没有公网IP——他们的手机怎么直接连上？"
---

## 参考答案

### ✅ 核心要点

1. **NAT（Network Address Translation）**：路由器将内网 IP 映射到公网 IP，导致外部无法主动发起连接
2. **STUN（Session Traversal Utilities for NAT）**：帮助客户端发现自己的公网映射地址，适用于 Cone NAT 穿透
3. **TURN（Traversal Using Relays around NAT）**：STUN 穿不透时的兜底方案，通过中继服务器转发所有流量
4. **ICE（Interactive Connectivity Establishment）**：一套框架，按优先级依次尝试直连 → STUN 打洞 → TURN 中继
5. **游戏中的实际应用**：P2P 合作游戏（如《双人成行》）依赖 ICE；竞技游戏（FPS/MOBA）通常直接用 Dedicated Server 避免穿透问题

### 📖 深度展开

#### NAT 类型与穿透难度

```
NAT 类型（按穿透难度从易到难）：

1. Full Cone（完全锥形）        → ✅ 最容易穿透
   任何外部主机都可通过映射端口访问内网主机

2. Restricted Cone（限制锥形）   → ✅ 可穿透
   只允许内网主机主动联系过的外部IP回连

3. Port Restricted Cone（端口限制锥形）→ ⚠️ 较难
   只允许内网主机联系过的 外部IP+端口 回连

4. Symmetric NAT（对称型）       → ❌ 无法通过 STUN 穿透
   每个不同目标分配不同映射端口，STUN 发现的地址对第三方无用
```

#### STUN 打洞流程（Cone NAT 场景）

```
        Player A (NAT-A)                    STUN Server                    Player B (NAT-B)
        192.168.1.100                       203.0.113.5                    192.168.0.50
            │                                   │                               │
   ① 请求   ├────── STUN Binding Request ──────→│                               │
            │                                   │                               │
   ② 响应   │←──── Mapped: 155.10.0.1:32000 ────┤                               │
            │                                   │                               │
            │                                   │←──── STUN Binding Request ────┤  ③ 请求
            │                                   │                               │
            │                                   ├───── Mapped: 91.20.0.5:41000→│  ④ 响应
            │                                   │                               │
            │   ⑤ 通过信令服务器交换地址          │                               │
            │←──────── A知道B: 91.20.0.5:41000 ──┤──── B知道A: 155.10.0.1:32000→│
            │                                                                   │
   ⑥ 打洞   ├────── UDP Packet to 91.20.0.5:41000 ─────────────────────────→│  ⑥ 打洞
            │←──── UDP Packet to 155.10.0.1:32000 ──────────────────────────┤
            │                                                                   │
   ⑦ 直连   ├════════════ P2P Direct Connection ══════════════════════════════┤
```

#### TURN 中继流程（Symmetric NAT 兜底）

当 STUN 打洞失败（如双方都是 Symmetric NAT），所有流量通过 TURN 服务器中继：

```
Player A ←════════ TURN Server ←════════ Player B
              中继转发
```

TURN 的代价是延迟增加和带宽成本——服务器需要转发所有游戏数据包。

#### ICE 决策流程

```csharp
// ICE 连接候选收集与优先级排序
public class ICEAgent {
    // 收集所有可能的连接路径
    public List<Candidate> GatherCandidates() {
        var candidates = new List<Candidate>();

        // 1. 主机候选（Host Candidate）：直接使用本地IP
        candidates.Add(new Candidate {
            type = CandidateType.Host,
            address = localIP,  // 192.168.1.100
            priority = 126      // 局域网内最高优先级
        });

        // 2. 服务器反射候选（SRFLX）：通过 STUN 获取公网映射
        var stunAddr = QuerySTUN(stunServer);
        if (stunAddr != null) {
            candidates.Add(new Candidate {
                type = CandidateType.SRFLX,
                address = stunAddr,  // 155.10.0.1:32000
                priority = 100      // P2P 直连，次高优先级
            });
        }

        // 3. 中继候选（RELAY）：通过 TURN 分配
        var turnAddr = AllocateTURN(turnServer);
        candidates.Add(new Candidate {
            type = CandidateType.Relay,
            address = turnAddr,
            priority = 0   // 最兜底方案
        });

        // 按优先级排序后逐个尝试连接
        return candidates.OrderByDescending(c => c.priority).ToList();
    }
}
```

#### 游戏中的选型策略

| 方案 | 延迟 | 成本 | 公平性 | 适用场景 |
|------|------|------|--------|---------|
| P2P 直连（STUN） | ⭐ 最优 | 低 | ❌ 主机优势 | 1v1 格斗、合作游戏 |
| TURN 中继 | ⚠️ 中等 | 高（带宽费） | ✅ 公平 | STUN 失败的兜底 |
| Dedicated Server | ⚠️ 中等 | 最高 | ✅ 最佳 | FPS、MOBA、MMO |
| Relay + Host Authority | 中等 | 中等 | ⚠️ 主机优势 | 吃鸡类大逃杀 |

#### 为什么竞技游戏不用 P2P？

1. **主机优势（Host Advantage）**：P2P 中一个玩家做 Host，他的延迟为 0ms，其他玩家有 30~80ms，竞技游戏中这是巨大不公平
2. **作弊风险**：Host 玩家可以篡改其他玩家的数据包
3. **稳定性差**：Host 玩家断线 = 全房间崩溃
4. **穿透率不够**：约 15%~20% 的 NAT 对组合无法通过 STUN 穿透，需要 TURN 兜底（成本反而更高）

#### 实战架构：WebRTC DataChannel 的游戏 P2P

```javascript
// 浏览器游戏（如 .io 类网页游戏）可以用 WebRTC 实现 P2P
async function createP2PConnection(stunConfig, turnConfig) {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'turn:turn.example.com', credential: 'secret' }
        ]
    });

    // 创建数据通道（游戏数据传输）
    const dc = pc.createDataChannel('game', {
        ordered: false,        // UDP 模式，不保证顺序
        maxRetransmits: 0      // 不重传，减少延迟
    });

    dc.onopen = () => console.log('P2P 直连成功！');
    dc.onmessage = (e) => handleGameData(e.data);

    // ICE 状态监听
    pc.oniceconnectionstatechange = () => {
        console.log(`ICE 状态: ${pc.iceConnectionState}`);
        // connected → 直连/打洞成功
        // failed → 尝试 TURN 或提示重连
    };
}
```

### ⚡ 实战经验

1. **P2P 游戏一定要做 TURN 兜底**——约 20% 的玩家组合 STUN 穿透会失败，不做 TURN 就意味着每 5 个匹配里有一个连不上。TURN 服务器的带宽成本不可省
2. **NAT 保活心跳必须发**——NAT 映射有超时时间（通常 30~120 秒），不发心跳保活映射会过期。游戏推荐 15 秒发一个 4 字节心跳包，既省带宽又不超时
3. **Symmetric NAT 检测要提前做**——在匹配阶段就做 NAT 类型探测，如果双方都是 Symmetric NAT 就直接走 TURN，避免 ICE 反复尝试浪费时间（会明显加长匹配后连接时间）
4. **移动网络的 NAT 更复杂**——运营商级 NAT（CGN/Carrier-Grade NAT）相当于双层 NAT，穿透率极低。手游基本放弃 P2P，直接走 Relay Server

### 🔗 相关问题

- 如果 TURN 服务器也挂了，有没有更经济的中继方案？（提示：自建 Relay 集群、利用云函数做轻量中继）
- WebSocket 游戏如何做 NAT 穿透？和 UDP 有什么不同？
- 为什么 PS5/Xbox 的 P2P 联机体验比 PC 好？（提示：平台级 STUN/TURN 基础设施 + 统一网络栈）
