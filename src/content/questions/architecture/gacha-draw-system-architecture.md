---
title: "游戏抽卡/扭蛋系统架构怎么设计？如何保证概率公平、保底机制和抽卡事务安全？"
category: "architecture"
level: 4
tags: ["抽卡系统", "保底机制", "概率引擎", "事务安全", "服务端权威"]
related: ["architecture/shop-economy-system-architecture", "architecture/equipment-enhancement-system-architecture"]
hint: "不是「摇个随机数给奖励」——是「服务端权威概率引擎 + 软硬保底 + 抽卡事务原子性 + 卡池生命周期管理」"
---

## 参考答案

### ✅ 核心要点

1. **服务端权威概率引擎（Server-Authoritative RNG）是防作弊的底线**：抽卡结果必须在服务端用确定性引擎生成，客户端只负责播放抽卡动画和展示结果。客户端不可信——任何客户端 Roll 都能被改内存篡改成「出金」。服务端记录每次抽卡的种子、时间戳、卡池版本号，形成可审计日志链，遇到「我抽了 90 发没出金」的客诉能秒级复现 Roll 序列。
2. **保底机制（Pity System）是概率公平的工程化兜底**：抽卡不是纯随机——软保底（Soft Pity，连抽若干次后概率逐级递增）和硬保底（Hard Pity，达到上限必出最高稀有度）共同保证「不会无限非酋」。保底计数必须服务端持久化、跨卡池按规则继承（限定池独立计数 / 同类池共享计数），且保底重置逻辑要和运营活动（卡池切换、版本更新）严格对齐。
3. **卡池（Banner）生命周期管理是运营的核心杠杆**：卡池分「常驻池 / 限定池 / 新手池 / 活动池」，每个卡池有独立的物品池、概率表、保底规则、开始/结束时间。卡池配置驱动一切——策划改配置不改代码，卡池到期自动下架，限定卡池结束后 UP 角色按规则回归常驻池。
4. **抽卡事务原子性（Atomic Pull Transaction）防超发漏发**：单次抽卡是「预扣费 → 服务端 Roll → 发放奖励 → 写日志」的事务，任意环节失败必须回滚扣费。十连抽要保证「全部成功或全部回滚」，不能出现扣了 10 连的钱只发了 8 个。幂等键（pullId）防止网络重传导致重复发放。
5. **概率展示与合规（Probability Disclosure）是上线硬性要求**：国内外法规（中国版号审批、日本景品表示法、欧盟消费者保护）都要求公开抽取概率，部分还要求标注累计保底。概率展示必须和真实 Roll 逻辑一致——展示 1.6% 实际也得是 1.6%，UP 角色歪率（小保底 50%）必须明示，否则构成合规事故甚至下架整改。

### 📖 深度展开

#### 一、服务端权威概率引擎与保底机制实现

抽卡引擎的核心是「确定性 RNG + 保底状态机」。服务端用带种子的 PRNG（如 SplitMix64）生成随机数，配合保底计数器逐级抬升出金概率。下面是原神五星系统的简化实现：

```typescript
interface GachaResult {
  itemId: number;
  rarity: 'S' | 'A' | 'B' | 'C';   // S=五星, A=四星, B/C=三星
  isRateUp: boolean;                 // 是否为 UP 限定角色
  seed: number;                      // 本次 Roll 的随机种子（用于审计复现）
  rollValue: number;                 // 实际随机数 0-1（落点）
}

interface PityState {
  pullCount: number;                 // 距离上次出 S 的抽数
  softPityCounter: number;           // 软保底已累计的递增次数
  guaranteedFeaturedNext: boolean;   // 大保底标记：上次歪了，下次 S 必出 UP
  totalPulls: number;                // 该卡池历史总抽数（用于统计/合规审计）
}

function rollOnce(poolDef, pity: PityState, seed: number): GachaResult {
  const rng = seededRandom(seed);
  const roll = rng();                // rollValue ∈ [0,1)

  // 1. 计算当前有效 S 级概率（基础 0.6% + 软保底爬坡）
  let sRate = poolDef.baseSRate;     // 0.006
  if (pity.pullCount >= 74) {
    // P74 起，每多 1 抽递增约 6%，至 P90 硬保底 100%
    sRate += (pity.pullCount - 73) * 0.06;
  }
  if (pity.pullCount >= 89) sRate = 1; // 硬保底必出 S

  // 2. 决定稀有度档位
  let rarity: GachaResult['rarity'];
  if (roll < sRate)        rarity = 'S';
  else if (roll < sRate + 0.051) rarity = 'A'; // 四星 5.1%
  else                     rarity = poolDef.pickBC(); // 三星兜底

  // 3. S 级判定是否 UP（小保底 50/50）
  let isRateUp = false;
  if (rarity === 'S') {
    if (pity.guaranteedFeaturedNext) {
      isRateUp = true;               // 大保底：必出 UP
      pity.guaranteedFeaturedNext = false;
    } else {
      isRateUp = rng() < 0.5;        // 小保底：50% 歪
      if (!isRateUp) pity.guaranteedFeaturedNext = true; // 歪了，下次必出
    }
    pity.pullCount = 0;              // 出 S，重置抽数
  } else {
    pity.pullCount++;
  }
  pity.totalPulls++;
  return { itemId: pickItem(rarity, isRateUp), rarity, isRateUp, seed, rollValue: roll };
}
```

