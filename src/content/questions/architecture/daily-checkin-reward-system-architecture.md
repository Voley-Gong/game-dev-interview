---
title: "游戏的签到/日活/每日奖励系统架构怎么设计？如何处理跨日时间、补签和累计奖励？"
category: "architecture"
level: 3
tags: ["签到系统", "日活系统", "运营活动", "奖励发放", "时间管理"]
related: ["architecture/battle-pass-season-pass-architecture", "architecture/shop-economy-system-architecture"]
hint: '不是"每天加一个标记"——是"服务端权威时间 + 幂等领取 + 累计进度状态机的组合"'
---

## 参考答案

### ✅ 核心要点

1. **服务端权威时间**：签到的"今天"必须以服务端返回的 UTC 时间戳 + 服务器时区为唯一判据，客户端本地时间不可信——玩家修改系统时区或回拨时钟就能多领奖励。服务端在每次签到请求时返回 `serverTime` 与 `serverDay`（基于游戏日计算），客户端只做展示，所有判定逻辑在服务端执行。

2. **幂等领取机制**：每日签到领取必须幂等——同一 `playerId + signDate` 无论请求多少次，奖励只发放一次。实现上用领取记录表的主键唯一约束 `(playerId, signDate)` 或 Redis `SETNX sign:{pid}:{date}` 做防重，数据库层兜底捕获唯一键冲突，返回已领取状态。

3. **累计奖励状态机**：签到系统不仅仅是"今天签了"，通常还有连续签到（streak）和累计签到（total）两套计数，配合里程碑奖励（7 天、14 天、30 天分别有额外大奖）。需要维护 `continuousDays`、`totalDays` 以及里程碑领取状态位图，每次签到时推进计数并检查是否有里程碑可领。

4. **跨日边界处理**：游戏日不一定从 0 点开始（很多手游是凌晨 5 点重置）。正在线玩家在跨日瞬间签到状态需要平滑切换——不能简单地用自然日判断。重置逻辑应该是懒触发（lazy reset）：玩家下次请求时服务端检测当前 `serverDay > lastSignDay`，计算断签天数并更新连续签到计数。

5. **补签与断签恢复**：断签后的补签（免费 / 付费 / 道具补签）需要回溯历史记录、校验可补签天数上限（如最多补 3 天）、消耗资源、补发对应日期奖励，整个流程是事务性的。补签的消耗与可补天数由配置驱动，运营可灵活调整。

### 📖 深度展开

#### 数据模型与状态机设计

签到系统的核心数据分为三层：每日签到记录、累计进度、配置表。

```typescript
/** 单日签到记录（主键: playerId + signDate） */
interface SignRecord {
  playerId: number;
  signDate: string;          // "2026-06-26"（基于游戏日）
  signTimestamp: number;     // 服务端签到时间戳
  rewardClaimed: boolean;    // 当日基础奖励是否已领
  isMakeup: boolean;         // 是否为补签
  makeupCost?: number;       // 补签消耗（钻石数）
}

/** 玩家签到累计进度（每玩家一行） */
interface SignProgress {
  playerId: number;
  continuousDays: number;    // 连续签到天数（断签清零）
  totalDays: number;         // 本月累计签到天数
  lastSignDate: string;      // 最近签到日期
  milestoneClaimed: number;  // 里程碑领取位图 (bit 0=day7, 1=day14, 2=day30)
  freeMakeupCount: number;   // 本月剩余免费补签次数
}

/** 月度签到奖励配置（策划在 Excel 维护，热更下发） */
interface MonthlySignConfig {
  month: string;             // "2026-06"
  dailyRewards: RewardEntry[];    // 31天的每日奖励
  milestones: MilestoneEntry[];   // 7/14/30天里程碑大奖
  maxFreeMakeup: number;          // 每月免费补签次数
  paidMakeupCost: number;         // 付费补签单次消耗
  resetHour: number;              // 游戏日重置时间（0-23，如5表示凌晨5点）
}
```

签到状态流转：

```
玩家发起签到请求
       ↓
  服务端校验 serverTime → 计算 serverDay
       ↓
  ┌─ serverDay == lastSignDate → 已签过，返回"今日已签到"
  ├─ serverDay == lastSignDate + 1 → 正常签到，continuousDays++
  ├─ serverDay > lastSignDate + 1 → 断签！continuousDays 重置为 1
  └─ serverDay < lastSignDate → 时间异常，拒绝（防回拨）
       ↓
  写入 SignRecord (playerId + signDate 唯一键)
       ↓
  发放每日奖励（幂等）+ 检查里程碑 → 返回结果
```

#### 跨日重置与连续签到断签逻辑

跨日处理是签到系统最容易出 bug 的地方。核心原则是**懒触发重置**——不做全局定时扫描，而是在玩家请求时按需计算：

