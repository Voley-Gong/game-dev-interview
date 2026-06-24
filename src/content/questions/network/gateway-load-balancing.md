---
title: "游戏服务器的网关层与负载均衡如何设计？百万 CCU 下的流量分发与会话保持"
category: "network"
level: 3
tags: ["网关", "负载均衡", "会话保持", "高并发", "服务器架构", "CCU"]
related: ["network/game-server-microservices.md", "network/matchmaking-room-server.md", "network/protocol-layer-architecture.md"]
hint: "玩家 TCP 长连接不能像 HTTP 那样无状态负载均衡，思考如何做会话保持和网关层水平扩展。"
---

## 参考答案

### ✅ 核心要点

1. **游戏网关（Gateway）是流量入口**：处理 TCP/UDP 长连接的建立、维持、加密、压缩，将逻辑请求转发给后端战斗服/逻辑服
2. **会话保持（Session Affinity）是核心难点**：玩家连接有状态，不能像 HTTP 那样随意路由，需要一致性哈希或专门的 Session Service
3. **负载均衡分两层**：L4（传输层，基于 IP+Port 的流量分发，如 LVS/HAProxy）和 L7（应用层，基于玩家 ID/Room ID 的路由，自研 Gateway）
4. **网关层职责**：连接管理、协议解析、鉴权、限流、加密解密、流量整形、跨服转发
5. **水平扩展靠无状态化**：网关本身无状态（状态存 Redis/Session Service），随时可增减节点，通过服务发现动态注册

### 📖 深度展开

#### 整体架构

```
                        玩家 (TCP/UDP/WebSocket)
                              ↓
                    ┌─────────────────────┐
                    │   L4 Load Balancer   │  ← LVS / Nginx / 云 LB
                    │   (IP+Port 分发)      │     一致性哈希 / 轮询
                    └─────────┬───────────┘
                              ↓
           ┌──────────┬───────┴───────┬──────────┐
           ↓          ↓               ↓          ↓
      ┌─────────┐ ┌─────────┐   ┌─────────┐ ┌─────────┐
      │Gateway 1│ │Gateway 2│   │Gateway 3│ │Gateway N│   ← 无状态网关集群
      │(连接管理)│ │(连接管理)│   │(连接管理)│ │(连接管理)│      可水平扩展
      └────┬────┘ └────┬────┘   └────┬────┘ └────┬────┘
           │           │             │           │
           └─────┬─────┴──────┬──────┘───────────┘
                 ↓            ↓
           ┌──────────┐  ┌──────────┐
           │Session    │  │ Service  │
           │Redis/etcd │  │Registry  │    ← 有状态服务
           └──────────┘  └──────────┘
                 ↓
           ┌──────────┐  ┌──────────┐  ┌──────────┐
           │Battle Srv│  │ Chat Srv │  │ Match Srv│   ← 后端逻辑服务
           │(房间战斗) │  │(社交聊天) │  │(匹配排队) │
           └──────────┘  └──────────┘  └──────────┘
```

#### 网关层的核心职责

| 职责 | 说明 | 关键点 |
|------|------|--------|
| 连接管理 | TCP 三次握手、心跳保活、断线检测 | 单机维持 5-10 万连接（epoll/io_uring） |
| 协议解析 | 解码 Protobuf/FlatBuffers/自定义协议 | 零拷贝，避免反复 alloc |
| 鉴权 | Token 校验、Session 验证 | 首次握手时验，后续缓存 |
| 限流 | 每 User QPS 限制、全局限流 | 令牌桶 / 滑动窗口 |
| 加密解密 | DTLS/AES-GCM 加解密 | 零拷贝 SSL 或硬件加速 |
| 流量整形 | 削峰填谷，防止突发流量打垮后端 | 漏桶 / 分级队列 |
| 跨服路由 | 按玩家/房间路由到正确的 Battle Server | 一致性哈希 / 路由表 |

#### 会话保持方案对比

游戏服务器的会话保持和 Web 领域完全不同——HTTP 是无状态短连接，可以随机路由；游戏是有状态长连接，同一玩家的请求必须路由到同一后端。

| 方案 | 原理 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|---------|
| **源 IP 哈希** | L4 按 Client IP 哈希到固定后端 | 简单，L4 原生支持 | 客户端 IP 变化（NAT/移动网络）导致断连 | 简单页游 |
| **一致性哈希** | 按 Player ID / Session ID 哈希到 Gateway | 节点增减时迁移最小 | 需要在 L7 层实现 | 中大型游戏 |
| **Session Service** | 中心化存储"Player → Gateway"映射 | 精准路由，支持迁移 | 增加一次查询 | 大型 MMO/竞技 |
| **房间亲和路由** | 同房间玩家路由到同一 Battle Server | 减少跨服通信 | 房间迁移复杂 | 房间制游戏 |

#### 一致性哈希实现（网关路由核心）

