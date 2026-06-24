---
title: "大逃杀（Battle Royale）缩圈机制与区域伤害的网络同步如何实现？"
category: "network"
level: 3
tags: ["大逃杀", "缩圈", "区域伤害", "状态同步", "服务器权威", "确定性"]
related: ["network/server-authority-vs-client-trust.md", "network/snapshot-delta-sync.md", "network/anti-cheat-detection.md"]
hint: "缩圈是服务器权威的全局状态，客户端只做视觉表现。思考圈的数据如何用最小带宽同步给 100 人。"
---

## 参考答案

### ✅ 核心要点

1. **缩圈是服务器权威状态**：安全区（Safe Zone）、毒圈（Blue Zone）、红区（Red Zone）的参数全部由服务器计算和下发，客户端只做表现层插值
2. **最小带宽同步**：一个圈的状态只需 ~40 字节（中心点 x/z + 半径 + 时间戳 + 阶段号），用增量同步只在变化时下发
3. **区域伤害计算在服务器**：玩家是否在毒圈内、伤害结算完全由服务器判定，客户端只播放掉血动画和特效
4. **客户端预测圈的变化**：客户端根据服务器下发的"下一阶段参数 + 倒计时"自行计算当前圈位置和半径，无需每帧同步
5. **反作弊关键**：加速移动、穿墙出圈、无限血等作弊必须在服务器层拦截，客户端表现不可信

### 📖 深度展开

#### 缩圈数据模型

```csharp
// 大逃杀缩圈状态（服务器权威）
public struct ZoneState
{
    public int Phase;           // 当前阶段（0=初始圈, 1-8=逐级缩小）
    public Vector2 Center;      // 圈中心坐标（2D 平面，y 轴忽略）
    public float Radius;        // 当前圈半径
    public float DamagePerSec;  // 毒圈伤害/秒

    // 下一阶段的参数（客户端据此预测）
    public Vector2 NextCenter;  // 下一阶段圈中心
    public float NextRadius;    // 下一阶段圈半径
    public float PhaseEndTime;  // 当前阶段结束时间（服务器时间戳）
    public float ShrinkDuration;// 收缩持续时间

    // 序列化：紧凑编码
    // Phase(1B) + Center(4B×2) + Radius(4B) + Damage(2B)
    // + NextCenter(4B×2) + NextRadius(4B) + Times(4B×2)
    // ≈ 38 bytes per zone state
    public byte[] Serialize()
    {
        using var ms = new MemoryStream(40);
        using var bw = new BinaryWriter(ms);
        bw.Write((byte)Phase);
        bw.Write(Center.x); bw.Write(Center.y);
        bw.Write(Radius);
        bw.Write((short)(DamagePerSec * 10)); // 0.1 精度
        bw.Write(NextCenter.x); bw.Write(NextCenter.y);
        bw.Write(NextRadius);
        bw.Write(PhaseEndTime);
        bw.Write(ShrinkDuration);
        return ms.ToArray();
    }
}
```

#### 服务器端缩圈生命周期

```
Phase 0: 初始大圈（等待玩家降落）
  ↓ 倒计时 60s
Phase 1: 第 1 次缩圈（半径缩至 70%，缩圈耗时 30s）
  ↓ 倒计时 120s（安全区内搜索物资）
Phase 2: 第 2 次缩圈（半径缩至 50%，缩圈耗时 25s）
  ↓ ...
Phase 8: 最终圈（半径缩至极小，缩圈耗时 10s）
  ↓ 决出胜者

关键时间节点全部由服务器管理，客户端只接收通知。
```

