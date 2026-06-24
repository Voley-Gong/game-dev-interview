---
title: "游戏服务器如何防御 DDoS 攻击？L3/L4/L7 多层防护架构详解"
category: "network"
level: 3
tags: ["DDoS", "网络安全", "游戏服务器", "SYN Flood", "反向代理", "高可用", "面试高频"]
related: ["network/packet-encryption-anti-replay", "network/anti-cheat-detection", "network/network-topology"]
hint: "开服首日被 200Gbps UDP Flood 打瘫，如何在不影响正常玩家的情况下扛住？"
---

## 参考答案

### ✅ 核心要点

1. **多层防御**：L3/L4（网络层）过滤 + L7（应用层）限流 + 业务层验证，纵深防御
2. **流量清洗**：ISP/云清洗中心 → Anycast IP 分散流量 → BGP 黑洞路由丢弃恶意流量
3. **游戏特有协议过滤**：基于协议特征（包大小、频率、握手流程）区分合法游戏流量和攻击流量
4. **弹性扩缩容**：Game Server 无状态化 + 动态负载均衡，遇攻击时水平扩展吸收流量
5. **连接级防护**：SYN Cookie、Challenge-Response 握手、每连接速率限制

### 📖 深度展开

#### 攻击类型与防御层次

```
攻击层级          攻击方式                 防御手段
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
L3 (网络层)      ICMP Flood              │ Anycast 吸收
                 Smurf Attack            │ ISP 清洗中心
                                         │
L4 (传输层)      SYN Flood               │ SYN Cookie
                 UDP Flood               │ 速率限制
                 Amplification (DNS/NTP) │ 协议白名单
                                         │
L7 (应用层)      HTTP Flood              │ Challenge 握手
                 Slowloris               │ 连接超时
                 Game Protocol Abuse     │ 行为分析
                                         │
业务层           虚假注册/登录            │ CAPTCHA + 设备指纹
                 匹配系统滥用             │ 频率限制 + 信誉系统
```

#### 游戏服务器 DDoS 防护架构

```
                    Internet
                       │
              ┌────────▼────────┐
              │  Anycast Network │  ← 流量分散到最近节点
              │  (Cloudflare /   │
              │   AWS Shield)    │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  流量清洗中心    │  ← 大流量攻击在此过滤
              │  (Scrubbing)     │
              └────┬───────┬────┘
                   │       │
          ┌────────▼┐  ┌──▼────────┐
          │  L4 负载 │  │  反向代理  │  ← SYN Cookie
          │  均衡器  │  │  (Proxy)   │     连接限制
          └────┬────┘  └────┬──────┘
               │            │
     ┌─────────▼────────────▼─────────┐
     │       Game Server Cluster       │
     │  ┌──────┐ ┌──────┐ ┌──────┐   │
     │  │ GS-1 │ │ GS-2 │ │ GS-3 │   │
     │  └──────┘ └──────┘ └──────┘   │
     │     无状态 / 可水平扩展         │
     └────────────────────────────────┘
```

#### L4 防护：SYN Cookie 实现

```cpp
// 服务器端 SYN Cookie：避免分配资源直到握手完成
// 正常 TCP 握手：SYN → SYN-ACK → ACK
// SYN Flood 攻击：大量 SYN，不回 ACK，耗尽服务器半连接队列

// SYN Cookie 原理：不在收到 SYN 时分配资源，
// 而是将状态编码进 SYN-ACK 的 Sequence Number
uint32_t GenerateSynCookie(uint32_t srcIP, uint32_t dstIP,
                           uint16_t srcPort, uint16_t dstPort) {
    uint32_t t = GetTimeSeconds() / 60;  // 每分钟变化的 time slot
    uint32_t hash = Hash(srcIP, dstIP, srcPort, dstPort, t, SecretKey);

    // 编码 MSS 信息（4 bit）+ 时间（5 bit）+ hash（23 bit）
    return (EncodeMSS(mss) << 24) | (t << 23) | (hash & 0x7FFFFF);
}

// 客户端回 ACK 时，验证 sequence number
bool ValidateSynCookie(uint32_t cookie, uint32_t srcIP, ...) {
    uint32_t t = cookie >> 23 & 0x1F;
    uint32_t expected = GenerateSynCookie(srcIP, dstIP, ...);
    if ((cookie & 0x7FFFFF) != (expected & 0x7FFFFF)) return false;
    // 验证通过 → 这不是伪造的 SYN
    // 此时才分配连接资源
    return true;
}
```

