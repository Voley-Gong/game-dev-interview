---
title: "AOI 消息频率控制与优先级调度：如何管理数千实体的带宽分配？"
category: "network"
level: 4
tags: ["AOI", "带宽优化", "优先级调度", "LOD", "MMO"]
related: ["network/aoi-algorithm", "network/snapshot-delta-sync", "network/serialization-compression"]
hint: "AOI 解决了'看谁'的问题，但'以多高频率看'和'先看谁'同样关键——这就是优先级调度的战场。"
---

## 参考答案

### ✅ 核心要点

1. **AOI 只解决了"裁剪"问题**：确定哪些实体在视野内，但不同实体的更新频率和精度需求不同
2. **距离 LOD（Level of Detail）**：近处实体高频更新，远处实体低频更新，指数级节省带宽
3. **优先级队列调度**：每帧从待发送集合中按优先级选取，优先发送重要实体和关键事件
4. **兴趣热度（Interest Heat）**：不仅看距离，还要考虑实体类型、交互关系、视觉焦点等维度
5. **带宽预算（Bandwidth Budget）**：给每帧设定带宽上限，超限时自动降级，保证网络不溢出

### 📖 深度展开

#### 距离 LOD 分层更新

```
以玩家为中心的同心圆分层：

                ┌─────────────────────────┐
                │    远景层 (>80m)         │
                │    频率: 2 Hz            │
                │    精度: 位置取整到米     │
                │  ┌───────────────────┐  │
                │  │   中景层 (30-80m)  │  │
                │  │   频率: 5 Hz       │  │
                │  │   精度: 位置到分米  │  │
                │  │  ┌─────────────┐  │  │
                │  │  │ 近景层(<30m) │  │  │
                │  │  │ 频率: 15 Hz  │  │  │
                │  │  │ 精度: 完整   │  │  │
                │  │  └─────────────┘  │  │
                │  └───────────────────┘  │
                └─────────────────────────┘

带宽节省估算（100 个实体在视野内）：
  无 LOD:  100 × 15Hz = 1500 条/秒
  三级 LOD: 10×15 + 30×5 + 60×2 = 420 条/秒
  节省约 72%
```

#### 优先级评分模型

```csharp
public class UpdatePriority {
    // 实体更新优先级评分
    public float CalculateScore(Entity entity, Player viewer) {
        float distance = Vector3.Distance(entity.pos, viewer.pos);
        
        // 基础分：距离越近分越高
        float score = 1000f / (distance + 1f);
        
        // 类型加权
        if (entity is Player) score *= 2.0f;        // 玩家比 NPC 重要
        if (entity is Projectile) score *= 0.3f;     // 子弹低优先级
        if (entity.isMoving) score *= 1.5f;          // 移动中的实体优先
        if (entity.isInCombat) score *= 3.0f;        // 战斗状态最高优先
        
        // 时间衰减：很久没更新的实体加分（公平性）
        float timeSinceLastUpdate = Time.time - entity.lastUpdateTime;
        score *= (1f + timeSinceLastUpdate * 0.5f);
        
        // 交互关系加权
        if (viewer.targetEntityId == entity.id) score *= 5.0f; // 当前目标
        if (entity.HasPendingActionOn(viewer)) score *= 4.0f;  // 对我有动作
        
        return score;
    }
}
```

#### 带宽预算调度器

```csharp
// 每帧调度流程
public void ScheduleUpdates(Player player) {
    int bandwidthBudgetBytes = player.bandwidthLimitPerFrame; // 如 4096 字节
    var candidates = new List<(Entity, float score)>();
    
    // 1. 收集所有 AOI 内实体并评分
    foreach (var entity in player.aoiSet) {
        float score = CalculateUpdateScore(entity, player);
        candidates.Add((entity, score));
    }
    
    // 2. 按分数降序排列
    candidates.Sort((a, b) => b.score.CompareTo(a.score));
    
    // 3. 按预算发送
    int usedBytes = 0;
    foreach (var (entity, score) in candidates) {
        int cost = EstimateUpdateSize(entity);
        if (usedBytes + cost > bandwidthBudgetBytes) {
            // 预算不足，标记为"延迟到下一帧"
            entity.deferUpdate[player.id] = true;
            continue;
        }
        
        SendEntityUpdate(player, entity);
        usedBytes += cost;
        entity.lastUpdateTime = Time.time;
    }
}
```

#### 对比：不同类型游戏的调度策略

| 游戏类型 | 调度策略 | 带宽预算 | 关键差异 |
|----------|----------|----------|----------|
| FPS（64人） | 固定高频率，无 LOD | 宽松（每人 2-4 Mbps） | 人数少，可以"全量同步" |
| MMO（千人同屏） | 多级 LOD + 严格预算 | 紧张（每人 50-100 Kbps） | 不可能全量，必须优先级裁剪 |
| MOBA（10人） | 全员高频，无需 LOD | 充裕 | 人数极少，全量推送 |
| 大逃杀（100人） | 动态 LOD + 可视性剔除 | 中等（100-200 Kbps） | 地图大，可视性变化剧烈 |

#### 关键事件即时推送

优先级调度有一个致命陷阱：高优先级实体霸占带宽时，新生成的关键事件可能被延迟。解决方案：

```
消息分两类：
  1. 状态更新（State Update）→ 走优先级队列，可延迟
  2. 事件通知（Event Notification）→ 走即时通道，不参与调度
     例：技能释放、死亡、拾取、任务触发

实现：
  ├── 优先级调度通道（State Updates）  ← 带宽预算 70%
  └── 即时事件通道（Events）           ← 带宽预算 30%（不可压缩）
```

#### 动态频率调节（Adaptive Rate）

```csharp
// 根据网络质量动态调整更新频率
public void AdjustRates(Player player) {
    float packetLossRate = player.GetPacketLossRate();
    int rtt = player.GetSmoothedRTT();
    
    if (packetLossRate > 0.1f || rtt > 300) {
        // 网络差：降低频率，增大每包数据量
        player.updateRateMultiplier = 0.5f;
        player.enableDeltaCompression = true;
    } else if (packetLossRate < 0.02f && rtt < 80) {
        // 网络好：恢复正常或提高频率
        player.updateRateMultiplier = 1.0f;
    }
    // 平滑过渡，避免频率突变
    player.updateRateMultiplier = Lerp(
        player.updateRateMultiplier, 
        targetMultiplier, 
        0.1f * Time.deltaTime
    );
}
```

### ⚡ 实战经验

1. **LOD 边界处的"闪烁"问题**：实体跨过 LOD 边界时更新频率突变，玩家会感受到"卡顿一帧"。解决方案是在边界处做频率渐变过渡，而非阶跃切换
2. **不要忽略"刚刚离开 AOI"的实体**：实体移出 AOI 后应发送一个 RemoveEntity 消息，否则客户端会出现幽灵实体。这个消息走即时通道
3. **优先级评分中的时间衰减很关键**：没有时间衰减项时，高优先级实体会持续霸占带宽，低优先级实体可能永远得不到更新（starvation）
4. **带宽预算要在协议层面校验**：不要只依赖调度器估算，实际发送时要统计真实字节数并反馈到下一帧的预算计算中

### 🔗 相关问题

- AOI 九宫格 vs 四叉树在千人同屏场景下哪个更优？
- Delta Compression 在状态同步中如何与 LOD 更新频率配合？
- 如何设计带宽监控系统，在玩家网络条件恶化时优雅降级而非直接断线？