```csharp
// 服务器端缩圈管理器
public class ZoneManager
{
    private ZoneState currentZone;
    private float serverTime;
    private const int MAX_PHASE = 8;

    // 缩圈参数表（策划配置）
    private static readonly ZonePhaseConfig[] PhaseConfigs = new[]
    {
        // phase, radiusRatio, waitTime, shrinkTime, damagePerSec
        new ZonePhaseConfig(0, 1.0f,  60f, 0f,   0f),    // 初始
        new ZonePhaseConfig(1, 0.7f, 120f, 30f,  1f),    // 第 1 圈
        new ZonePhaseConfig(2, 0.5f,  90f, 25f,  2f),    // 第 2 圈
        new ZonePhaseConfig(3, 0.35f, 75f, 20f,  4f),    // 第 3 圈
        new ZonePhaseConfig(4, 0.22f, 60f, 15f,  7f),    // 第 4 圈
        new ZonePhaseConfig(5, 0.12f, 45f, 12f, 10f),    // 第 5 圈
        new ZonePhaseConfig(6, 0.06f, 30f, 10f, 12f),    // 第 6 圈
        new ZonePhaseConfig(7, 0.02f, 20f,  8f, 15f),    // 第 7 圈
        new ZonePhaseConfig(8, 0.005f, 0f, 10f, 20f),    // 最终圈
    };

    public void Update(float deltaTime)
    {
        serverTime += deltaTime;

        if (currentZone.Phase >= MAX_PHASE) return;

        var config = PhaseConfigs[currentZone.Phase];

        // 阶段切换
        if (serverTime >= currentZone.PhaseEndTime)
        {
            AdvanceToNextPhase();
            BroadcastZoneUpdate();  // 只在阶段切换时广播
        }
    }

    private void AdvanceToNextPhase()
    {
        int nextPhase = currentZone.Phase + 1;
        var config = PhaseConfigs[nextPhase];

        // 在当前圈内随机选下一个圆心
        float newRadius = currentZone.Radius * config.RadiusRatio;
        // 确保新圈与旧圈有交集（玩家有机会跑进去）
        Vector2 offset = RandomInsideCircle(currentZone.Radius - newRadius);
        Vector2 newCenter = currentZone.Center + offset;

        currentZone.NextCenter = newCenter;
        currentZone.NextRadius = newRadius;
        currentZone.DamagePerSec = config.DamagePerSec;
        currentZone.PhaseEndTime = serverTime + config.WaitTime + config.ShrinkTime;
        currentZone.ShrinkDuration = config.ShrinkTime;
        currentZone.Phase = nextPhase;
    }

    // 伤害结算（每 Tick 调用）
    public void ApplyDamage(List<Player> players)
    {
        foreach (var player in players)
        {
            if (!player.IsAlive) continue;

            float distToCenter = Vector2.Distance(player.Position2D, currentZone.CurrentCenter);
            if (distToCenter > currentZone.CurrentRadius)
            {
                // 在毒圈外，服务器直接扣血
                player.TakeDamage(currentZone.DamagePerSec * tickDeltaTime);
            }
        }
    }
}
```

#### 客户端圈表现（插值 + 预测）

```csharp
// 客户端：收到服务器 ZoneUpdate 后，自行计算视觉表现
public class ZoneRenderer : MonoBehaviour
{
    private ZoneState serverZone;
    private float localTimeOffset;  // 客户端与服务器时间差

    void OnZoneUpdate(ZoneState newState)
    {
        serverZone = newState;
        // 不依赖服务器每帧同步，而是根据 PhaseEndTime 自行计算
    }

    void Update()
    {
        float serverNow = Time.time + localTimeOffset;
        var config = PhaseConfigs[serverZone.Phase];

        // 计算当前圈的实际位置和半径（插值收缩）
        float shrinkStartTime = serverZone.PhaseEndTime - serverZone.ShrinkDuration;
        float shrinkProgress = Mathf.Clamp01((serverNow - shrinkStartTime) / serverZone.ShrinkDuration);

        // 当前圈从上一阶段参数插值到下一阶段参数
        Vector2 currentCenter = Vector2.Lerp(prevCenter, serverZone.NextCenter, shrinkProgress);
        float currentRadius = Mathf.Lerp(prevRadius, serverZone.NextRadius, shrinkProgress);

        // 更新视觉表现（Shader / Mesh / ParticleSystem）
        zoneVisual.SetPosition(currentCenter);
        zoneVisual.SetRadius(currentRadius);
        zoneVisual.SetDamageLevel(serverZone.DamagePerSec);
    }
}
```