```python
import hashlib
import bisect

class ConsistentHashRing:
    """一致性哈希环：用于 Gateway → Battle Server 的路由"""

    def __init__(self, virtual_nodes=150):
        self.ring = {}           # hash → server_id
        self.sorted_keys = []    # 排序的 hash 列表
        self.virtual_nodes = virtual_nodes  # 每个实节点的虚拟节点数

    def add_server(self, server_id: str):
        """添加一个 Battle Server 节点"""
        for i in range(self.virtual_nodes):
            key = f"{server_id}#{i}"
            hash_val = int(hashlib.md5(key.encode()).hexdigest(), 16)
            self.ring[hash_val] = server_id
            bisect.insort(self.sorted_keys, hash_val)

    def remove_server(self, server_id: str):
        """移除节点（缩容时）"""
        for i in range(self.virtual_nodes):
            key = f"{server_id}#{i}"
            hash_val = int(hashlib.md5(key.encode()).hexdigest(), 16)
            del self.ring[hash_val]
            self.sorted_keys.remove(hash_val)

    def get_server(self, route_key: str) -> str:
        """根据路由键（player_id / room_id）找到目标服务器"""
        hash_val = int(hashlib.md5(route_key.encode()).hexdigest(), 16)
        idx = bisect.bisect_right(self.sorted_keys, hash_val)
        if idx == len(self.sorted_keys):
            idx = 0
        return self.ring[self.sorted_keys[idx]]

# 使用示例
ring = ConsistentHashRing()
ring.add_server("battle-1")
ring.add_server("battle-2")
ring.add_server("battle-3")

# 同一玩家始终路由到同一服务器
print(ring.get_server("player:10086"))   # → battle-2
print(ring.get_server("player:10086"))   # → battle-2（一致）

# 移除节点后，只有部分流量需要迁移
ring.remove_server("battle-2")
print(ring.get_server("player:10086"))   # → battle-1（迁移到新节点）
```

#### L4 + L7 两层负载均衡的协作

```
# Nginx L4 Stream 配置（TCP 负载均衡）
stream {
    upstream game_gateways {
        hash $remote_addr consistent;  # 源 IP 一致性哈希
        server 10.0.1.1:8888 weight=1;   # Gateway 1
        server 10.0.1.2:8888 weight=1;   # Gateway 2
        server 10.0.1.3:8888 weight=1;   # Gateway 3
        server 10.0.1.4:8888 weight=2;   # Gateway 4（高性能机器）
    }

    server {
        listen 8888;
        proxy_pass game_gateways;
        proxy_timeout 300s;      # 游戏长连接超时要长
        proxy_connect_timeout 5s;
    }
}
```

```go
// Go 实现的自研 L7 Gateway（简化）
type GameGateway struct {
    sessions    sync.Map       // playerID → Session
    battleRing  *HashRing      // Battle Server 一致性哈希环
    redis       *redis.Client  // Session 存储
}

func (gw *GameGateway) HandleConnect(conn net.Conn) {
    // 1. 握手 + 鉴权
    token := readHandshakeToken(conn)
    playerID, err := gw.verifyToken(token)
    if err != nil {
        conn.Close()
        return
    }

    // 2. 创建 Session
    session := &Session{
        PlayerID: playerID,
        Conn:     conn,
        Gateway:  gw.localAddr,
    }

    // 3. 存入 Session Service（Redis）
    gw.redis.HSet(ctx, "session:"+playerID, "gateway", gw.localAddr)

    // 4. 注册到本地 Session 表
    gw.sessions.Store(playerID, session)

    // 5. 开始消息循环
    gw.messageLoop(session)
}

func (gw *GameGateway) RouteMessage(playerID string, msg *GameMessage) {
    switch msg.Type {
    case MsgType_Battle:
        // 战斗消息路由到 Battle Server
        battleServer := gw.battleRing.Get(playerID)
        gw.forwardTo(battleServer, msg)
    case MsgType_Chat:
        // 聊天消息路由到 Chat Server
        gw.forwardTo("chat-cluster", msg)
    case MsgType_Match:
        // 匹配请求路由到 Match Server
        gw.forwardTo("match-cluster", msg)
    }
}
```

#### 百万 CCU 的扩展策略

| CCU 量级 | 架构策略 | 关键瓶颈 |
|---------|---------|---------|
| 1K-10K | 单 Gateway + 单 Battle Server | CPU（逻辑处理） |
| 10K-100K | L4 LB + 5-20 Gateway + 多 Battle | 网关内存、连接数 |
| 100K-500K | L4 LB + 20-50 Gateway + Battle 集群 | Session Service 性能、跨服通信 |
| 500K-1M+ | 多 Region + 每区 L4+L7 + 全局路由 | 跨区延迟、数据一致性 |

### ⚡ 实战经验

- **不要用 Nginx HTTP 负载均衡做游戏网关**：Nginx 的 HTTP 模块是短连接模型，游戏的 TCP 长连接要用 `stream` 模块或专门的 L4 LB（LVS/HAProxy），否则连接数一上来就崩
- **Session Service 用 Redis Cluster 而不是单机 Redis**：网关是无状态的，Session 全靠 Redis 维持，单点 Redis 挂了等于全服掉线。Redis Cluster + Sentinel 保证高可用
- **网关层做限流，不要让流量打到 Battle Server**：Battle Server 是有状态重逻辑服务，一旦过载会导致房间卡顿甚至崩溃。在 Gateway 层用令牌桶对每个玩家做 QPS 限流
- **一致性哈希的虚拟节点数要够大**：默认 150-200 个虚拟节点可以让流量分布均匀。太少会导致某个节点负载远超其他

### 🔗 相关问题

- [游戏服务器微服务架构如何设计？](game-server-microservices.md)
- [跨区域多人游戏如何实现低延迟？](cross-region-edge-deployment.md)
- 游戏网关如何做到平滑扩缩容（不踢掉在线玩家）？
