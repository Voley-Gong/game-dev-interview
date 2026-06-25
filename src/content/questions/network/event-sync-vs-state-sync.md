---
title: "事件同步与状态同步在战斗系统中如何选型？技能释放、伤害结算、Buff传播的同步模式深度对比"
category: "network"
level: 3
tags: ["事件同步", "状态同步", "战斗同步", "RPC", "复制"]
related: ["network/frame-vs-state-sync", "network/property-replication-system", "network/rpc-vs-replicated-properties"]
hint: "玩家放一个 AOE 大招，伤害到底是「服务端算好结果同步下来」还是「同步施法事件各端自己算」？"
---

## 参考答案

### ✅ 核心要点

1. **事件同步（Event-based Sync）**：传播"发生了什么"（施法、受击），各端自行模拟结果——低带宽、高确定性要求
2. **状态同步（State-based Sync）**：传播"现在是什么"（血量、Buff 列表、位置）——服务端权威、客户端只渲染
3. **混合模式是实战主流**：关键状态走服务端权威同步，表现层事件走广播，兼顾一致性与手感
4. **伤害结算的三种模式**：服务端全算（公平但延迟高）、客户端预测+服务端确认（流畅但需回滚）、事件广播+各端算（省带宽但不防作弊）
5. **选型取决于品类**：MOBA/竞技偏向服务端权威+预测确认，ARPG/MMO 偏向混合，休闲/PVE 可用事件广播

### 📖 深度展开

#### 事件同步 vs 状态同步：本质区别

```
【事件同步】客户端A 攻击 客户端B
  A → Server: "我发动了技能#1024，目标=Area(15,20,r=5)"
  Server → All: 广播事件 SkillCast(uid=A, skillId=1024, pos=(15,20), r=5)
  各端收到后：本地播放特效、计算伤害、更新血条

【状态同步】客户端A 攻击 客户端B
  A → Server: "我发动了技能#1024，目标=Area(15,20,r=5)"
  Server: 计算 AOE 命中 B、C、D，伤害分别 200/150/0
  Server → A: "B.hp -= 200, C.hp -= 150, 你的技能 CD=8s"
  Server → B: "你受到 200 伤害，来源=技能#1024"
  Server → C: "你受到 150 伤害，来源=技能#1024"
  各端收到后：播放受击特效、更新血条
```

#### 三种伤害结算模式对比

| 维度 | 服务端全算 | 客户端预测+确认 | 事件广播+各端算 |
|------|-----------|----------------|----------------|
| **公平性** | ★★★★★ | ★★★★ | ★★ |
| **响应速度** | ★★（等 RTT） | ★★★★★（即时） | ★★★★ |
| **带宽消耗** | 中 | 中 | 低 |
| **反作弊** | 强 | 中（需回滚） | 弱 |
| **回滚复杂度** | 无 | 高 | 无 |
| **适合品类** | 竞技/MOBA | FPS/动作 | PVE/休闲 |

#### 混合模式的实战架构

大多数商业游戏采用混合模式，将不同类型的数据走不同通道：

```
┌─────────────────────────────────────────────┐
│                  游戏数据分类                 │
├──────────┬──────────┬───────────────────────┤
│ 权威状态  │ 表现事件  │     瞬时 RPC          │
│ (State)  │ (Event)  │     (One-shot)        │
├──────────┼──────────┼───────────────────────┤
│ 血量/护盾 │ 施法动作  │  "播放音效#42"        │
│ Buff层数 │ 受击特效  │  "屏幕震动"           │
│ 技能CD   │ 死亡动画  │  "飘字: -200"         │
│ 位置/朝向 │ 击杀公告  │  "客户端粒子触发"     │
├──────────┼──────────┼───────────────────────┤
│ 服务端权威│ 服务端广播│  服务端→客户端        │
│ 定期快照  │ 或P2P转发 │  Unreliable通道       │
│ Reliable │ Reliable  │  丢了就算了           │
└──────────┴──────────┴───────────────────────┘
```

