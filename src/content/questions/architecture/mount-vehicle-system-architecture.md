---
title: "游戏的坐骑/载具系统架构怎么设计？如何支撑骑乘切换、属性继承和多人共乘？"
category: "architecture"
level: 3
tags: ["坐骑系统", "载具系统", "状态机", "属性继承", "网络同步"]
related: ["architecture/combat-system-architecture", "architecture/animation-system-architecture", "architecture/inventory-system-architecture", "architecture/buff-status-effect-system"]
hint: "不是简单的换皮模型——是骑乘状态机 + 碰撞体/运动学切换 + 属性继承链 + 多人共乘网络同步的系统设计"
---

## 参考答案

### ✅ 核心要点

1. **坐骑数据模型分离**：MountDef（配置：模型资源 ID、动画集、基础速度、类型分类）与 MountInstance（运行时：等级、熟练度、外观幻化 ID、时效）分离，坐骑作为独立的资产线而非角色的附属物品。外观 ID（幻化皮）与属性 ID 分离，允许「骑 A 的属性、看 B 的模型」，满足商业化幻化需求。

2. **骑乘状态机驱动切换**：角色有 Ground（步行）→ Mounting（上马中）→ Riding（骑乘）→ Dismounting（下马中）→ Ground 的完整状态机。上下马必须由动画事件驱动（动画播到「踩蹬」帧才真正切换碰撞体），不能瞬切，否则会出现角色悬浮或卡模。战斗、受击、死亡等事件会强制触发下马流程。

3. **碰撞体与运动学参数切换**：骑乘时角色自身的胶囊碰撞体隐藏，由坐骑的碰撞体接管物理交互；速度、转向半径、加速度等运动学参数全部替换为坐骑的值。下马时恢复角色参数，但必须做缓动过渡（Lerp），否则速度突变会导致穿模或角色弹飞。

4. **属性继承链与 Modifier 叠加**：坐骑的被动属性（如「移速 +20%」「战斗攻击力 +50」）通过 Modifier 链叠加到角色属性上。核心坑是双来源防重复加成——角色装备「骑术手套」加移速 + 坐骑本身加移速，必须用独立的 Modifier 来源 ID 区分，避免同源加成叠加两次。坐骑升级解锁更多属性槽。

5. **多人载具座位系统**：载具（马车、船、机甲）支持多个座位（Seat），司机（Driver）控制移动，乘客（Passenger）可自由转动视角但不能控移动。座位绑定角色的 Transform，网络同步以载具为单元（乘客位置随载具计算，不单独同步位置），大幅降低带宽。

6. **坐骑外观/幻化与时效管理**：幻化系统允许外观与属性解绑；时效坐骑（租用、活动限定）需过期自动卸下并通知玩家。坐骑槽与角色装备槽复用一套 Modifier 架构但不耦合数据结构，通过事件解耦。

### 📖 深度展开

#### 1. 骑乘状态机与动画事件驱动

骑乘切换不是简单的「换模型」，而是涉及动画、碰撞体、运动学、属性、网络同步的级联变更，必须用状态机严格管控。

```
骑乘状态机：

  ┌────────┐  触发上马   ┌──────────┐  动画播完   ┌────────┐
  │ GROUND │ ──────────→ │ MOUNTING │ ──────────→ │ RIDING │
  └────┬───┘             │(播放上马 │  (动画事件   └───┬────┘
       ↑                 │ 动画)    │   回调切换)     │ 触发下马
       │                 └────┬─────┘                ↓
       │  动画播完            │ 取消(受击)      ┌───────────┐
       │  ←───────────────────┘                │DISMOUNTING│
       │                                      │(播放下马) │
       │                 ←─────────────────────┘
       │  碰撞体恢复+属性移除
  ┌────┴───┐
  │ GROUND │
  └────────┘

强制下马触发条件：
  - 受到攻击（受击硬直 > 阈值）
  - 进入战斗状态（部分坐骑不允许战斗骑乘）
  - 角色死亡
  - 进入禁止骑乘区域（室内/副本 Boss 房）
  - 坐骑时效到期
```

