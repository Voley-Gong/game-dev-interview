---
title: "混合权威模型：客户端预测移动的服务器验证策略（Speed Hack / Teleport 检测）"
category: "network"
level: 3
tags: ["混合权威", "移动验证", "反作弊", "服务器验证", "客户端预测", "面试高频"]
related: ["network/client-side-prediction", "network/server-authority-vs-client-trust", "network/anti-cheat-detection"]
hint: "纯服务器权威手感差，纯客户端权威容易被外挂——混合模型如何兼顾体验与安全？"
---

## 参考答案

### ✅ 核心要点

1. **三种权威模型**：纯服务器权威（安全但延迟高）、纯客户端权威（低延迟但易作弊）、混合权威（客户端预测+服务器验证，兼顾两者的优势）
2. **混合模型核心流程**：客户端先本地执行移动 → 发送输入到服务器 → 服务器做合法性校验（速度上限、导航可达性、碰撞）→ 校验通过则确认，不通过则强制纠正（Rubberbanding）
3. **Speed Hack 检测**：服务器记录玩家上一帧位置和当前帧位置，计算实际移动速度 `v = Δd / Δt`，与职业/技能/状态允许的速度上限比较——超过阈值即判定异常
4. **Teleport 检测**：检查连续两帧间的位移是否超出「最大可能位移 = 最大速度 × 帧间隔 + 容差」，超出则为瞬移；还需检查导航网格可达性（不能用两点直线距离判断绕墙情况）
5. **纠错策略**：轻度偏差（< 0.5m）忽略不管；中度偏差发强制位置同步（Rubberband）；严重偏差（> 阈值）标记可疑、累计触发踢出

### 📖 深度展开

#### 混合权威的完整工作流

```
客户端                                    服务器
  │                                         │
  ├── 1. 玩家输入(WASD)                      │
  ├── 2. 本地预测移动 (立即执行)              │
  ├── 3. 发送 InputMsg{seq, keys, dt}  ────→ │
  │                                         ├── 4. 校验输入合法性
  │                                         │    a. 速度检查: dist/Δt ≤ maxSpeed?
  │                                         │    b. 导航检查: 上一位置→当前位置是否可达?
  │                                         │    c. 状态检查: 是否处于禁锢/眩晕等限制态?
  │                                         │
  │                                         ├── 5a. 通过 → 更新权威位置 → 广播
  │                                         └── 5b. 不通过 → 强制纠正
  │                                         │
  │ ←──── 6. ReconcileResult{seq, pos} ──── │
  │                                         │
  ├── 7. 比较预测位置 vs 权威位置              │
  │    偏差小 → 忽略（正常网络误差）            │
  │    偏差大 → 回滚到权威位置, 重放后续输入    │
  │                                         │
```

#### Speed Hack 检测算法详解

```csharp
// 服务器端：每帧验证移动合法性
public class MovementValidator
{
    // 容差系数：考虑网络抖动和浮点误差
    private const float ToleranceFactor = 1.15f;  // 15% 容差
    // 持续异常计数器
    private Dictionary<int, ViolationTracker> trackers = new();

    public ValidationResult Validate(int playerId, Vector3 oldPos, Vector3 newPos,
                                     float deltaTime, PlayerState state)
    {
        float maxSpeed = GetMaxSpeed(state);  // 职业基础速度 + Buff加成
        float allowedDistance = maxSpeed * deltaTime * ToleranceFactor;
        float actualDistance = Vector3.Distance(oldPos, newPos);

        // === 检查 1: 速度上限 ===
        if (actualDistance > allowedDistance)
        {
            // 可能是 Speed Hack，也可能是网络 burst
            var tracker = GetTracker(playerId);
            tracker.SpeedViolations++;

            if (tracker.SpeedViolations > 5) // 连续5次才判定
            {
                return ValidationResult.SpeedHack;
            }
            return ValidationResult.Warn;  // 标记但暂不处理
        }
        else
        {
            // 正常移动，重置计数器
            GetTracker(playerId).SpeedViolations = 0;
        }

        // === 检查 2: 导航网格可达性 ===
        if (!NavMesh.IsReachable(oldPos, newPos, maxJumpHeight: 2f))
        {
            return ValidationResult.Teleport;  // 穿墙/瞬移
        }

        // === 检查 3: Z 轴异常（飞行检测）===
        float expectedGroundY = Terrain.GetHeight(newPos.x, newPos.z);
        if (newPos.y > expectedGroundY + 3f && !state.HasBuff(BuffType.Fly))
        {
            return ValidationResult.FlyHack;
        }

        return ValidationResult.Ok;
    }
}

public enum ValidationResult
{
    Ok, Warn, SpeedHack, Teleport, FlyHack
}
```

