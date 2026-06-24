---
title: "游戏副本/关卡（Instance）系统架构怎么设计？如何管理实例生命周期、Boss 遭遇战和掉落分配？"
category: "architecture"
level: 4
tags: ["副本系统", "实例管理", "遭遇战状态机", "刷怪波次", "掉落分配"]
related: ["architecture/matchmaking-room-session-architecture", "architecture/save-system-architecture", "architecture/combat-system-architecture"]
hint: "不是「进场景打个怪」——是「实例隔离 + 遭遇战状态机 + 刷怪波次编排 + 事务性掉落分配 + 实例服务器调度」"
---

## 参考答案

### ✅ 核心要点

1. **实例隔离（Instance Isolation）是多人副本的根本前提**：每个小队/团队进入一个独立的空间镜像，互不可见、互不干扰，怪物、机关、进度都独立。没有隔离就没有「队 1 把 BOSS 打了队 2 卡关」的串台灾难。实例可以是一进程、一房间、或同进程内的独立场景状态，关键是用 InstanceId 隔离所有可变状态。
2. **遭遇战状态机（Encounter FSM）驱动 Boss 战节奏**：Boss 战不是「一条血」，而是「阶段切换 + 机制触发 + 狂暴计时」的多阶段状态机——血量阈值触发阶段转换（P1→P2→P3）、阶段切换重置技能池和场地机关、超时狂暴强制收尾。状态机让 Boss 行为可编排、可复用、可策划配置，而不是写死在脚本里。
3. **刷怪波次编排（Wave Director）管控制战斗密度**：副本的「爽快感」来自波次节奏——清完一波→短暂喘息→新一波，由 WaveDirector 按时间或事件触发刷怪，控制同屏怪量上限（防卡顿）、刷怪点轮换（防蹲守）、精英/普通配比。这是「关卡手感」的工程化体现。
4. **事务性掉落分配（Loot Allocation）是公平与防刷的核心**：BOSS 倒下后的掉落生成与分配必须事务化——服务端按确定性种子 Roll 出战利品池，再按分配规则（需求贪婪 / 积分 DKP / 拍卖 / 个人掉落）发放，任意环节失败必须回滚。个人掉落（Personal Loot）已成为主流，彻底消除「黑装备」争吵。
5. **实例生命周期管理（Instance Lifecycle）覆盖创建到销毁全链路**：实例从「申请→加载场景→等待全员就位→进行中→结算→销毁」是完整的状态机，每个阶段都有超时（等待就位 60s、战斗无操作 15min 自动解散），并支持断线重连恢复（重进实例继续进度）和副本进度存档（卡关可下周继续）。

### 📖 深度展开

#### 一、实例隔离与实例服务器调度

每个副本实例是一个独立的可变状态容器，用 InstanceId 作为唯一主键隔离所有数据。调度层面，实例可以跑在专用服务器（Dedicated）、大厅托管服务器（Lobby-hosted）或同进程独立场景中：

```typescript
interface InstanceContext {
  instanceId: string;               // 唯一主键，隔离一切可变状态
  dungeonDefId: number;             // 副本定义（来自配置表）
  ownerPartyId: string;             // 所属小队/团队
  state: 'Loading' | 'WaitingReady' | 'InProgress' | 'Settling' | 'Destroyed';
  members: InstanceMember[];        // 在场成员 + 断线标记
  progress: InstanceProgress;       // 已击杀 BOSS、已开门、激活的机关
  spawnSeed: number;                // 确定性刷怪种子
}

interface InstanceProgress {
  defeatedBosses: Set<number>;      // 已击杀 Boss 集合（用于解锁后续区域/跳关）
  activatedMechanisms: Map<number, boolean>;  // 机关/门状态
  checkpointId: number | null;      // 当前复活检查点
  elapsedSeconds: number;           // 已用时长（用于计时副本/成就速通）
}
```

| 调度模式 | 隔离强度 | 资源开销 | 扩展性 | 适用场景 |
|---------|---------|---------|--------|---------|
| 专用实例服务器 | 强（独立进程） | 高（每实例一进程） | 差（受服务器数限制） | 大型团本、高规格 3A |
| 大厅托管实例 | 中（同机隔离） | 中（共享机器） | 中 | 中小型副本、主流 MMO |
| 同进程独立场景 | 弱（逻辑隔离） | 低 | 好 | 单机副本、休闲闯关 |

#### 二、遭遇战状态机与 Boss 阶段编排

Boss 战是多阶段状态机，血量阈值触发阶段切换，每个阶段有独立的技能池、场地机关和仇恨规则。狂暴计时器（Enrage Timer）是防止「磨血」的最后兜底：

```
Boss 遭遇战状态机：
  Idle ──激活──▶ Phase1 (100%~66% HP)
                    │ 技能池: [普攻, 顺劈, 召唤小怪]
                    │ 机关: 无
                    ▼ 血量 < 66%
                 Phase2 (66%~33% HP)
                    │ 技能池: [普攻, 范围AOE, 击退, 地火]
                    │ 机关: 火墙开启（场地缩小）
                    │ 切换时清空现有施法 → 全屏转场动画 1.5s
                    ▼ 血量 < 33%
                 Phase3 (33%~0% HP)
                    │ 技能池: [普攻, 狂暴连击, 全屏大招]
                    │ 机关: 全场地板机制
                    ▼ 血量 = 0%
                 Defeated ──▶ 触发掉落 + 解锁传送门
                 
  任一阶段 ──超时(300s)──▶ Enrage (狂暴: 攻击力×3, 强制收尾)
```

