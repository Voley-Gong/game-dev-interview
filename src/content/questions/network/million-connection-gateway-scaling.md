---
title: "百万级长连接接入层如何设计？WebSocket/TCP 连接层的水平扩展架构"
category: "network"
level: 3
tags: ["接入层", "长连接", "WebSocket", "水平扩展", "网关"]
related: ["network/gateway-load-balancing", "network/game-server-microservices", "network/connection-state-machine"]
hint: "当同时在线玩家从 1 万增长到 100 万时，网络接入层会遇到哪些瓶颈？如何做水平扩展？"
---

## 参考答案

### ✅ 核心要点

1. **单机长连接上限** 受限于文件描述符（fd）、内存、CPU 中断处理，通常单机 5-20 万连接为实际天花板
2. **接入层与逻辑层分离**：网关层只负责连接管理、协议解析、路由转发；逻辑层无状态处理游戏业务
3. **LB → Gateway Cluster → Logic Cluster** 三层架构是百万连接的标配
4. **Session 粘性**：通过 consistent hashing 或 session registry 保证同一玩家的包路由到同一逻辑服
5. **连接迁移**：网关层故障时，通过 Redis/ZK 共享 session 实现连接平滑迁移

### 📖 深度展开

#### 单机连接数瓶颈分析

```
硬件层面:
  ├── 文件描述符: ulimit -n → 默认 1024，需调至百万级
  ├── TCP 端口范围: ip_local_port_range → 最多 ~65535
  ├── 内存: 每条 TCP 连接 → kernel buffer ~4KB + 应用层 ~8KB
  │           100万连接 ≈ 12GB 内存（仅 buffer）
  ├── CPU: 每包硬中断 → context switch 开销
  └── NIC: 包率上限 / 包大小

软件层面:
  ├── 线程模型: Thread-per-connection → ~5000 上限
  ├── I/O 模型: epoll/kqueue → 单线程管理数十万 fd
  └── 内存池: 避免每连接独立分配 buffer
```

| 优化项 | 默认值 | 百万连接推荐 | 说明 |
|--------|--------|-------------|------|
| `ulimit -n` | 1024 | 1048576 | 文件描述符上限 |
| `net.core.somaxconn` | 128 | 65535 | TCP 全连接队列 |
| `net.ipv4.tcp_max_syn_backlog` | 1024 | 65535 | SYN 队列 |
| `net.ipv4.ip_local_port_range` | 32768-60999 | 1024-65535 | 源端口范围 |
| `net.core.rmem_max` | 212992 | 16777216 | 接收缓冲区上限 |
| `net.ipv4.tcp_tw_reuse` | 0 | 1 | TIME_WAIT 复用 |

#### 架构演进路径

```
阶段1: 单机 (CCU < 5K)
  Player → [LB] → Game Server (逻辑+网络)

阶段2: 网关分离 (CCU < 10万)
  Player → [LB] → [Gateway Cluster] → [Logic Server Cluster]
                         ↓
                    Redis (Session)

阶段3: 多层网关 (CCU < 100万)
  Player → [DNS/L4 LB]
           → [L7 Gateway Cluster (WebSocket/TLS)]
           → [L4 Gateway Cluster (TCP/UDP)]
           → [Logic Server Cluster]
                    ↓
              Redis Cluster (Session + Routing)

阶段4: 全球分布 (CCU > 100万)
  Player → [Anycast / GeoDNS]
           → [Regional Edge Gateway]
           → [Regional Logic Cluster]
           → [Global State Layer (Redis Global + Sharded DB)]
```

#### 网关层设计

