---
title: "高速移动实体（子弹/投射物）的网络同步如何实现？"
category: "network"
level: 3
tags: ["投射物同步", "命中判定", "外推", "确定性弹道", "网络同步"]
related: ["network/lag-compensation.md", "network/entity-interpolation.md"]
hint: "子弹飞得太快，插值追不上——想想确定性模拟和命中验权的组合拳。"
---

## 参考答案

### ✅ 核心要点

1. **投射物同步的核心矛盾**：速度极快（可能单帧跨越多个碰撞体），常规插值/外推在高速下会产生明显穿模
2. **两种主流路线**：服务端模拟（权威命中）vs 客户端确定性模拟（即时反馈 + 服务端校验）
3. **Hitscan（即时命中）** 尤其适合子弹类武器——服务端用 Raycast + Lag Compensation 做权威判定
4. **Projectile（飞行物）** 如火箭、榴弹需要做连续碰撞检测（CCD）+ 服务端权威位置同步
5. **客户端表现层用外推/特效补偿**，逻辑层始终以服务端为准

### 📖 深度展开

#### 命中判定的三种模型

| 模型 | 适用场景 | 带宽 | 反作弊 | 实现复杂度 |
|------|----------|------|--------|------------|
| **Hitscan（射线命中）** | 子弹、激光、步枪 | 低（仅一发事件） | 强（服务端算） | 低 |
| **Projectile（飞行物）** | 火箭、手雷、弓箭 | 高（持续位置同步） | 中（需物理验证） | 中高 |
| **Hybrid（混合）** | 薄墙穿透、爆炸范围 | 中 | 中 | 高 |

#### Hitscan 流程（最常用）

```
客户端                              服务端
  │  开火（Fire eventId=42）          │
  │ ──────────────────────────────→ │
  │                                  │  1. 验证射速/弹药
  │                                  │  2. 读取客户端视角时刻
  │                                  │  3. Lag Comp: 回滚目标位置
  │                                  │  4. Raycast(t=clientTime)
  │                                  │  5. 命中判定 → 扣血事件
  │ ←──────────────────────────────  │
  │  HitResult(targetId, damage)     │
  │  播放开火特效 + 命中标记          │
```

#### Projectile（飞行物）服务端模拟

```csharp
// 服务端投射物组件
public class ServerProjectile : INetEntity {
    public Vector3 Velocity;       // 初速度
    public float Gravity = 9.8f;
    public float Lifetime = 5f;
    
    // 服务端固定步长模拟
    public void Tick(float dt) {
        // CCD：高速时拆分子步
        int subSteps = Mathf.CeilToInt(Velocity.magnitude * dt / 0.5f);
        float subDt = dt / subSteps;
        
        for (int i = 0; i < subSteps; i++) {
            Velocity.y -= Gravity * subDt;
            var prevPos = Position;
            Position += Velocity * subDt;
            
            // 连续碰撞检测
            if (Physics.Raycast(prevPos, Velocity.normalized, 
                out var hit, Velocity.magnitude * subDt)) {
                OnImpact(hit);
                return;
            }
        }
    }
    
    // 定期广播位置（降频，如 10Hz）
    public Snapshot PackSnapshot() {
        return new Snapshot {
            EntityId = Id,
            Pos = Position,
            Vel = Velocity,
            Timestamp = NetworkTime.Now
        };
    }
}
```

```csharp
// 客户端预测投射物
public class ClientProjectile : INetEntity {
    private Vector3 _serverPos;
    private float _serverRecvTime;
    
    public void Update(float dt) {
        // 本地确定性模拟（与服务端相同公式）
        Velocity.y -= 9.8f * dt;
        Position += Velocity * dt;
        
        // 收到服务端快照时做误差修正
        if (_hasServerUpdate) {
            var interpPos = Vector3.Lerp(_serverPos, Position, 
                (NetworkTime.Now - _serverRecvTime) / _tickRate);
            Position = interpPos;
            _hasServerUpdate = false;
        }
    }
}
```

#### 关键参数调优

| 参数 | 推荐值 | 说明 |
|------|--------|------|
| 同步频率 | 10–20 Hz | 投射物位置广播频率 |
| CCD 子步长 | 0.5m 以内 | 防止穿墙 |
| 客户端预测窗口 | 100–200ms | 超过就等服务端纠正 |
| 最大存活时间 | 5–10s | 防止幽灵弹 |

### ⚡ 实战经验

- **不要用普通插值同步投射物**——20Hz 的快照根本追不上 200m/s 的子弹，客户端只能靠确定性外推 + 低频修正
- **Hitscan 武器务必加服务端射速校验和弹匣校验**，否则触发器客户端可以伪造无限连发
- **爆炸类（AoE）武器把伤害计算完全放服务端**，客户端只负责渲染爆炸特效，伤害数字等服务端广播
- **高速物体务必开 CCD**，Unity 中使用 `ContinuousDynamic` 检测模式，自研引擎中手动拆分射线步长

### 🔗 相关问题

- 延迟补偿（Lag Compensation）如何与 Hitscan 结合实现公平命中？
- 客户端预测的投射物与服务端位置不一致时如何平滑修正？
- 大量投射物（如弹幕游戏）如何做带宽优化？