```typescript
function processSign(playerId: number, serverTime: number): SignResult {
  const progress = getSignProgress(playerId);
  const config = getCurrentMonthConfig();
  const serverDay = calcGameDay(serverTime, config.resetHour);

  // 跨月处理：进入新月重置 totalDays
  if (!serverDay.startsWith(config.month)) {
    progress.totalDays = 0;
    progress.milestoneClaimed = 0;
    progress.freeMakeupCount = config.maxFreeMakeup;
  }

  // 防重复签到
  if (progress.lastSignDate === serverDay) {
    return { code: 'ALREADY_SIGNED', message: '今日已签到' };
  }

  // 断签判定
  const dayDiff = dayDifference(progress.lastSignDate, serverDay);
  if (dayDiff === 1) {
    progress.continuousDays++;       // 连续签到
  } else if (dayDiff > 1) {
    progress.continuousDays = 1;     // 断签重置
  } else {
    return { code: 'TIME_ERROR' };   // 时间回拨，异常
  }

  progress.totalDays++;
  progress.lastSignDate = serverDay;

  // 写入签到记录 + 发奖（事务）
  return commitSign(playerId, serverDay, progress, config);
}
```

连续签到 vs 累计签到对比：

| 维度 | 连续签到(Streak) | 累计签到(Total) |
|------|------------------|-----------------|
| 断签行为 | 清零重新计数 | 不受影响，只增不减 |
| 奖励特点 | 高价值里程碑（7/14/30天大奖） | 每日递增或均匀奖励 |
| 运营目的 | 提高留存，激励每日上线 | 降低断签惩罚感，鼓励回归 |
| 实现复杂度 | 需判断日期连续性 | 只需累加计数 |
| 典型应用 | 原神月卡每日、王者荣耀签到 | 手游月度签到积分兑换 |

#### 补签事务与幂等保障

补签是签到系统的高频需求，核心难点是回溯历史 + 事务安全：

```typescript
async function makeupSign(playerId: number, targetDate: string): Promise<MakeupResult> {
  // 1. 校验目标日期合法性：不能是未来、不能超出补签窗口（如最多补3天）
  const config = getCurrentMonthConfig();
  if (!isWithinMakeupWindow(targetDate, config.maxMakeupDays)) {
    return { code: 'OUT_OF_WINDOW' };
  }

  // 2. 校验目标日期是否已签（防重复补签）
  if (await hasSignRecord(playerId, targetDate)) {
    return { code: 'ALREADY_SIGNED' };
  }

  // 3. 扣除补签消耗（事务开始）
  const cost = await consumeMakeupResource(playerId, config);
  if (!cost.success) {
    return { code: 'INSUFFICIENT_RESOURCE' };
  }

  // 4. 写入补签记录 + 发放对应日期奖励
  try {
    await writeSignRecord(playerId, targetDate, { isMakeup: true, makeupCost: cost.amount });
    await grantRewards(playerId, config.dailyRewards[parseDay(targetDate)]);
    // 补签不影响 continuousDays（历史日期不参与连续判定）
    return { code: 'SUCCESS', rewards: config.dailyRewards[parseDay(targetDate)] };
  } catch (e) {
    await refundMakeupResource(playerId, cost); // 回滚消耗
    throw e;
  }
}
```

补签策略对比：

| 策略 | 消耗 | 限制 | 适用场景 |
|------|------|------|----------|
| 免费补签 | 无 | 每月 1-3 次 | 低氪友好，降低断签焦虑 |
| 付费补签 | 钻石/付费货币 | 无上限或按次递增 | 重度玩家追求满签奖励 |
| 道具补签 | 补签卡（活动产出） | 受道具数量限制 | 活动驱动，促进活跃 |
| 广告补签 | 观看 30s 广告 | 每日 1 次 | 休闲游戏广告变现 |

### ⚡ 实战经验

- **时区作弊防护**：某海外项目用客户端 `Date.now()` 判定签到，东南亚玩家改手机时区每天多领 1 次奖励，两周后数据对账才发现。修复后改为服务端权威时间，所有签到请求附带 `serverTime` 验证，作弊归零。
- **跨日并发事故**：凌晨 5 点重置时，玩家 A 在 4:59:59 发起签到、服务端在 5:00:01 处理，导致 `serverDay` 计算为当天但 `lastSignDate` 是昨天，`continuousDays` 正常 +1；但另一个请求在 5:00:00 恰好重置后立即签到，两个请求同时到达数据库产生竞态。用数据库行锁（`SELECT ... FOR UPDATE`）串行化同玩家的签到请求解决。
- **月度配置包膨胀**：31 天奖励表 × 万级玩家全量推送配置包达 2MB+，首日登录下载峰值打满 CDN。改为服务端只下发育活动配置 JSON（~50KB），客户端本地缓存 + 版本号增量更新，首包从 2MB 降到 52KB。
- **补签回溯查询**：玩家停玩 30 天后回归，补签查询 `WHERE playerId = ? AND signDate BETWEEN ?` 命中全月数据。给 `(playerId, signDate)` 加联合索引后查询从 200ms 降到 3ms。月度归档历史签到记录到冷存储表，热表只保留当月。

### 🔗 相关问题

- 签到系统和战令/通行证系统有什么区别？各自的进度模型和奖励发放方式有何不同？
- 如何设计"7 天循环签到"和"月历签到"混合的签到系统？两者进度如何互不影响？
- 如果签到系统的日活突然暴跌 30%，你会从哪些维度排查是架构问题还是运营配置问题？
