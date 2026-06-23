---
title: "P2P Mesh 架构在合作游戏（如《双人成行》）中如何实现？与 Dedicated Server 相比有什么优劣？"
category: "network"
level: 3
tags: ["P2P", "Mesh", "网络拓扑", "NAT穿透", "合作游戏"]
related: ["network/network-topology", "network/nat-traversal", "network/host-migration"]
hint: "不是所有游戏都需要 Dedicated Server——2-4 人合作游戏中 P2P Mesh 常常是性价比最高的选择。"
---

## 参考答案

### ✅ 核心要点

1. **P2P Mesh 定义**：每个客户端同时是发送者和接收者，无中心服务器；每帧将自己的状态广播给所有其他 peer，同时接收所有人的状态
2. **适用场景**：2-6 人小规模合作游戏（如《双人成行》《胡闹厨房》《Overcooked》），玩家数量少、延迟容忍度高、成本敏感
3. **NAT 穿透是关键前置**：需要 STUN/TURN/打洞技术建立 peer-to-peer 连接，约 80-90% 的 NAT 类型可直接打洞，剩余需要 Relay（TURN 服务器）
4. **权威性设计**：纯 P2P Mesh 常用 "host migration" 模式——选一个 peer 做 authoritative host，其余为 client；host 掉线则自动迁移
5. **与 Dedicated Server 对比**：成本极低（无需运维服务器）、延迟可能更低（少一跳），但安全性与扩展性是硬伤

### 📖 深度展开

#### P2P Mesh vs Dedicated Server vs Relay

```
┌─────────────────────────────────────────────────────────┐
│              Dedicated Server（专用服务器）              │
│                                                         │
│              ┌──────────┐                               │
│    A ───────→│  Server  │←─────── B                     │
│    C ───────→│          │←─────── D                     │
│              └──────────┘                               │
│  延迟：A→B = RTT(A→Server) + RTT(Server→B)             │
│  成本：高（24/7 服务器）    安全：高（服务器权威）       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              P2P Mesh（全连接网状）                      │
│                                                         │
│          A ←──────→ B                                    │
│          │ ╲       ╱ │                                   │
│          │   ╲   ╱   │                                   │
│          │     ╳     │                                   │
│          │   ╱   ╲   │                                   │
│          │ ╱       ╲ │                                   │
│          C ←──────→ D                                    │
│                                                         │
│  延迟：A→B = RTT(A→B) 直连（最低）                      │
│  连接数：N 人 → N(N-1)/2 条连接（O(N²)）                │
│  成本：近零（仅需 matchmaking 服务器）                   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              Relay / TURN（中继服务器）                  │
│                                                         │
│              ┌──────────┐                               │
│    A ───────→│  Relay   │←─────── B                     │
│              │ (无逻辑) │                               │
│              └──────────┘                               │
│  延迟：同 Dedicated Server，但服务器不跑游戏逻辑          │
│  成本：低（带宽为主）    安全：低（无中心权威）           │
└─────────────────────────────────────────────────────────┘
```

#### 连接数对比

| 玩家数 | P2P Mesh 连接数 | Dedicated Server 连接数 |
|--------|----------------|----------------------|
| 2 | 1 | 2 |
| 4 | 6 | 4 |
| 6 | 15 | 6 |
| 8 | 28 | 8 |
| 16 | 120 | 16 |
| 32 | 496 | 32 |

> **结论**：P2P Mesh 在 ≤8 人时连接数可控，超过 16 人后连接数爆炸式增长，O(N²) 成为主要瓶颈。

#### Host Migration（主机迁移）流程

P2P 游戏最核心的工程挑战——当 host 掉线时，无缝迁移权威到另一个 peer：

```
正常状态：A 是 Host
  A(authoritative) ←→ B(client)
  A(authoritative) ←→ C(client)
  A(authoritative) ←→ D(client)

A 掉线检测（心跳超时 3s）：
  B/C/D 检测到 A 超时
  
Host 选举（Bully / 最低延迟 / 房间创建者优先）：
  B/C/D 互相通信 → 选出 B 为新 Host
  
状态同步：
  B 从最后已知的 A 的状态快照恢复
  C, D 向 B 重新注册
  
恢复完成：
  B(authoritative) ←→ C(client)
  B(authoritative) ←→ D(client)
```