```
软保底概率爬坡曲线（以原神五星为例）：
概率
6%|                              /----(P74起递增)
   |                            /
0.6%|============--------------/............(P1-P73 基础概率)
   |________________________________________ 抽抽数
   0    10   20   30   40   50   60   70 74  80  90
   ←────── 基础 0.6% ──────────→←软保底→←硬保底100%→
```

| 保底类型 | 触发条件 | 概率行为 | 玩家体验 |
|----------|----------|----------|----------|
| 软保底 | 累计抽数 ≥ 阈值（如 74） | 每抽递增概率，逐步拉满 | 缓解「非酋感」，保底附近出金概率高 |
| 硬保底 | 累计抽数 = 上限（如 90） | 概率强制 100%，必出最高稀有度 | 绝对兜底，保证「不会无限非酋」 |
| 无保底（纯随机） | 无 | 每抽独立同分布，理论上可永久不出 | 极差体验，现代抽卡游戏基本弃用 |
| 命定定轨（武器池） | 选定 2 把定轨武器，歪了累计命定值 | 命定值满 2 必出定轨武器 | 武器池专属，再叠加一层保底保障 |

#### 二、卡池（Banner）配置驱动与 UP 歪率逻辑

卡池是「数据驱动」的：策划在后台改 JSON 配置，服务端热加载，不改一行代码。UP 歪率逻辑是限定池的灵魂——「小保底 50% 是 UP，歪了下次必出（大保底）」。

```typescript
interface BannerDef {
  bannerId: string;
  type: 'standard' | 'limited' | 'beginner' | 'event';
  itemPool: RarityTier[];           // 每个稀有度档位的物品列表
  rateUpItemIds: number[];          // UP 物品（限定角色/武器）
  pityConfig: { softPityStart: number; hardPity: number; sRate: number };
  startTime: number;                // 卡池生效时间戳
  endTime: number;                  // 卡池过期时间戳
}

interface RarityTier {
  rarity: 'S' | 'A' | 'B';
  baseRate: number;                 // 该档基础概率
  items: number[];                  // 该档位候选物品
}

// UP 歪率核心逻辑（在 rollOnce 内部）：
// 当抽到 S 级时，判断是否触发「大小保底」
function resolveRateUp(pity: PityState, banner: BannerDef, rng: () => number): boolean {
  if (pity.guaranteedFeaturedNext) {
    // 大保底：上次歪了，这次必出 UP
    pity.guaranteedFeaturedNext = false;
    return true;
  }
  // 小保底：50% 概率出 UP，50% 歪（出常驻 S）
  const isUp = rng() < 0.5;
  if (!isUp) pity.guaranteedFeaturedNext = true;  // 歪了 → 下次大保底
  return isUp;
}
// 玩家术语：首次出 S 是「小保底」（50% 歪），
//           歪了之后下次必出 UP 是「大保底」（100% UP）
```

```
卡池生命周期状态机：
  Scheduled ──到达startTime──▶ Active ──到达endTime──▶ Expired
   (配置已加载)                  │                       │
                                 │ UP角色                │ 限定物品
                                 │ 按概率出              │ 回归常驻池
                                 ▼                       ▼
                              (玩家抽取)            MergedToStandard
```

| 卡池类型 | 保底计数 | UP歪率 | 物品池 | 适用场景 |
|----------|----------|--------|--------|----------|
| 常驻池 | 独立计数，永不过期 | 无 UP（无歪率概念） | 全部常驻角色/武器 | 长期可抽，新手主要接触 |
| 限定池 | 独立计数，卡池结束冻结 | 小保底 50%，歪后大保底 100% | 常驻 + UP 限定角色 | 版本活动主力变现池 |
| 新手池 | 独立计数，限抽次数 | 首抽必出指定 S（福利） | 精简物品池 | 新玩家引导期，只开一次 |
| 活动池 | 共享/独立按运营配置 | 按配置（可能 100% UP） | 活动主题物品 | 节日/联动，时效性强 |

#### 三、抽卡事务原子性与幂等发放

单抽和十连都是「预扣费 → 批量 Roll → 发放 → 写日志」的完整事务，任何环节失败必须整体回滚。幂等键 `pullId` 由 `hash(playerId, bannerId, pullSequence)` 生成，客户端重传同一请求只会命中已处理结果。