#### 游戏特有：UDP 协议过滤

```python
# 游戏服务器 UDP Flood 防护
# 区分合法游戏包和攻击包

class GamePacketFilter:
    def __init__(self):
        self.conn_table = {}  # 已认证连接表
        self.rate_limiter = TokenBucket(rate=100, capacity=200)  # 全局速率
        self.per_ip_limit = {}  # 每IP限速

    def on_packet(self, src_ip, src_port, data):
        # 1. 全局速率限制
        if not self.rate_limiter.consume():
            drop("global rate exceeded")
            return

        # 2. 每IP速率限制
        if not self.check_per_ip(src_ip):
            drop("per-ip rate exceeded")
            return

        # 3. 包大小检查（游戏包通常 50-1400 bytes）
        if len(data) < 4 or len(data) > 1400:
            drop("abnormal packet size")
            return

        # 4. 协议握手验证（未认证的包走 Challenge）
        if src_ip not in self.conn_table:
            # 首次连接需要完成 Challenge-Response
            self.send_challenge(src_ip, src_port)
            return

        # 5. 已认证连接的包验证
        conn = self.conn_table[src_ip]
        if conn.port != src_port:
            drop("port mismatch")
            return

        # 6. 合法包 → 转发到 Game Server
        self.forward_to_game_server(data)
```

#### 防御方案对比

| 防御层 | 技术 | 成本 | 效果 | 游戏适用性 |
|--------|------|------|------|-----------|
| ISP 清洗 | BGP 重导流 | 高（需ISP支持） | 极强（T级吸收） | ✅ 大型游戏必备 |
| Anycast | IP 任播分发 | 中 | 强（分散流量） | ✅ 全球部署 |
| SYN Cookie | 内核参数 | 免费 | 中（防 SYN Flood） | ✅ 必须开启 |
| 反向代理 | Proxy 层 | 中 | 中（隐藏真实 IP） | ⚠️ TCP 游戏适用 |
| 应用层限流 | Token Bucket | 免费 | 弱（防不了大流量） | ✅ 辅助手段 |
| 游戏协议过滤 | 包特征检测 | 低 | 中（防协议漏洞） | ✅ 游戏特有 |

#### 真实案例：开服首日 200Gbps 攻击

```
时间线：
T+0:00  服务器上线，正常玩家 5 万在线
T+0:30  UDP Flood 开始，200Gbps → 入口带宽打满
T+0:31  正常玩家全面掉线
T+0:35  启动应急预案：
         ① BGP 切换到清洗中心（5 分钟生效）
         ② 游戏服务器 IP 更换（非公开的 Real IP）
         ③ 前端 Proxy 启用 SYN Cookie + 速率限制
T+0:45  清洗后流量 15Gbps（清洗掉 92%），正常恢复
T+1:00  攻击转为应用层：模拟登录 Flood
         → 启用 Challenge-Response + CAPTCHA
T+1:30  攻击转为匹配系统滥用
         → 匹配队列加频率限制 + 设备指纹去重
T+2:00  攻击减弱，服务稳定

经验教训：
- Real IP 泄露是致命的，必须通过 Proxy/SLB 隐藏
- 清洗中心预案必须提前与 ISP 谈好，不能临时找
- 应用层攻击比流量攻击更难防，需要业务层策略
```

### ⚡ 实战经验

- **隐藏 Real IP 是第一要务**：游戏服务器真实 IP 泄露后，直接 ICMP/UDP Flood 打入口，所有上层防护形同虚设。用 SLB / 反向代理中转，服务器只允许 Proxy IP 访问
- **UDP 游戏需要专门的 Challenge 握手**：不像 TCP 有三次握手天然防护，UDP 游戏服务器必须自建 Challenge-Response 机制（首次发包 → 服务器回 Challenge → 客户端回 Response → 建立连接表）
- **连接表要设过期时间**：不活跃连接 30 秒自动清除，防止攻击者建立大量空连接消耗内存
- **监控告警要分层**：网络层监控（pps/bps）、协议层监控（每协议包率）、业务层监控（登录成功率/匹配延迟），三层联动才能快速定位攻击类型

### 🔗 相关问题

- 游戏网络协议安全：包加密、防重放、防篡改怎么做？
- 匹配服务器如何防止机器人刷匹配？
- P2P 游戏如何防止主机端 DDoS（Host Migration + Relay 方案）？