```cpp
enum class HostState {
    CLIENT,
    HOST,
    MIGRATING,   // 迁移中
};

class P2PSessionManager {
    HostState myState = HostState::CLIENT;
    int hostPeerId;
    
    // 心跳超时检测
    float timeSinceHostHeartbeat = 0.0f;
    static constexpr float HOST_TIMEOUT = 3.0f; // 秒
    
    void update(float dt) {
        if (myState == HostState::CLIENT) {
            timeSinceHostHeartbeat += dt;
            if (timeSinceHostHeartbeat > HOST_TIMEOUT) {
                initiateHostMigration();
            }
        }
    }
    
    void initiateHostMigration() {
        myState = HostState::MIGRATING;
        
        // 选举策略：peer ID 最小的成为新 host
        // 也可用 RTT 最低 / CPU 性能最好等策略
        int newHostId = INT_MAX;
        for (auto& [peerId, conn] : connections) {
            if (peerId < newHostId && peerId != hostPeerId) {
                newHostId = peerId;
            }
        }
        
        if (newHostId == myPeerId) {
            // 我被选为新 Host
            becomeHost();
        } else {
            // 等待新 Host 的 announcement
            waitForNewHost(newHostId);
        }
    }
    
    void becomeHost() {
        myState = HostState::HOST;
        // 从最后快照恢复世界状态
        restoreFromSnapshot(lastKnownHostSnapshot);
        // 通知所有 peer
        broadcastHostAnnouncement();
    }
};
```

#### NAT 穿透建立 P2P 连接

```cpp
// P2P 连接建立流程
void establishP2PConnection(PeerInfo& remote) {
    // 1. 通过 STUN 获取自己的公网地址
    auto myPublic = stunServer.getMyPublicAddress();
    
    // 2. 通过 matchmaking 服务器交换 candidate 地址
    //    （类似 WebRTC 的 ICE 交换）
    exchangeCandidatesViaSignaling(remote);
    
    // 3. 尝试 UDP 打洞（Hole Punching）
    //    同时向对方公网地址发包，在 NAT 上打洞
    bool connected = tryUDPHolePunching(remote.publicAddr);
    
    if (!connected) {
        // 4. 打洞失败（Symmetric NAT），回退到 TURN Relay
        connectViaTURN(remote);
    }
}
```

#### 各 NAT 类型打洞成功率

| NAT 类型 | 打洞成功率 | 说明 |
|---------|-----------|------|
| Full Cone | ~100% | 最宽松，任意外部可连 |
| Restricted Cone | ~90% | 需先向目标发包"开洞" |
| Port Restricted | ~80% | 需精确端口匹配 |
| Symmetric NAT | ~10% | 每目标不同端口，几乎无法打洞 |
| UDP Blocked | 0% | 防火墙禁止 UDP |

> **现实数据**：约 80% 的家用 NAT 为 Cone 类型可以打洞，15% 为 Symmetric 需要 TURN 中继，5% 完全阻止 UDP。

#### 各方案综合对比

| 维度 | Dedicated Server | P2P Mesh | Relay |
|------|-----------------|----------|-------|
| 服务器成本 | ⭐⭐⭐⭐⭐ 最高 | ⭐ 最低 | ⭐⭐⭐ 中等 |
| 延迟 | ⭐⭐⭐ 中（多一跳） | ⭐⭐⭐⭐⭐ 最低（直连） | ⭐⭐ 中 |
| 安全/反作弊 | ⭐⭐⭐⭐⭐ 强 | ⭐ 弱 | ⭐⭐ 弱 |
| 扩展性 | ⭐⭐⭐⭐⭐ 好 | ⭐⭐ 差（O(N²)） | ⭐⭐⭐ 中 |
| 实现复杂度 | ⭐⭐⭐ 中等 | ⭐ 复杂（NAT/Migration） | ⭐⭐ 较低 |
| 适用游戏 | 竞技/MMO/大逃杀 | 合作/派对/休闲 | 跨平台对战 |

### ⚡ 实战经验

1. **Host 选举别只看 peer ID**：最理想的 host 是网络拓扑中心（到所有人 RTT 最低）+ 硬件性能最好。实测表明选对 host 可将全玩家平均延迟降低 30-50ms
2. **状态快照频率决定迁移体验**：非 host 端也应保留一份 host 的状态快照（即使不权威），每 1-2 秒更新一次。Host 掉线后从快照恢复，迁移时间可控制在 2-3 秒内
3. **TURN Relay 不能省**：即使打洞成功率高，也必须部署 TURN 服务器作为兜底。否则 Symmetric NAT 的玩家直接无法游戏，导致差评轰炸。TURN 带宽成本通常比想象中低（只有少数用户需要）
4. **帧同步 + P2P = 天然搭配**：Lockstep 帧同步只需要传播玩家输入（几字节/帧），P2P Mesh 的 O(N²) 连接在 4 人 60fps 下总带宽约 4×3×60×8 = 5.7 KB/s，完全无压力

### 🔗 相关问题

- P2P 游戏如何防止恶意 host 伪造游戏状态？最低限度的反作弊方案是什么？
- WebRTC Data Channel 能否替代原生 UDP 实现 P2P Mesh？它帮我们处理了哪些问题？
- 在 Switch / PlayStation 等主机平台上，P2P 连接有哪些平台级限制？
