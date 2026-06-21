---
title: "延迟补偿（Lag Compensation）如何实现公平的命中判定？"
category: "network"
level: 4
tags: ["延迟补偿", "Hit Registration", "服务器权威", "FPS"]
related: ["network/client-side-prediction", "network/frame-vs-state-sync"]
hint: "你在 80ms 延迟下瞄准敌人爆头，服务器看到的却是 80ms 前的位置——怎么判？"
---

## 参考答案

### ✅ 核心要点

1. **问题本质**：玩家看到的是"过去"的目标位置（因为网络延迟），瞄准的是延迟渲染的残影，但服务器需要判定"此刻"的碰撞
2. **服务器端延迟补偿**：服务器回溯到客户端开火时刻的世界状态，用那个时刻的碰撞体做命中判定
3. **需要保存历史快照**：服务器必须缓存最近 N 毫秒的实体位置历史（通常为 max_client_latency + interpolation_delay）
4. **与插值缓冲的关系**：客户端渲染延迟（interpolation delay）决定了"看到多旧的世界"，服务器回溯深度必须覆盖这个延迟
5. **公平性权衡**：低延迟玩家有优势，延迟补偿在缩小差距但不能完全消除

### 📖 深度展开

**问题全景：**

```
时间轴（以服务器时间为基准）：

t=100ms   敌人实际在位置A
t=140ms   敌人移动到位置B（服务器知道）
t=180ms   敌人的位置A的数据包到达客户端
t=180ms   客户端渲染敌人在位置A（插值延迟≈80ms）
t=180ms   玩家看到敌人在A → 瞄准A → 扣下扳机
t=220ms   开火指令到达服务器
          此时服务器看到的敌人在位置C（比A更远）

问题：如果服务器用 t=220ms 时的碰撞体判定 → 射偏（打在C附近）
      但玩家瞄准的明明是A → 玩家觉得"我明明打中了！"
```

**服务器端延迟补偿算法：**

```csharp
// ============ 服务器实现 ============

// 历史快照缓冲：保存最近 500ms 的世界状态
struct WorldSnapshot {
    public float timestamp;
    public Dictionary<int, EntityState> entities; // entityId → state
}

private const float MAX_HISTORY = 0.5f; // 500ms
private RingBuffer<WorldSnapshot> historyBuffer = new(capacity: 64);

void OnClientFire(NetFireEvent fireEvent) {
    // 1. 计算客户端开火时的服务器时间
    //    fireEvent.sendTime 是客户端发送时的时间戳
    //    服务器需要估算这个时间对应的服务器时间
    float serverTime = GetServerTime();
    float clientRenderTime = serverTime - fireEvent.clientInterpolationDelay;

    // 2. 在历史快照中查找最接近 clientRenderTime 的两个快照
    var (before, after) = historyBuffer.FindBracketing(clientRenderTime);

    if (before == null || after == null) {
        // 超出历史窗口，无法补偿 → 拒绝或用当前状态
        RejectFire("Too much latency for compensation");
        return;
    }

    // 3. 在两个快照间做插值，得到精确时刻的世界状态
    float alpha = (clientRenderTime - before.timestamp) / (after.timestamp - before.timestamp);
    var interpolatedState = InterpolateWorldState(before, after, alpha);

    // 4. 用回溯后的状态做射线检测
    RaycastHit hit;
    Vector3 fireOrigin = fireEvent.origin;
    Vector3 fireDir = fireEvent.direction;

    // 临时恢复历史碰撞体进行检测
    using (var restoreScope = new TemporalScope(interpolatedState)) {
        if (Physics.Raycast(fireOrigin, fireDir, out hit, range)) {
            int hitEntityId = hit.entityId;
            int damage = CalcDamage(fireEvent.weapon, hit.bodyPart);

            // 5. 命中！对当前（非历史）状态应用伤害
            ApplyDamage(hitEntityId, damage);
            BroadcastHitConfirm(fireEvent.shooterId, hitEntityId, damage);
        }
    }
}

// 每个网络 tick 保存快照
void OnNetworkTick() {
    var snapshot = new WorldSnapshot {
        timestamp = GetServerTime(),
        entities = CaptureAllEntityStates()
    };
    historyBuffer.Add(snapshot);

    // 清理过期快照
    while (historyBuffer.Oldest.timestamp < GetServerTime() - MAX_HISTORY) {
        historyBuffer.RemoveOldest();
    }
}
```

**回溯检测示意图：**

```
服务器时间轴：
     t=100    t=140    t=180    t=220    t=260
      │        │        │        │        │
  ────┼────────┼────────┼────────┼────────┼────→
      │                              │
      │                         开火到达服务器
      │                         (t=220)
      │
      │◄──── 回溯到 clientRenderTime ────►│
      │                                   │
      │  使用 t=180 时刻的世界状态做命中检测
      │  此时敌人确实在位置A（玩家看到的）
      │
      │  → 命中判定：✅ 爆头！
      │
      │  但伤害应用到 t=220 的当前血量
```

**不同方案的对比：**

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **无补偿** | 用当前状态判定 | 实现简单 | 高延迟玩家完全没法玩 |
| **服务器回溯** | 回到开火时刻判定 | 公平，玩家"所见即所打" | 实现复杂，需要历史快照 |
| **客户端权威** | 客户端说打中就打中 | 零延迟反馈 | 外挂天堂 |
| **混合方案** | 服务器回溯 + 客户端预测命中 | 体验最好 | 双重实现，调试困难 |

**Favor the Shooter 原则：**

大多数竞技 FPS（CS2、Valorant、Apex）都采用"Favor the Shooter"——如果你在屏幕上瞄准了目标，就算打中了。这意味着：

- 高延迟玩家的射击会被"优待"（回溯到他们看到的世界）
- 低延迟玩家可能感到"我明明躲到掩体后面了还是被打中"（因为对方看到的你还是 100ms 前的位置）
- 这是刻意的设计选择：射击体验 > 躲避体验

### ⚡ 实战经验

- **历史窗口大小**：通常设为 200-500ms。太短则高延迟玩家无法被补偿，太长则内存开销大且易被利用
- **射击游戏 vs MOBA 的区别**：FPS 几乎必须做延迟补偿，MOBA 由于技能通常是范围/指向性的，对精度的要求低很多，补偿策略可以更简单
- **回溯碰撞检测的性能**：不能对整个物理世界做回溯。优化方案是只对"可被射击的实体"保存位置历史（AABB 级别），射线检测时手动遍历历史 AABB
- **反作弊考虑**：恶意客户端可以伪造过大的 `clientInterpolationDelay` 来获得更长回溯窗口。服务器应 clamp 这个值到合理范围（如最大 200ms）
- **弹道可视化**：命中后给双方播放弹道特效，开火者看到"打中了"，被击者看到"被打了"，减少争议感

### 🔗 相关问题

- 客户端预测与服务端调和如何配合延迟补偿？
- 如何防止玩家利用高延迟获得不当优势？
- 在 MOBA / RTS 中延迟补偿策略有什么不同？