```typescript
// 上马动画事件驱动的碰撞体切换
class MountController {
  // 动画"踩蹬完成"帧触发此回调（非状态切换瞬间）
  onAnimationEvent_MountReady() {
    // 此时角色手已搭上马背，切换碰撞体不突兀
    this.player.capsuleCollider.enabled = false;
    this.mount.capsuleCollider.enabled = true;
    // 运动学参数切换
    this.player.movement.SwitchKinematics(this.mount.kinematics);
    // 网络广播：该玩家进入骑乘态，同步单元变为坐骑
    this.network.Broadcast(new MountStateChangePacket {
      playerId: this.player.id,
      mountId: this.mount.defId,
      state: MountState.Riding,
    });
  }
}
```

强制下马的触发条件矩阵：

| 触发条件 | 是否立即下马 | 是否播下马动画 | 备注 |
|---------|------------|--------------|------|
| 受击（轻伤） | 否 | — | 仅打断上马，骑乘中受击不强制下马 |
| 受击（重伤硬直） | 是 | 是 | 硬直 > 0.5s 判定落马 |
| 进入战斗 | 配置决定 | 是 | 战斗型坐骑允许，旅行型不允许 |
| 角色死亡 | 是 | 否（直接倒地） | 复活后默认步行 |
| 禁骑区域 | 是 | 是 | 区域触发器检测 |
| 坐骑过期 | 是 | 是 | 时效到期自动卸下 |

#### 2. 碰撞体切换与运动学参数

骑乘前后，角色的物理表现完全不同，碰撞体和运动学必须整体替换：

```typescript
interface KinematicsConfig {
  moveSpeed: number;       // 移动速度 m/s
  turnSpeed: number;       // 转向速度 rad/s
  acceleration: number;    // 加速度
  capsuleRadius: number;   // 碰撞体半径
  capsuleHeight: number;   // 碰撞体高度
  mass: number;            // 质量 kg
}

// 角色（步行）参数          // 坐骑（骑乘）参数
const playerKinematics = {  const mountKinematics = {
  moveSpeed: 5,               moveSpeed: 12,       // +140%
  turnSpeed: 8,               turnSpeed: 3,        // 转向更慢
  acceleration: 20,           acceleration: 8,     // 起步更肉
  capsuleRadius: 0.3,         capsuleRadius: 0.6,  // 更宽
  capsuleHeight: 1.8,         capsuleHeight: 2.5,  // 更高
  mass: 70,                   mass: 500,           // 质量大幅增加
};
```

下马时的速度过渡（防穿模/弹飞）：

```typescript
// 错误做法：瞬间切回角色速度 → 速度从 12 突变到 5，角色像撞墙一样弹停
// 正确做法：Lerp 缓动过渡
function OnDismount() {
  const lerpDuration = 0.3; // 300ms 过渡
  this.StartCoroutine(SpeedLerp(this.mount.moveSpeed, playerKinematics.moveSpeed, lerpDuration));
  // 碰撞体有 200ms 重叠期：角色碰撞体先启用，坐骑碰撞体延迟移除
  this.player.capsuleCollider.enabled = true;
  this.Schedule(() => this.mount.capsuleCollider.enabled = false, 0.2);
}
```

碰撞体切换流程：

```
下马瞬间：
  T+0ms    : 触发下马动画
  T+0ms    : 角色碰撞体启用(与坐骑重叠)
  T+200ms  : 坐骑碰撞体禁用(重叠期结束,角色已站稳)
  T+0~300ms: 速度从 12 → 5 Lerp 过渡
  T+动画结束: 角色完全恢复步行态
  
  ※ 重叠期(200ms)防止角色脚未落地就失去坐骑碰撞体支撑而穿地
```

#### 3. 多人载具座位系统与网络同步

```typescript
interface VehicleSeat {
  seatIndex: number;        // 座位序号 0=司机位
  occupantId: number;       // 当前乘坐者角色 ID，0=空座
  role: SeatRole;           // Driver | Passenger | Gunner
  bindBone: string;         // 绑定的骨骼节点名（如 "seat_0"）
}

class Vehicle {
  vehicleId: number;
  seats: VehicleSeat[];     // 座位数组
  driver: number;           // 司机角色 ID

  // 玩家上车：占用空座
  board(playerId: number, preferSeat: number): boolean {
    const seat = this.findEmptySeat(preferSeat);
    if (!seat) return false;
    seat.occupantId = playerId;
    if (seat.role === SeatRole.Driver) this.driver = playerId;
    // 角色Transform绑定到座位骨骼
    this.bindPlayerToSeat(playerId, seat.bindBone);
    return true;
  }
}
```