```typescript
type BossPhase = 'phase1' | 'phase2' | 'phase3' | 'enrage' | 'defeated';

interface BossEncounter {
  defId: number;
  currentPhase: BossPhase;
  hpThresholds: Record<BossPhase, number>;   // 进入该阶段的血量阈值
  phaseSkillPools: Record<BossPhase, number[]>; // 每阶段技能池
  enrageTimerSec: number;                      // 狂暴倒计时
  onPhaseEnter: (phase: BossPhase) => void;    // 阶段切换钩子（播动画/清仇恨/开机关）
}

function tickEncounter(enc: BossEncounter, dt: number, bossHp: number) {
  enc.enrageTimerSec -= dt;
  if (enc.enrageTimerSec <= 0 && enc.currentPhase !== 'enrage') {
    transitionPhase(enc, 'enrage');  // 狂暴收尾
    return;
  }
  // 血量阈值驱动阶段切换（单调递进，不可逆）
  const next = computePhaseByHp(enc, bossHp);
  if (next && next !== enc.currentPhase) transitionPhase(enc, next);
}
```

#### 三、事务性掉落分配与分配规则

掉落生成必须用服务端确定性种子（ ownerId + bossId + instanceId 派生 ），保证可审计、可复现、防客户端篡改。分配规则是可插拔策略：

```typescript
interface LootResult {
  tradeId: string;            // 幂等键（防重复发放）
  ownerId: string;            // 个人掉落：玩家自己；团队掉落：队长/系统
  bossId: number;
  seed: number;               // 确定性种子，写日志可复现
  items: LootItem[];          // Roll 出的战利品
  distribution: 'personal' | 'group_greed' | 'dkp' | 'auction';
}

async function settleLoot(enc: BossEncounter, party: PartyMember[]): Promise<LootResult[]> {
  // 个人掉落：每个成员独立 Roll，彻底消除争吵
  const results: LootResult[] = [];
  for (const m of party) {
    const seed = hash(m.playerId, enc.defId, enc.instanceId);  // 确定性
    const items = rollLootTable(enc.defId, seed);
    await preAllocateToInventory(m.playerId, items, (r) => r.tradeId); // 事务性入包
    results.push({ tradeId: genId(), ownerId: m.playerId, bossId: enc.defId, seed, items, distribution: 'personal' });
  }
  return results;
}
```

| 分配模式 | 公平性 | 争吵风险 | 实现复杂度 | 主流度 |
|---------|--------|---------|-----------|--------|
| 需求贪婪（Need/Greed） | 中（靠自觉） | 高（恶意需求） | 低 | 老牌 MMO |
| 积分 DKP | 高（按贡献） | 低 | 中（需积分账本） | 硬核公会 |
| 拍卖分金 | 高（价高者得+平分金） | 低 | 中高 | 公会团本 |
| 个人掉落（Personal） | 高（各自独立） | 极低 | 中 | 现代主流（WOW/暗黑） |

### ⚡ 实战经验

1. **实例串台事故**：早期用 PartyId 当隔离主键，结果两个小队同时进同名副本时互相看到对方的怪和掉落，一周内收到 50+「我打了 BOSS 却没掉落」的客诉。改为全局唯一 InstanceId 隔离后归零。教训：隔离主键必须是每次进入副本新建的唯一 ID，不能复用队伍 ID。
2. **Boss 阶段切换卡死**：P2→P3 转场动画播放期间玩家仍能攻击，导致 Boss 在转场中被击杀触发了一个未定义的「转场中死亡」分支，Boss 卡在 1 血无法击杀也无法复活，全团被卡在副本 20 分钟直到管理员强制重置。修复：阶段切换期间设置 Boss 无敌帧 + 排队延迟死亡判定到动画结束。
3. **刷怪卡顿**：一波刷怪一次性 Instantiate 40 只怪导致同帧卡顿 180ms（中端机型），玩家明显感到「进房瞬卡」。改为分帧刷怪（每帧刷 5 只，跨 8 帧）后峰值降到 22ms。同屏怪量上限应配置化（PC 60 / 移动端 30）。
4. **掉落 Roll 不可审计**：早期没存种子，玩家投诉「我打了 50 次没出橙装」（期望概率 5%，50 次全不出的概率约 7.7%，全服每天必然发生若干次），客服无法查证。加入 ownerId+bossId 派生种子 + Roll 序列日志后，能复现「本次 seed=8821，第 3 次 roll=0.94 > 0.95 阈值差 0.01」的确定性证据，客诉处理时长从 3 天降到 15 分钟。
5. **副本进度丢失**：玩家打到最终 Boss 前断线，重连后发现进度清零（实例已销毁），怒退游。加入「副本进度存档」（关键检查点持久化，24h 内可续打）后，重连留存率提升 40%。进度存档要和存档系统联动，且要设过期清理避免存档膨胀。

### 🔗 相关问题

- 副本断线重连时，玩家如果在 Boss 战中掉线，重连后是恢复到战斗中还是算失败？如何避免「掉线规避团灭」的作弊？与 matchmaking-room 的会话恢复如何衔接？
- 大型团本（40 人）的实例服务器如何做负载均衡？单实例跑不下时，能否把不同区域的玩家分到不同子实例再做跨服同步？
- 副本的「每日次数限制」和「CD 锁定」如何在服务端权威实现？如何防止客户端改本地时间绕过 CD？