#### 带宽优化分析（100 人对局）

| 同步内容 | 频率 | 单次大小 | 100 人总带宽 |
|---------|------|---------|-------------|
| 缩圈阶段更新 | 每阶段 1 次（~2 分钟） | 40 bytes | 4 KB / 阶段 |
| 玩家位置快照 | 每服务器 Tick（20Hz） | 16 bytes × 100 人 | 32 KB/s |
| 毒圈伤害广播 | 不需要广播 | 0（服务器内部） | 0 |
| 倒计时校准 | 每 5 秒 1 次 | 4 bytes | 400 B/s |

**结论**：缩圈同步本身带宽极小（< 1 KB/s），真正的带宽瓶颈是 100 人的位置同步。缩圈只需要在阶段切换时做一次全量广播 + 定期校准即可。

#### 红区轰炸 / 空投等特殊区域

```
安全区（Safe Zone）：    白圈，圈内安全              → 全局状态，定期同步
毒圈（Blue Zone）：      安全区外的蓝色区域，持续伤害  → 由安全区推导，不需额外同步
红区（Red Zone）：       随机区域，轰炸伤害           → 独立事件，按需同步
空投（Care Package）：   随机投放点，争夺物资          → 独立事件，全量广播
```

```csharp
// 红区轰炸：服务器随机生成，客户端只做表现
public struct RedZoneState
{
    public Vector2 Center;
    public float Radius;        // 轰炸范围
    public float StartTime;
    public float Duration;      // 轰炸持续时间
    public int BombCount;       // 炸弹总数
    // 客户端根据 BombCount 和 Duration 自行随机生成炸弹落点
    // 服务器只判定实际伤害
}

// 同步策略：红区生成时全量广播一次（~20 bytes）
// 伤害结算完全在服务器，不广播"哪颗炸弹炸到了谁"
```

#### 反作弊要点

| 作弊类型 | 检测方法 | 处理 |
|---------|---------|------|
| 改客户端数据绕过毒圈伤害 | 服务器权威扣血，客户端血量不可信 | 服务器直接结算 |
| 加速跑出毒圈 | 服务器校验移动速度上限 | 拉回 + 记录异常 |
| 预知下一阶段圈位置 | 下一阶段参数仅在阶段切换时广播 | 不提前下发 |
| 修改客户端显示假安全区 | 伤害以服务器判定为准 | 修改无效 |
| 透视看红区炸弹落点 | 炸弹落点服务器生成后才广播 | 延迟下发 |

### ⚡ 实战经验

- **缩圈参数一定是策划配置表驱动，不要硬编码**：PUBG/和平精英每次赛季调整都会改缩圈时间和伤害。用 Excel/ScriptableObject 配置表，热更即可调整
- **圈心随机算法要保证新圈一定在旧圈内**：`RandomInsideCircle(oldRadius - newRadius)` 确保新圆心偏移不会超出旧圈范围，否则玩家根本跑不进去，会引发强烈负面体验
- **客户端时钟校准很关键**：缩圈收缩是客户端根据服务器时间自行计算的，如果客户端时钟偏了 2 秒，玩家会看到"圈已经缩到我头上了但毒圈还没扣血"或反过来。每 5-10 秒做一次 NTP 校准
- **100 人同屏的毒圈边缘是性能地狱**：大量玩家聚集在圈边时，视觉特效（Shader、粒子）+ 物理碰撞 + 伤害计算叠加。优化方案：LOD 分级渲染远处玩家、伤害计算降频（从每帧改为每 0.5 秒结算一次）

### 🔗 相关问题

- [服务器权威 vs 客户端可信：信任边界如何选择？](server-authority-vs-client-trust.md)
- [状态同步的快照机制与增量更新如何实现？](snapshot-delta-sync.md)
- 大逃杀 100 人同屏的位置同步带宽如何优化？（AOI + 优先级调度）