```typescript
async function atomicPull(player, bannerDef, count: 1 | 10): Promise<GachaResult[]> {
  const pullId = hash(`${player.id}:${bannerDef.bannerId}:${player.pullSequence}`);
  // 0. 幂等检查：若已处理过该 pullId，直接返回历史结果
  const cached = await db.getPullLog(pullId);
  if (cached) return cached.results;

  const cost = count * COST_PER_PULL;
  const results: GachaResult[] = [];

  try {
    // 1. 预扣费（事务第一步，先扣钱再 Roll）
    await player.debitCurrency(cost);   // 扣除钻石/原石

    // 2. 批量 Roll（全部在内存完成，未落库前不发奖）
    for (let i = 0; i < count; i++) {
      const seed = generateSeed();      // 加密强随机种子
      results.push(rollOnce(bannerDef, player.pity, seed));
      player.pullSequence++;
    }

    // 3. 一次性事务发放奖励 + 写日志（同一 DB 事务）
    await db.transaction(async (tx) => {
      await tx.grantRewards(player.id, results);   // 入背包/角色库
      await tx.updatePity(player.id, player.pity); // 保底计数持久化
      await tx.insertPullLog({                      // 审计日志
        pullId, playerId: player.id, bannerId: bannerDef.bannerId,
        seedList: results.map(r => r.seed), results,
      });
    });

    return results;
  } catch (err) {
    // 回滚路径：任何环节失败，全额退还货币，保底计数不前移
    await player.refundCurrency(cost);
    player.pullSequence -= count;       // 撤回序号前进
    logger.error('atomicPull failed, rolled back', { pullId, err });
    throw err;                          // 上抛，客户端提示重试
  }
}
```

| 抽取方式 | 事务粒度 | 扣费方式 | 幂等复杂度 | 动画体验 |
|----------|----------|----------|------------|----------|
| 单抽 | 单条事务 | 单次扣 1 抽费用 | 简单（pullId 唯一） | 短平快，单发抽卡动画 |
| 十连 | 整批事务（全成功/全回滚） | 一次性扣 10 抽 | 中等（需保证批内不重复） | 经典十连抽，有保底四星 |
| 命定定轨双轨（武器池） | 整批 + 命定值子状态事务 | 一次性扣费 + 命定值更新 | 复杂（命定值独立持久化） | 动画含命定值光效反馈 |

### ⚡ 实战经验

1. **保底计数跨服丢失**：早期保底计数存在单服内存，玩家跨服登录后计数清零，一位氪佬连续投诉「我在 A 服抽了 85 发，转服后保底没了」——排查发现计数未持久化到账号级。改为账号级持久化（每次抽卡写入 DB）后，跨服保底一致性恢复。教训：保底计数是玩家最敏感的资产之一，必须和货币一样做账户级持久化。
2. **UP 歪率写反成 100%**：上线初期一个限定池的 UP 判定逻辑写成 `Math.random() < 0.5 ? rateUp : random`，但 rateUp 分支永远命中——所有出金全是 UP 角色，小保底实际变成了 100%。事故期间全服多产出 200+ 个限定角色，最终回档 + 全额补偿（补偿成本约 30 万元）。教训：概率逻辑必须有单元测试覆盖「连续 10000 次 Roll 统计分布」。
3. **十连部分失败只扣不赔**：十连抽第 7 发时发放服务超时，前端显示扣了 10 连的钻石但只收到 6 个物品，玩家立即投诉。原因是发放未做整体事务，逐个发放中途失败。改为「批量 Roll 全部成功后再一次性事务发放 + 失败整体回滚扣费」后，此类客诉归零。
4. **概率展示与实际不符被举报**：某卡池宣传「SSR 综合概率 3%」但实际 Roll 逻辑只对前 50 抽适用基础概率，导致大量玩家前 50 抽出率远低于 3%，被玩家社群统计发现并举报至监管。合规整改要求：概率展示必须涵盖「含保底后的综合概率」并标注，违规面临下架。务必让展示的概率和实际期望值一致。
5. **卡池到期未下架**：一个限时卡池因运维手动配置的结束时间写错（多了一个 0，变成 10 倍时长），过期 9 天后才被发现，期间玩家继续抽已下架的限定池产出大量限定角色。教训：卡池下架必须由服务端定时任务（cron）自动执行，不能依赖人工，且每次抽卡都要校验「当前时间是否在卡池有效期内」。

### 🔗 相关问题

- 抽卡保底计数在「限定池 A → 限定池 B」切换时如何继承？是独立计数还是共享计数？不同游戏的策略差异（原神独立计数 vs 某些游戏同类池共享）背后的运营考量是什么？
- 如果抽卡过程中玩家网络断开（请求已到达服务端但响应未返回），重连后如何判定「这次抽卡是否成功」？幂等键 pullId 的生成策略如何保证不重复发放？
- 「命定定轨」（武器池选择 2 把定轨武器，歪了累计命定值，满 2 必出）这种复杂保底的状态机如何设计？相比普通限定池，事务和持久化复杂度增加了多少？