```go
// 网关层核心结构：连接管理 + 路由
type Gateway struct {
    sessions    map[uint64]*ClientSession  // 玩家ID → Session
    logicRouter *ConsistentHashRouter       // 一致性哈希路由
    msgQueue    chan *GamePacket            // 消息队列
}

type ClientSession struct {
    PlayerID   uint64
    Conn       net.Conn
    LogicNode  string  // 绑定的逻辑服地址
    GatewayID  string  // 当前网关 ID（用于迁移）
    LastActive int64
}

// 新连接进入
func (g *Gateway) OnConnect(conn net.Conn) {
    // 1. 认证（Token 校验）
    playerID := authenticate(conn)
    
    // 2. 创建 Session
    session := &ClientSession{
        PlayerID:  playerID,
        Conn:      conn,
        LogicNode: g.logicRouter.Get(playerID),  // 一致性哈希
        GatewayID: g.nodeID,
    }
    
    // 3. 注册到 Session Registry（Redis）
    g.sessionRegistry.Set(playerID, session)
    
    // 4. 绑定到逻辑服
    g.bindToLogicServer(session.LogicNode, playerID)
}

// 转发消息到逻辑服
func (g *Gateway) Forward(packet *GamePacket) {
    session := g.sessions[packet.PlayerID]
    if session == nil {
        return  // 未知玩家，丢弃
    }
    g.logicRouter.Send(session.LogicNode, packet)
}
```

#### 负载均衡策略

| 层级 | 方案 | 特点 |
|------|------|------|
| L4 (传输层) | LVS / HAProxy / 云 LB | 按 IP+Port 分发，吞吐高 |
| L7 (应用层) | Nginx / Envoy | 按 URL/Header/Token 分发，灵活 |
| 应用层 | 自研 Gateway + Consistent Hash | 按 PlayerID 粘性路由 |

```nginx
# Nginx WebSocket 长连接配置
upstream game_gateway {
    hash $arg_playerId consistent;  # 一致性哈希
    server gw1.internal:8080 max_fails=3 fail_timeout=10s;
    server gw2.internal:8080 max_fails=3 fail_timeout=10s;
    server gw3.internal:8080 max_fails=3 fail_timeout=10s;
    keepalive 1024;  # 连接池
}

# 连接超时调优
proxy_connect_timeout 5s;
proxy_read_timeout 3600s;    # 长连接不超时
proxy_send_timeout 3600s;
```

#### Session 共享与连接迁移

```
Session Registry (Redis Cluster):
  Key:   session:{player_id}
  Value: { gateway_id, logic_node, room_id, state }
  TTL:   300s (心跳续期)

连接迁移流程:
  1. Gateway-A 故障检测（health check 失败）
  2. LB 摘除 Gateway-A
  3. 客户端检测断线 → 自动重连
  4. 新连接到达 Gateway-B
  5. Gateway-B 从 Redis 恢复 Session
  6. Gateway-B 重新绑定 Logic Server
  7. 客户端补发未确认消息（Sequence Number 续传）

全程耗时: 200ms - 2s（取决于重连策略）
```

#### 心跳与保活

```
客户端 → 网关: Heartbeat (30s 间隔)
网关 → 客户端: Heartbeat ACK (携带服务器时间戳)

网关 → 逻辑服: 玩家在线状态 (5s 间隔批量上报)

空闲检测: 超过 90s 无心跳 → 标记超时 → 优雅关闭
```

### ⚡ 实战经验

1. **不要在网关层做游戏逻辑**：网关层必须轻量，只做协议解析、路由转发、连接管理。把战斗逻辑放在逻辑层，网关层故障重启不影响正在进行的对局（配合断线重连）
2. **连接建立时的安全校验不能省**：Token 校验 + 限频 + 黑名单 + TLS 指纹。缺少这一层会直接被脚本刷爆连接池，一次 CC 攻击就能打满百万 fd
3. **一致性哈希 + 虚拟节点是 session 粘性的最佳实践**：当某个网关节点扩缩容时，只影响 1/N 的连接（N=节点数），而不是全部重连。虚拟节点数建议 150-200
4. **监控核心指标：每网关连接数、连接建立速率、消息转发延迟、CPU/内存使用率**。压测时用 `webbench` 或自研的连接模拟器，模拟 10 万+ 长连接观察单机极限

### 🔗 相关问题

- WebSocket 和原生 TCP 在百万长连接场景下的性能差异有多大？
- 如何实现网关层的零停机部署（Zero-Downtime Deployment）？
- 游戏服务器和 IM/推送系统的长连接架构有什么本质区别？