#### 容差设计的权衡

容差窗口是混合模型的灵魂——太大则外挂可钻空子，太小则正常玩家被误判：

| 容差维度 | 推荐值 | 原因 |
|---------|--------|------|
| 速度容差 | 15-20% | RTT 抖动导致 Δt 不精确，需要余量 |
| 位移绝对容差 | 0.5-1.0m | 碰撞体边缘的浮点误差 |
| 时间窗口 | 1秒滑动窗口 | 单帧抖动不应触发，持续异常才判罚 |
| 连续违规阈值 | 5-10次/分钟 | 避免网络 burst 导致的误封 |

```
         安全区          警告区         判定区
     ←───────────→ ←─────────────→ ←─────────→
     0%        115%           150%          +∞
     正常       网络抖动        疑似外挂
```

#### 纠错与惩罚策略

```csharp
// 分级响应策略
public class ViolationHandler
{
    public void HandleViolation(int playerId, ValidationResult result, Vector3 authPos)
    {
        switch (result)
        {
            case ValidationResult.Warn:
                // 静默记录，不发通知
                logger.Log($"Player {playerId} minor violation");
                break;

            case ValidationResult.SpeedHack:
                // 强制回弹到上一个合法位置
                server.Send(playerId, new ForcePositionMsg
                {
                    position = lastValidPos[playerId],
                    message = "位置已同步"
                });
                score[playerId] += 1;
                break;

            case ValidationResult.Teleport:
            case ValidationResult.FlyHack:
                // 严重违规，立即纠正 + 扣分
                server.Send(playerId, new ForcePositionMsg
                {
                    position = lastValidPos[playerId],
                    message = "检测到异常移动"
                });
                score[playerId] += 5;

                if (score[playerId] > 20)
                {
                    // 累计严重违规，踢出
                    server.Kick(playerId, "检测到作弊行为");
                    antiCheat.Report(playerId, result.ToString());
                }
                break;
        }
    }
}
```

#### 各品类游戏的权威模型选型

| 游戏类型 | 推荐模型 | 验证严格度 | 原因 |
|---------|---------|-----------|------|
| 竞技 FPS | 混合（强验证） | 极严格（< 5% 容差） | 公平性 > 体验 |
| MOBA | 混合（中验证） | 中等（15% 容差） | 平衡 |
| MMO RPG | 混合（弱验证） | 宽松（25% 容差） | 体验 > 严格公平 |
| 休闲社交 | 纯客户端 | 不验证 | 无对抗需求 |
| 竞速游戏 | 混合（帧检查） | 极严格 | 线路固定，可精确验证 |

### ⚡ 实战经验

- **不要用直线距离判断穿墙**：玩家可能绕了个弯到了墙后面，直线距离检测会误判；必须配合导航网格做可达性检查，或者记录路径采样点
- **客户端预测要记录输入历史**：当服务器纠正时，客户端需要回滚到纠正点并重放之后的输入序列（类似 CSP 的 Reconciliation），否则玩家会感到「被拉回去」
- **分级响应比直接封号更好**：先用 ForcePosition 无声纠正，累积严重违规再踢出；很多「异常」其实是网络 burst 或客户端 Bug，直接封号会导致大量误封投诉
- **服务器的物理参数必须和客户端一致**：最大速度、跳跃高度、重力加速度等参数如果两端不一致，验证永远不通过；建议用一个共享的配置文件驱动两端的物理常量

### 🔗 相关问题

- 纯服务器权威的缺点是什么？为什么竞技游戏不直接用？
- 如何在帧同步游戏中做反作弊验证？
- Rubberbanding（强制拉回）对玩家体验的影响如何缓解？
