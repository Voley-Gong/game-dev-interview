---
title: "游戏的好友/社交关系系统架构怎么设计？如何支撑好友申请、关系图和好友推荐？"
category: "architecture"
level: 3
tags: ["好友系统", "社交关系", "关系图谱", "在线状态", "好友推荐"]
related: ["architecture/chat-social-system-architecture", "architecture/guild-clan-system-architecture"]
hint: '不是"存一个好友 ID 列表"——是"双向关系图 + 申请审批状态机 + Presence 在线感知 + 推荐引擎的组合"'
---

## 参考答案

### ✅ 核心要点

1. **双向关系建模**：好友关系是双向的（A 加 B 为好友 = B 也是 A 的好友），存储方案有两条路线：单条记录（`friendship` 表存 `playerA + playerB`，无方向）保证一致性简单，但查"某人的好友列表"需要 `WHERE playerA = ? OR playerB = ?` 全表扫描；双条记录（每人各存一条 `ownerId + friendId`）查询高效（`WHERE ownerId = ?`），但增删好友需要事务保证两条记录同步。

2. **申请审批状态机**：好友请求是一个完整的生命周期：发起申请(Pending) → 对方同意(Accepted) / 对方拒绝(Rejected) / 超时过期(Expired)。系统需设置申请数量上限（防止批量加好友骚扰）、申请有效期（如 7 天自动过期）、防骚扰机制（同一对象 24 小时内只能申请一次，被拒绝后冷却 48 小时）。

3. **Presence 在线状态感知**：好友列表需要实时展示在线/离线、最后在线时间、当前游戏状态（在大厅/匹配中/战斗中）。Presence 服务通常用 Redis Hash 维护在线状态（`presence:{playerId} → {status, gameMode, lastSeen}`），通过长连接（WebSocket / 游戏网关）推送好友上下线事件，客户端订阅好友列表的变化通知。

4. **好友推荐引擎**：推荐来源包括共同好友数（朋友的朋友）、同公会成员、同区服活跃玩家、最近一起组队的路人。每个维度计算一个推荐分，加权求和后取 Top-N。冷启动场景（新服/新玩家）可推荐系统机器人或最近匹配到的非好友队友。

5. **关系分层与权限控制**：好友关系不应只有"是/否"两种状态，现代游戏通常分层：陌生人 → 好友 → 亲密好友/挚友（额外的展示排序、专属互动）。同时维护独立的黑名单（屏蔽列表），被屏蔽的玩家无法发起私聊、邀请和申请。不同关系层级控制权限：能否查看战绩、能否邀请组队、能否赠送礼物。

### 📖 深度展开

#### 关系数据模型与存储设计

```typescript
/** 好友关系（双条记录方案：每人各存一条，查询高效） */
interface FriendRelation {
  ownerId: number;       // 关系归属者
  friendId: number;      // 好友ID
  relationType: RelationType;
  remark?: string;       // 好友备注名
  intimacy: number;      // 亲密度（互动增加）
  createdAt: number;     // 建立好友关系的时间
}

enum RelationType {
  Friend    = 1,   // 普通好友
  BestFriend = 2,  // 挚友（置顶 + 专属互动）
  Blocked   = 3,   // 黑名单（屏蔽）
}

/** 好友申请（独立状态机） */
interface FriendRequest {
  requestId: string;     // UUID
  fromId: number;        // 发起者
  toId: number;          // 接收者
  message?: string;      // 申请留言
  state: RequestState;
  createdAt: number;
  expireAt: number;      // 过期时间（7天后自动Expire）
}

enum RequestState {
  Pending  = 1,   // 待处理
  Accepted = 2,   // 已同意
  Rejected = 3,   // 已拒绝
  Expired  = 4,   // 已过期
}

/** 玩家社交设置 */
interface SocialSettings {
  playerId: number;
  maxFriends: number;       // 好友上限（VIP可提升）
  allowStrangerInvite: boolean;  // 是否允许陌生人发起组队邀请
  allowFriendSearch: boolean;    // 是否可被ID搜索到
  autoRejectDays: number;        // 被拒绝后冷却天数
}
```

