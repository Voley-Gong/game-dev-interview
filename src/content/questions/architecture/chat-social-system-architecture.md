---
title: "游戏聊天与社交系统架构怎么设计？如何支撑频道、私聊、公会和实时在线状态？"
category: "architecture"
level: 4
tags: ["聊天系统", "社交系统", "频道", "公会", "在线状态", "Presence", "消息路由"]
related: ["architecture/module-decoupling-bus-signal", "architecture/event-driven-vs-data-driven"]
hint: "不是「一个全局聊天频道 + 字符串消息」——是「频道作为消息路由单元各有投递规则和权限、Presence（在线状态）独立服务驱动好友名册和公会列表、富文本/敏感词/限流作为可插拔的消息处理管线」。"
---

## 参考答案

聊天与社交系统是玩家留存的核心载体，但它远不止「发个字符串」那么简单。一个成熟的架构要把消息路由、在线状态、消息处理、离线存储这四件事拆成独立而又协作的模块，才能在大并发下稳定运行。下面从频道抽象、Presence、处理管线、离线存储四个维度展开。

### ✅ 核心要点

1. **频道（Channel）是消息路由的核心抽象**：世界、公会、队伍、私聊、系统公告本质都是「Channel」，区别在于成员模型（世界=全服、公会=成员表、队伍=临时组、私聊=一对一）和投递策略（世界要限流、公会要全员推、私聊要离线存储）。统一 Channel 抽象让消息路由逻辑复用，而不是每个频道各写一套。
2. **Presence（在线状态）是社交系统的基石**：好友列表、公会名册、私聊可达性都依赖「谁在线」。Presence 服务维护玩家→连接的映射，上下线事件广播给订阅者（好友/公会成员）。没有 Presence，私聊不知道对方在不在线、好友列表全是灰色，社交体验直接崩塌。
3. **消息处理管线（pipeline）做富文本、过滤、限流**：一条消息从输入到投递要经过：敏感词过滤→频率限制（防刷屏）→富文本解析（物品链接/表情/@提及）→历史记录→路由分发。每个环节是独立的可插拔中间件，而不是 if-else 堆在发送函数里，这样才能独立调优和扩展。
4. **离线消息与历史记录分开存储**：私聊和公会消息要支持离线查看（对方不在线也能收到），需要「收件箱」模型：消息先落库，投递时在线则推、不在线则等下次登录拉。世界/队伍等临时频道通常不存历史（量太大），只缓存最近 N 条。
5. **公会数据模型要支持高效成员查询**：公会名册（几百人）、权限分级（会长/副会长/精英/会员）、公会仓库、公会公告。成员变更（入会/退会/踢人）要广播给所有在线公会成员更新名册。公会数据量大，不能全量同步，要增量推送加本地缓存。
6. **性能：世界频道是聊天系统的吞吐瓶颈**：一个 DAU 百万的游戏，世界频道峰值可能上千条/秒。不能每条消息遍历所有在线连接推送（N×M）。解法：维护频道→订阅连接集合，消息按频道扇出（fan-out），用发布订阅模式而非点对点。

### 📖 深度展开

**1. 频道抽象与消息路由模型**

把所有聊天形态抽象成 Channel，统一管理订阅关系和投递策略，是聊天系统可扩展的关键。

```typescript
enum ChannelType { World, Guild, Team, Whisper, System }

interface Channel {
  readonly id: string;          // 频道唯一标识
  readonly type: ChannelType;
  subscribe(conn: Connection): void;        // 加入频道
  unsubscribe(conn: Connection): void;      // 离开频道
  publish(msg: ChatMessage): void;          // 发布消息（按投递策略扇出）
  getSubscribers(): Connection[];           // 当前订阅者
}

// 世界频道：全员订阅，发布时扇出给所有连接
class WorldChannel implements Channel {
  readonly type = ChannelType.World;
  private subs = new Set<Connection>();
  publish(msg: ChatMessage): void {
    for (const conn of this.subs) conn.send(msg);   // fan-out，共享消息体只序列化一次
  }
}
```

消息路由的整体流转如下图所示，发送者只需把消息交给频道，频道再经过消息处理管线扇出给订阅者：