#### 代码示例：AOE 技能的混合同步

```csharp
// ========== 服务端：AOE 伤害结算 ==========
public void OnSkillCast(Player caster, int skillId, Vector3 center, float radius)
{
    // 1. 服务端计算命中目标（权威判定）
    var hits = Physics.OverlapSphere(center, radius)
        .Where(col => col.GetComponent<Player>()?.Team != caster.Team)
        .Select(col => col.GetComponent<Player>())
        .ToList();

    // 2. 对每个命中目标造成伤害
    var damageResults = new List<(ulong targetId, int damage)>();
    foreach (var target in hits)
    {
        int dmg = CalculateDamage(caster, target, skillId);
        target.Hp -= dmg; // 修改权威状态
        damageResults.Add((target.Uid, dmg));
    }

    // 3. 广播表现事件（特效、音效、飘字）——丢失可接受
    BroadcastEvent(new SkillCastEvent
    {
        CasterId = caster.Uid,
        SkillId = skillId,
        Center = center,
        Radius = radius,
        Hits = damageResults // 附带结果，让客户端知道打到了谁
    }, DeliveryMethod.UnreliableSequenced);

    // 4. 权威状态走 Reliable 通道（血量、CD、Buff）
    // ——由属性复制系统自动处理，下一 Tick 同步
}
```

```csharp
// ========== 客户端：收到 AOE 事件后的表现 ==========
public void OnSkillCastEvent(SkillCastEvent evt)
{
    // 1. 立即播放施法特效（不等服务端状态同步）
    SpawnVfx(evt.SkillId, evt.Center, evt.Radius);

    // 2. 为每个命中目标播放受击表现
    foreach (var hit in evt.Hits)
    {
        var target = EntityMgr.GetEntity(hit.targetId);
        if (target == null) continue;

        // 飘字、受击动画、音效
        SpawnDamageText(target, hit.damage);
        target.PlayAnim("HitReact");
    }

    // 3. 注意：不修改本地血量！
    // 血量由属性复制系统在下一 Tick 从服务端同步过来
    // 这样即使事件包丢失，最终血量依然正确
}
```

#### Buff/状态效果的同步策略

```csharp
// Buff 同步的关键问题：时长倒计时在哪里算？
// 方案A：服务端权威，每次 Tick 同步剩余时间（精确但带宽高）
// 方案B：服务端下发 (buffId, expireAt=服务器绝对时间)，客户端自行倒计时
// 方案C：服务端只下发 apply/remove 事件，客户端管时长（省流量但不防作弊）

// 实战推荐方案B：
public struct BuffState
{
    public int BuffId;
    public int Stacks;
    public long ExpireTimestampMs; // 服务端绝对时间戳
    public float Magnitude;
}

// 客户端用 (ExpireTimestamp - ServerTime) 做剩余倒计时
// 好处：断线重连后不会出现 Buff 时长错乱
```

### ⚡ 实战经验

1. **飘字伤害不要走状态同步**：飘字是瞬时表现，走 Reliable 状态同步会导致延迟和堆积。用 unreliable 事件通道，丢了就丢了——玩家不会注意到偶尔少一个伤害飘字
2. **Buff 叠加层数必须权威同步**：层数影响游戏逻辑（如5层引爆），必须由服务端控制。但表现层（图标高亮）可以客户端预测
3. **AOE 命中判定放服务端**：客户端网络延迟不同，各自做碰撞检测会导致"我明明躲开了还是被打中"的体验。服务端用延迟补偿做统一判定
4. **死亡事件优先级最高**：玩家死亡是状态变更，必须 Reliable。但死亡动画和击杀公告可以走 unreliable 事件——即使没收到，血量为0的状态同步也会让角色倒下

### 🔗 相关问题

- RPC 与 Replicated Property 在引擎层面有什么区别？各自适合同步什么数据？
- 帧同步为什么不需要区分事件同步和状态同步？
- 断线重连后，如何恢复错过的 Buff/状态变更？