两种存储方案对比：

| 维度 | 单条记录方案 | 双条记录方案 |
|------|-------------|-------------|
| 表结构 | `friendship(playerA, playerB)` 无方向 | `friend_relation(ownerId, friendId)` 有方向 |
| 查好友列表 | `WHERE playerA=? OR playerB=?`（需扫描两列） | `WHERE ownerId=?`（单列索引高效） |
| 添加好友 | 1 次 INSERT | 事务内 2 次 INSERT |
| 删除好友 | 1 次 DELETE | 事务内 2 次 DELETE |
| 一致性风险 | 天然一致 | 需事务保证（一条成功一条失败则数据不一致） |
| 黑名单/备注 | 难以支持（双方共享同一记录） | 天然支持（每人独立备注/屏蔽） |
| 适用场景 | 小型社交、关系简单 | 中大型游戏、需个性化设置 |

#### 申请审批流程与防骚扰机制

```
玩家A发起好友申请
       ↓
  ┌── 校验：A的好友数是否已满？
  ├── 校验：A是否已在B的黑名单中？ → 是则直接拒绝（B无感知）
  ├── 校验：A是否在24h内已申请过B？ → 是则返回"请勿频繁申请"
  ├── 校验：A的待处理申请数是否超限（如≤50）？
  └── 校验：B的好友数是否已满？
       ↓
  写入 FriendRequest(state=Pending, expireAt=now+7天)
       ↓
  推送通知给B（WebSocket/推送/邮件）
       ↓
  ┌── B同意 → 状态改 Accepted → 事务内双向写入 FriendRelation → 推送双方
  ├── B拒绝 → 状态改 Rejected → A进入冷却期（48h内不能再申请B）
  └── 超时未处理 → 定时任务扫描 expireAt < now → 状态改 Expired
```

```typescript
/** 批量处理好友申请（同意/拒绝/全部同意） */
async function batchProcessRequests(
  playerId: number,
  requestIds: string[],
  action: 'accept' | 'reject'
): Promise<BatchResult> {
  const results: BatchResult = { accepted: [], rejected: [], failed: [] };

  for (const reqId of requestIds) {
    const req = await getFriendRequest(reqId);
    if (!req || req.toId !== playerId || req.state !== RequestState.Pending) {
      results.failed.push({ reqId, reason: 'INVALID' });
      continue;
    }

    if (action === 'accept') {
      // 好友数上限校验
      const friendCount = await countFriends(playerId);
      const settings = await getSocialSettings(playerId);
      if (friendCount >= settings.maxFriends) {
        results.failed.push({ reqId, reason: 'FRIEND_LIMIT' });
        continue;
      }
      // 事务：更新申请状态 + 双向写入好友关系
      await db.transaction(async (tx) => {
        await tx.update('friend_requests', { state: RequestState.Accepted },
          { where: { requestId: reqId } });
        await tx.insert('friend_relation', { ownerId: playerId, friendId: req.fromId, relationType: RelationType.Friend });
        await tx.insert('friend_relation', { ownerId: req.fromId, friendId: playerId, relationType: RelationType.Friend });
      });
      results.accepted.push(req.fromId);
    } else {
      await updateRequestState(reqId, RequestState.Rejected);
      results.rejected.push(req.fromId);
    }
  }
  return results;
}
```

#### Presence 在线状态与好友推荐

Presence 服务是好友列表"活起来"的关键，需要支撑百万级在线状态的实时感知：

```
玩家上线/状态变更
       ↓
  网关通知 Presence Service
       ↓
  Redis Hash 更新: presence:{pid} = {status, gameMode, lastSeen}
       ↓
  查询该玩家的好友列表
       ↓
  ┌── 对每个在线好友 → 推送 "{pid}上线了" 事件
  └── 离线好友 → 下次上线时拉取最新状态
       ↓
  客户端好友列表UI实时刷新在线状态
```

