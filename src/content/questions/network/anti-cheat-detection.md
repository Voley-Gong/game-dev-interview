---
title: "游戏服务端如何做反作弊检测？速度检验、物理验证、行为检测怎么实现？"
category: "network"
level: 3
tags: ["反作弊", "服务器权威", "安全", "行为检测"]
related: ["network/server-authority-vs-client-trust", "network/lag-compensation"]
hint: "核心原则：Never Trust The Client。服务端权威是反作弊的基础。"
---

## 参考答案

### ✅ 核心要点

1. **服务器权威是基石**：所有关键状态（位置、伤害、血量）由服务端计算，客户端只发送输入
2. **速度检验（Speed Hack）**：检测单位时间内的位移是否超过理论上限
3. **物理验证**：服务端跑简化物理模拟，校验客户端报告的位置是否物理可行
4. **行为检测**：统计异常模式（命中率、反应时间、资源获取速率）
5. **多层防御**：实时拦截 + 离线分析 + 玩家举报 + 机器学习异常检测

### 📖 深度展开

#### 反作弊防御体系全景

```
┌─────────────────────────────────────────────┐
│              反作弊防御层级                   │
├─────────────────────────────────────────────┤
│  Layer 4: 离线分析（赛后回放审计 + ML 模型） │
│  Layer 3: 行为统计（命中率/反应时间分布）     │
│  Layer 2: 游戏逻辑验证（物理/数值校验）       │
│  Layer 1: 服务器权威（状态计算在服务端）      │
│  Layer 0: 传输安全（加密 + 防重放 + 防篡改）  │
└─────────────────────────────────────────────┘
```

#### 1. 速度检验（Speed Hack Detection）

最常见的外挂类型：加速器，让角色移动/攻击速度变快。

**核心思路**：服务端根据时间差和位移差计算实际速度，与配置上限比较。

```csharp
// 服务端速度检验
public class SpeedChecker
{
    const float MAX_SPEED = 8.0f;          // 配置的最大速度
    const float TOLERANCE = 1.15f;         // 15% 容差（网络延迟波动）

    Vector3 _lastPosition;
    float _lastTimestamp;

    public bool ValidateMove(Vector3 newPos, float timestamp)
    {
        float dt = timestamp - _lastTimestamp;
        if (dt <= 0) return false;  // 时间不能倒流

        Vector3 delta = newPos - _lastPosition;
        float distance = delta.magnitude;
        float speed = distance / dt;

        float allowedMax = MAX_SPEED * TOLERANCE;

        // 考虑技能加速、载具等buff
        allowedMax *= GetSpeedMultiplier(timestamp);

        if (speed > allowedMax)
        {
            // 超速！回滚位置并记录
            LogCheat("SPEED_HACK", speed, allowedMax);
            return false;  // 拒绝本次移动
        }

        _lastPosition = newPos;
        _lastTimestamp = timestamp;
        return true;
    }
}
```

**进阶：基于 RTT 的动态容差**

```
容差速度 = 基础最大速度 × (1 + RTT补偿系数 + Jitter补偿系数)

RTT = 100ms → 容差 +10%
RTT = 300ms → 容差 +25%
```

#### 2. 物理验证（Physics Validation）

检验客户端报告的移动轨迹是否物理可行，主要防范穿墙、瞬移、飞行挂。

```csharp
// 服务端简化物理校验（不需要完整物理引擎）
public class PhysicsValidator
{
    // 射线检测：两点之间是否有障碍物
    public bool ValidateTrajectory(Vector3 from, Vector3 to, float dt)
    {
        float dist = Vector3.Distance(from, to);

        // 检查1：移动距离不超过单帧上限
        if (dist > MAX_MOVE_PER_FRAME) return false;

        // 检查2：射线检测，判断是否穿墙
        if (Physics.Linecast(from, to, out hit, collisionMask))
        {
            // 墙体阻挡，不允许直线穿越
            // 但需考虑角色半径（膨胀检测）
            if (hit.distance < dist - CHARACTER_RADIUS)
                return false;
        }

        // 检查3：Y 轴合理性（不能飞）
        float yDelta = to.y - from.y;
        if (yDelta > MAX_JUMP_HEIGHT) return false;  // 超过跳跃高度

        // 检查4：跌落速度合理性
        if (yDelta < 0 && Mathf.Abs(yDelta / dt) > GRAVITY_MAX)
            return false;

        return true;
    }
}
```

