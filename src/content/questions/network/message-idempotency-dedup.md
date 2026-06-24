---
title: "游戏网络消息如何保证幂等性与去重处理？"
category: "network"
level: 3
tags: ["幂等性", "消息去重", "可靠性", "断线重连", "网络同步"]
related: ["network/reconnect-state-recovery", "network/reliable-udp-implementation", "network/protocol-layer-architecture"]
hint: "玩家因网络抖动连发三次「使用道具」，服务器应该执行几次？"
---

## 参考答案

### ✅ 核心要点

1. **幂等性定义**：同一条消息执行一次和执行多次，结果一致
2. **去重的核心依据**：Sequence Number + Sender ID 组成唯一键
3. **两层防线**：传输层可靠排序（TCP/KCP）+ 应用层幂等校验
4. **重连场景最危险**：重连后服务器可能重放未确认的消息
5. **幂等设计是业务逻辑的责任**，不能完全依赖传输层可靠性

### 📖 深度展开

#### 为什么传输层可靠还不够？

TCP 保证有序到达，KCP 也有重传机制——但以下场景依然会导致重复消息：

```
场景：断线重连
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Client                    Server
  │── Action(seq=42) ──────→  ✅ 执行成功，但 ACK 丢失
  │                         │
  │   (网络断开 5 秒)        │  状态：seq=42 未确认
  │                         │
  │── 重连 ──────────────────│
  │── Action(seq=42) ──────→  ⚠️  又来了一次！执行还是丢弃？
  │                         │
```

```
场景：多路径 / 双发冗余
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
主通道：Client ── msg ──→ Server (延迟 80ms)
备用道：Client ── msg ──→ Server (延迟 150ms，主通道超时触发)

结果：Server 收到两条相同消息
```

#### 去重方案：序列号窗口

最经典的方案是 **滑动窗口 + Bitmap 去重**，和 TCP 的接收窗口类似：

```cpp
struct MessageDeduplicator {
    uint32_t expectedSeq;        // 期望的下一个序列号
    uint64_t receivedBitmap;     // 最近 64 个 seq 的接收状态

    bool isDuplicate(uint32_t seq, uint32_t senderId) {
        if (seq < expectedSeq - 64) return true;  // 太旧，丢弃

        if (seq < expectedSeq) {
            // 已确认过的区间，检查 bitmap
            uint32_t offset = expectedSeq - 1 - seq;
            if (receivedBitmap & (1ULL << offset)) {
                return true;  // 已接收过，重复
            }
        }

        return false;
    }

    void markReceived(uint32_t seq) {
        if (seq >= expectedSeq) {
            uint32_t shift = seq - expectedSeq + 1;
            receivedBitmap <<= shift;
            receivedBitmap |= (1ULL << (shift - 1));
            expectedSeq = seq + 1;
        } else {
            uint32_t offset = expectedSeq - 1 - seq;
            receivedBitmap |= (1ULL << offset);
        }
    }
};
```

#### 幂等设计的业务层模式

传输层去重是第一道防线，但**业务逻辑自身也必须幂等**：

| 模式 | 实现方式 | 适用场景 |
|------|---------|---------|
| **唯一请求 ID** | 每个操作携带 requestId，服务器记录已处理集合 | 道具使用、购买 |
| **版本号 / CAS** | 状态携带 version，操作必须基于最新版本 | 背包整理、装备切换 |
| **状态机校验** | 操作前检查当前状态是否允许（如"已死亡不能再用药"） | 战斗状态机 |
| **数据库唯一约束** | 利用 requestId 做数据库唯一索引 | 充值、交易 |

```cpp
// 示例：幂等的道具使用处理
Result handleUseItem(const UseItemRequest& req) {
    // 1. 检查 requestId 是否已处理
    if (processedRequests.contains(req.requestId)) {
        return processedRequests[req.requestId];  // 返回上次结果
    }

    // 2. 状态机校验
    auto& player = getPlayer(req.playerId);
    if (player.state != PlayerState::Alive) {
        return Result::InvalidState;
    }

    // 3. 检查道具是否还在（可能已被前一条消息消耗）
    if (!player.inventory.has(req.itemId)) {
        return Result::ItemNotFound;  // 幂等：不报错，只返回失败
    }

    // 4. 执行 + 记录
    auto result = player.useItem(req.itemId);
    processedRequests[req.requestId] = result;
    return result;
}
```

#### 帧同步中的幂等

帧同步对幂等性要求更苛刻——每帧的输入必须确定性地执行，**重复执行同一帧输入也必须得到相同结果**：

```
帧 N 输入: [Player1: Move(1,0), Player2: Attack]
→ 第一次执行：Player1 移动到 (1,0)，Player2 造成 50 伤害
→ 重放执行：  Player1 移动到 (1,0)，Player2 造成 50 伤害  ✅ 一致
```

这要求：
- **禁止使用随机数**（必须用确定性伪随机种子）
- **禁止依赖系统时间**（必须用游戏内帧计数）
- **浮点数必须用定点数替代**（不同平台浮点结果可能不同）

### ⚡ 实战经验

- **永远不要信任传输层**：即使使用 TCP，业务层也必须做幂等。服务器重启、负载均衡切换、客户端重连都会打破"恰好一次"的假设
- **requestId 用 UUID 或 雪花 ID**：不要用自增整数，因为客户端离线再上线后计数器可能重置
- **processedRequests 需要过期清理**：用 LRU 或 TTL（如 5 分钟），否则内存会持续增长
- **帧同步的 rollback 重放最容易出幂等 bug**：确保逻辑层不会在重放时触发"副作用"（如发网络包、写日志、给成就系统计数）

### 🔗 相关问题

- 断线重连后，客户端如何知道服务器是否已经处理了自己的最后一个请求？
- 帧同步中回滚重放时，如何避免 UI 层重复响应？
- 微服务架构下，跨服务的幂等性如何保证（分布式事务）？