好友推荐算法——基于多维度加权评分：

```typescript
interface RecommendScore {
  mutualFriends: number;  // 共同好友数
  sameGuild: boolean;     // 同公会
  recentTeammates: boolean; // 最近一起组队
  sameLevel: boolean;     // 等级相近
  score: number;          // 加权总分
}

function calculateRecommendScore(
  candidate: number,
  target: number
): RecommendScore {
  const mutualFriends = countMutualFriends(target, candidate);
  const sameGuild = isInSameGuild(target, candidate);
  const recentTeammates = hasRecentMatchHistory(target, candidate, 7); // 7天内
  const sameLevel = Math.abs(getLevel(target) - getLevel(candidate)) <= 5;

  // 加权评分（权重可配置）
  const score =
    mutualFriends * 10 +         // 共同好友权重最高
    (sameGuild ? 15 : 0) +       // 同公会加分
    (recentTeammates ? 20 : 0) + // 最近组队加分（强信号）
    (sameLevel ? 5 : 0);         // 等级相近小加分

  return { mutualFriends, sameGuild, recentTeammates, sameLevel, score };
}
```

推荐策略对比：

| 推荐来源 | 信号强度 | 实现复杂度 | 冷启动友好 | 典型场景 |
|----------|---------|-----------|-----------|----------|
| 共同好友 | 高 | 中（需图查询） | 差（新玩家无好友） | 社交裂变、扩圈 |
| 最近组队队友 | 高 | 低（查对战记录） | 好 | MOBA/FPS 对局后推荐 |
| 同公会成员 | 中 | 低（查公会成员表） | 差（新玩家无公会） | MMORPG 公会社交 |
| 系统机器人 | 低 | 中 | 极好 | 新服开服冷启动 |
| LBS 同城 | 中 | 高（需地理位置） | 好 | 休闲社交游戏 |

### ⚡ 实战经验

- **好友列表查询性能**：某 MMO 好友上限 200 人，玩家打开好友面板时一次性加载全部好友的在线状态 + 资料，响应耗时 800ms+。改为增量推送：首次只加载在线好友（通常 <50 人），离线好友懒加载，Presence 变更通过长连接增量推送。好友面板打开耗时从 800ms 降到 50ms。
- **开服申请洪泛**：新服首日大量玩家搜索 ID 互加好友，待处理申请队列堆积，数据库写入 QPS 打满。增加申请限流（单玩家每分钟最多发起 10 个申请）+ 待处理申请上限（每人最多 50 个待处理）+ 批量审批接口（一次同意/拒绝多个），首日申请处理 P99 从 5s 降到 200ms。
- **Presence 内存优化**：百万级在线状态全量存 Redis Hash，单实例内存占用 8GB+。将离线玩家的 Presence 淘汰到 MySQL（只保留 `lastSeen`），Redis 只缓存在线玩家状态，内存占用降到 1.2GB。好友列表查询时在线状态从 Redis 读、离线状态从 MySQL 批量读。
- **推荐冷启动**：新服开服第一周无社交数据，共同好友推荐全部为空，推荐转化率 <2%。增加"最近组队队友"推荐源（对局结束后自动出现在推荐列表）+ 系统机器人好友填充推荐位，推荐转化率提升到 12%。机器人好友由 AI 控制，定期发送互动消息提升社交感。

### 🔗 相关问题

- 好友系统如何与公会系统联动？玩家退会后公会好友是否自动转为普通好友？跨系统数据如何同步？
- 跨服好友怎么设计？不同逻辑服务器的玩家能成为好友吗？Presence 和私聊如何跨服路由？
- 如何防止好友系统被用于垃圾信息推广和社交工程攻击（如假冒客服加好友钓鱼）？