```
发送者 ──消息──→ [频道 Channel]
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   [敏感词过滤]  [频率限制]  [富文本解析]   ← 消息处理管线(可插拔中间件)
        │           │           │
        └───────────┴───────────┘
                    │
                    ▼ 扇出(fan-out)
        ┌───────┬───────┬───────┐
        ▼       ▼       ▼       ▼
     订阅者1  订阅者2  订阅者3  ...(共享同一份序列化消息体)
```

注意 WorldChannel 用 `Set<Connection>` 直接遍历发送，这是最朴素的扇出实现。真实工程中会把同一条消息的序列化字节缓存一次，再对每个连接直接写字节流，避免重复序列化。频道抽象的另一个好处是权限校验可以下沉到 `subscribe` 时做一次，发布时不再逐条判断。

**2. Presence 服务与在线状态广播**

Presence 维护「谁在线」的全局视图，上下线事件驱动好友列表和公会名册的实时更新。

```typescript
class PresenceService {
  private online = new Map<string, Connection>();   // playerId → 连接

  onLogin(playerId: string, conn: Connection): void {
    this.online.set(playerId, conn);
    this.notifyFriends(playerId, true);    // 通知好友：上线
    this.notifyGuildmates(playerId, true); // 通知公会成员：上线
  }

  onLogout(playerId: string): void {
    this.online.delete(playerId);
    this.notifyFriends(playerId, false);   // 通知好友：下线
    this.notifyGuildmates(playerId, false);
  }

  isOnline(playerId: string): boolean { return this.online.has(playerId); }
}
```

Presence 的事件流向：登录时注册映射并广播上线，下线时反向通知，好友头像和公会名册据此刷新：

```
玩家登录 ──→ Presence 注册(playerId→conn)
                │
       ┌────────┴────────┐
       ▼                 ▼
  通知好友列表         通知公会名册
  (好友头像变绿)       (成员在线状态刷新)
                │
  玩家下线 ──→ Presence 注销 ──→ 反向通知(变灰)
```

在分布式部署下 Presence 不能只放在单进程里，通常要拆成独立服务（或用 Redis 维护 playerId→网关节点的映射），由网关在连接建立/断开时上报。这样任意逻辑服都能查询在线状态、订阅上下线事件，而不是各自维护一份过期数据。

**3. 消息处理管线（middleware pipeline）**

把过滤、限流、富文本、历史记录拆成独立中间件，按序执行，可插拔可排序，是聊天扩展性的核心。它的形态和 Web 框架里的中间件链几乎一致：每个中间件可以选择放行（调用 `next`）或拦截（直接 return），任意一环拦截，消息就不会进入投递阶段。

```typescript
interface MessageMiddleware {
  process(msg: ChatMessage, next: () => void): void;   // 可中断链(不调 next)
}

class ChatPipeline {
  private middlewares: MessageMiddleware[] = [];
  use(m: MessageMiddleware): this { this.middlewares.push(m); return this; }

  handle(msg: ChatMessage): void {
    let i = 0;
    const next = () => {
      if (i < this.middlewares.length) this.middlewares[i++].process(msg, next);
      else this.dispatch(msg);   // 全部中间件通过 → 路由分发
    };
    next();
  }
}

// 敏感词中间件：命中则拦截，不调 next
class ProfanityFilter implements MessageMiddleware {
  process(msg: ChatMessage, next: () => void): void {
    if (this.containsBadWord(msg.text)) { this.reject(msg); return; }
    next();
  }
}
```

不同频道的投递策略差异较大，成员模型、是否落库、限流强度都要分别设计：

| 频道 | 成员模型 | 投递策略 | 历史记录 | 限流 |
|------|---------|---------|---------|------|
| 世界 | 全服在线 | 扇出给所有连接 | 不存(量大)，缓存最近50条 | 严格(3秒/条) |
| 公会 | 成员表 | 推送给在线成员 | 落库，支持离线查看 | 中等(1秒/条) |
| 队伍 | 临时组 | 推送给队伍成员 | 不存(临时) | 宽松 |
| 私聊 | 一对一 | 在线推/离线存收件箱 | 落库(收件箱模型) | 中等 |
| 系统 | 指定目标 | 定向推送 | 落库(重要) | 无 |