#### 3. 行为统计分析

不直接判定某次操作是否作弊，而是统计长期模式：

| 检测项 | 正常范围 | 异常阈值 | 说明 |
|--------|----------|----------|------|
| 爆头率 | 15-35% | >65% | 自瞄透视 |
| 反应时间 | 200-400ms | <80ms | 自动触发 |
| 命中率 | 20-50% | >85% | 锁定辅助 |
| 资源获取/小时 | 5-20万 | >100万 | 刷金挂 |
| 技能CD命中率 | 波动 | 恒定100% | 脚本宏 |

```csharp
// 统计累积器：滑动窗口统计
public class BehaviorStatistics
{
    private RingBuffer<float> _reactionTimes;  // 最近 100 次
    private RingBuffer<bool> _headshots;       // 最近 100 次击杀

    public void RecordKill(float reactionTime, bool isHeadshot)
    {
        _reactionTimes.Push(reactionTime);
        _headshots.Push(isHeadshot);

        // 每 50 次击杀检测一次
        if (_headshots.Count >= 50)
        {
            float headshotRate = _headshots.Count(x => x) / (float)_headshots.Count;
            if (headshotRate > 0.65f)
            {
                FlagSuspicious("ABNORMAL_HEADSHOT_RATE", headshotRate);
            }
        }
    }
}
```

#### 4. 传输层防护

```
防重放攻击：
  每个数据包携带递增序列号（Sequence Number）
  服务端维护已接收的最大序号，拒绝旧包

防篡改：
  关键操作（购买、交易）使用 HMAC 签名
  密钥在登录时通过非对称加密协商

防抓包分析：
  协议加密（AES-CTR / ChaCha20）
  随机填充防流量分析
```

```csharp
// 防重放：序列号校验
public class ReplayProtection
{
    uint _expectedSeq = 0;

    public bool Validate(NetPacket packet)
    {
        if (packet.Seq < _expectedSeq)
        {
            // 旧包/重放包，丢弃
            return false;
        }
        _expectedSeq = packet.Seq + 1;
        return true;
    }
}
```

#### 反作弊方案对比

| 方案 | 实时性 | 误判率 | 开发成本 | 适用场景 |
|------|--------|--------|----------|----------|
| 服务器权威 | 实时 | 极低 | 高 | 所有竞技游戏 |
| 速度检验 | 实时 | 低 | 低 | 移动类外挂 |
| 物理验证 | 实时 | 中 | 中 | 穿墙/飞行挂 |
| 行为统计 | 延后 | 中 | 中 | 自瞄/透视 |
| ML 异常检测 | 离线 | 较高 | 高 | 复杂外挂模式 |
| 客户端反作弊SDK | 实时 | 低 | 极高 | 封杀注入类外挂 |

### ⚡ 实战经验

- **容差设计是最难的平衡**：太严格会误判高延迟正常玩家，太宽松又放过外挂。建议用动态容差——根据玩家历史 RTT 和 Jitter 自适应调整
- **不要只靠实时拦截**：很多外挂会在"合法范围"内操作（比如速度只加快 10%），需要离线统计分析才能发现
- **物理验证不需要完整物理引擎**：服务端跑简单射线检测 + 高度校验就够了，完整物理模拟太贵
- **客户端反作弊 SDK（如 EAC、BattlEye）是补充而非替代**：它们可以被绕过，服务器权威才是不可绕过的底线

### 🔗 相关问题

- 帧同步游戏如何做反作弊？所有客户端都跑相同模拟，怎么判定谁是外挂？
- 如何在服务端权威和高延迟之间取得平衡？CSP 与 Lag Compensation 如何配合？
- 区分"高手"和"外挂"的统计学方法有哪些？如何降低误封率？