司机与乘客的权限差异：

| 操作 | 司机（Driver） | 乘客（Passenger） | 炮手（Gunner） |
|------|--------------|------------------|---------------|
| 控制移动 | ✅ | ❌ | ❌ |
| 转动视角 | 仅前方 | 自由 360° | 限炮塔范围 |
| 使用技能 | ❌（驾驶中） | ✅ | 仅炮塔技能 |
| 下车 | ✅（靠边停车） | ✅（随时） | ✅ |
| 切换座位 | ✅ | ✅（需空座） | ✅ |

网络同步单元决策——这是多人载具最关键的架构决策：

```
方案A（错误）：每个乘客独立同步位置
  客户端 → 服务器: 4个玩家各自上报位置 (4 × 200B/帧 = 800B/帧)
  问题: 乘客位置应由载具决定,独立同步导致抖动/穿模

方案B（正确）：以载具为同步单元
  客户端 → 服务器: 仅司机上报载具位置 (200B/帧)
                  乘客只同步上下车事件(偶发)
  其他客户端: 收到载具位置 → 本地计算乘客位置(座位偏移+载具Transform)
  
  带宽对比: 800B/帧 → 200B/帧, 降幅 75%
```

### ⚡ 实战经验

1. **下马穿模问题**：下马瞬间角色碰撞体恢复但坐骑模型还在播下马动画（尾巴扫动），角色卡在坐骑模型里。解决方案：200ms 碰撞体重叠期 + 角色位移微调（下马点偏移 0.5m 到坐骑侧面），修复前约 50% 下马操作会卡模，修复后降到 < 1%。

2. **坐骑速度作弊防御**：早期版本速度由客户端计算，出现改客户端速度参数实现「瞬移挂」（坐骑移速改成 999）。改为服务端权威判定——客户端只做预测插值，服务端按 MountDef.maxSpeed 钳制上报位移，超限回弹。移动校验延迟从客户端的 0ms 增加到服务端 100ms，但玩家基本无感（插值掩盖了延迟）。

3. **载具碰撞抖动治理**：载具质量远大于角色（马车 2000kg vs 角色 70kg），物理引擎解算时载具撞墙的反作用力会弹飞角色甚至穿墙。将载具设为 Kinematic（不受物理力影响，由代码驱动位置）或将质量比设为 > 10:1，碰撞抖动从每帧 2px 降到基本为 0。Kinematic 方案的代价是载具不能被爆炸冲击波推动，需根据玩法取舍。

4. **共乘同步带宽实测**：4 人共乘马车场景，方案 A（每人独立同步）实测带宽 800B/帧 × 60fps = 48KB/s/观察者；方案 B（以载具为单元）200B/帧 × 60fps = 12KB/s/观察者，降幅 75%。当战场有 10 辆马车 + 50 个观察者时，方案 A 总带宽 24MB/s（接近带宽上限），方案 B 仅 6MB/s，是方案能否上线的决定性因素。

5. **坐骑属性继承的来源冲突**：角色佩戴「骑术大师戒指」（骑乘时移速 +10%）+ 坐骑本身被动（移速 +20%），若都用同一个 Modifier 源 ID 会被判为同源而只生效一次（或叠加两次导致超速）。解决方案：每个 Modifier 携带 `sourceType`（Equipment | Mount | Buff | GuildTech），同 sourceType 内部去重，跨 sourceType 允许叠加，用位图记录已应用的源防重复。

### 🔗 相关问题

1. 飞行坐骑和地面坐骑的运动学有什么本质区别？飞行的高度检测、空域限制（禁飞区）、气流扰动系统怎么设计？
2. 坐骑的装备槽（马鞍、缰绳、马铠）怎么和角色装备系统共用一套 Modifier 架构又不耦合数据结构？通过接口抽象还是事件总线？
3. 大规模攻城战（50+ 载具同屏）的物理性能怎么优化？载具 LOD（远处简化碰撞体/关闭物理）和分帧更新策略怎么做？