这张表的「限流」一列尤其关键：限流通常在管线里以中间件形式实现，按 playerId + channel 维度做令牌桶或滑动窗口计数，世界频道要严格、私聊可宽松。中间件的顺序也要讲究——敏感词过滤应排在富文本解析之前，避免被绕过。

**4. 离线消息存储与拉取策略**

私聊和公会消息的离线可达性靠「收件箱」模型：消息先落库，在线时推+标已读，离线时只入库，登录时拉未读。

```typescript
interface OfflineMessage {
  id: string;
  fromId: string;
  toId: string;           // 收件人
  channelId: string;      // 来源频道(私聊/公会)
  content: RichText;      // 富文本(非原始字符串)
  timestamp: number;
  read: boolean;
}

// 登录时拉取未读离线消息
function fetchUnread(playerId: string): OfflineMessage[] {
  return db.query("SELECT * FROM offline_msg WHERE to_id=? AND read=0", playerId);
}
```

三种投递策略在存储成本、实时性和适用频道上有明显取舍：

| 策略 | 存储成本 | 实时性 | 适用频道 | 说明 |
|------|---------|--------|---------|------|
| 在线推送 | 低(不存) | 实时 | 世界/队伍 | 离线即丢，适合临时频道 |
| 离线拉取(收件箱) | 中(落库) | 延迟到下次登录 | 私聊/系统 | 保证可达 |
| 历史记录缓存 | 高(全量) | 可回溯 | 公会/私聊 | 支持翻历史，需分页 |

收件箱表会随时间无限增长，需要定期归档或冷热分层：近期未读放热库（高并发读），已读旧消息归档到冷存储。私聊历史翻页要按 channelId + 时间游标分页，避免深翻页的 OFFSET 性能问题。

### ⚡ 实战经验

- **世界频道扇出必须共享消息体**：早期实现每条消息复制 N 份给每个在线玩家，10 万人在线时一条消息要序列化 10 万次，内存暴涨。改用「频道→连接列表」扇出 + 共享消息体（只序列化一次再广播引用），内存降 90%、CPU 降 70%。
- **敏感词过滤用 DFA/AC 自动机**：全量敏感词库 5 万词条，每条消息朴素字符串匹配约 20ms，世界频道千条/秒直接卡死。改用 DFA（确定有限自动机）或 AC 自动机多模式匹配，降到 0.1ms/条，吞吐提升约 200 倍。
- **离线私聊必须有收件箱兜底**：用户 A 给离线的 B 发私聊，消息只走在线推送通道，B 上线后收不到。根因：私聊没有离线存储。解法：所有私聊先落库（收件箱模型），在线时双推（推送+已读标记），离线时只入库，登录时拉未读。
- **公会名册用增量推送而非全量**：500 人公会，每次有人入退会全量推 500 人数据给所有成员，名册刷新卡 2 秒。改用增量推送（只推变更的成员记录）+ 本地缓存（首次全量、后续增量），刷新降到约 50ms。
- **富文本存结构化 Token 不存原始字符串**：玩家发「[强化+12 屠龙刀] 出售，私聊」，物品链接要可点击查看。富文本不能存原始字符串（格式不统一、敏感词易绕过），必须解析成结构化 Token（文字段/物品链接段/表情段），存储 Token 数组，渲染时拼装。

> 小结：聊天系统的设计骨架可以浓缩成四个词——**路由（频道）、状态（Presence）、处理（管线）、存储（收件箱）**。先把这四层抽象搭好，富文本、敏感词、风控等细节才能作为可插拔模块逐步叠加，而不是一开始就和发送逻辑纠缠在一起。

### 🔗 相关问题

- 怎么设计一个支持「跨服聊天」的架构？不同服务器的玩家怎么在同一个频道通信？
- 语音聊天（Voice Chat）和文字聊天在架构上有什么不同？WebRTC/P2P 直连 vs 服务端转发怎么选？
- 怎么防止机器人刷屏和广告？行为风控（频率、内容、信誉分）怎么和聊天系统集成？
