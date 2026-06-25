---
title: "网络延迟隐藏设计：如何在高延迟下保持游戏「手感」（综合补偿策略）"
category: "network"
level: 3
tags: ["延迟隐藏", "游戏手感", "插值", "外推", "输入预测", "动画补偿", "面试高频"]
related: ["network/entity-interpolation", "network/client-side-prediction", "network/movement-smoothing-compensation", "network/perceived-latency-optimization"]
hint: "为什么在 150ms 延迟下玩家仍觉得游戏「流畅」？延迟隐藏不是单一技术，而是一套组合拳。"
---

## 参考答案

### ✅ 核心要点

1. **延迟隐藏是系统工程**：不是单一技术，而是客户端预测、服务器调和、实体插值、输入缓冲、动画补偿的综合编排——任何一个环节缺失都会暴露延迟
2. **感知延迟 ≠ 网络延迟**：玩家感知到的是「按下按键到看到反馈」的端到端时间，通过本地预测可将感知延迟降到 < 16ms（一帧），即使实际 RTT 是 150ms
3. **四层补偿体系**：L0 输入层（预测执行）→ L1 视觉层（动画即时响应）→ L2 远程实体层（插值/外推缓冲）→ L3 音频层（即时音效预播）
4. **关键洞察：隐藏 > 消除**：真正消除延迟是不可能的（物理限制），目标是不让玩家「感受到」延迟——通过视觉欺骗和交互补偿来实现
5. **各品类的延迟预算**：FPS < 50ms 感知、MOBA < 80ms、MMO < 150ms、回合制无要求；超过预算需要用更激进的补偿手段

### 📖 深度展开

#### 四层补偿体系全景图

```
玩家按下「攻击」按钮（T=0ms）
│
├── L0: 输入层补偿（CSP + Server Reconciliation）
│   ├── 客户端立即执行攻击逻辑（T=0~16ms）✓ 玩家「看到」了
│   ├── 输入发送到服务器（网络传输 RTT/2）
│   └── 服务器确认/纠正后回滚重放（对玩家透明）
│
├── L1: 视觉层补偿（动画即时响应）
│   ├── 立即播放攻击动画第 1 帧（不等待服务器）
│   ├── 角色控制器立即位移（预测移动）
│   └── 特效/粒子立即触发（VFX 不走网络）
│
├── L2: 远程实体层（Entity Interpolation Buffer）
│   ├── 其他玩家的位置渲染延迟一个缓冲（~100ms）
│   ├── 在已知快照之间做 Hermite 样条插值
│   └── 超过缓冲窗口则外推（Dead Reckoning）
│
├── L3: 音频层补偿
│   ├── 攻击音效即时播放（不等服务器确认）
│   ├── 被击中的音效等到服务器确认后播
│   └── 环境音持续播放不受影响
│
└── 服务器在 T=75ms 收到，T=150ms 确认返回
    （玩家此时已经在看攻击动画第 9 帧了）
```

#### L0 输入层：客户端预测的精细实现

```csharp
public class PredictedActionSystem
{
    private CircularBuffer<PredictedAction> pendingActions = new(capacity: 64);
    private int currentSequence = 0;

    public void OnPlayerAttack()
    {
        var action = new PredictedAction
        {
            sequence = currentSequence++,
            type = ActionType.Attack,
            timestamp = Time.now,
            localState = character.Snapshot()  // 保存预测前的状态
        };

        // 1. 立即在客户端执行（零延迟反馈）
        character.ExecuteAttack();
        vfxPlayer.Play("slash_effect");

        // 2. 记录待确认
        pendingActions.Push(action);

        // 3. 发送到服务器
        network.Send(new InputMessage
        {
            seq = action.sequence,
            type = action.type,
            timestamp = action.timestamp
        });
    }

    public void OnServerReconcile(ReconcileMessage msg)
    {
        // 服务器纠正了某个 action
        var confirmed = pendingActions.PopUntil(msg.lastConfirmedSeq);

        if (msg.needsCorrection)
        {
            // 回滚到服务器确认的状态
            character.Restore(msg.authoritativeState);

            // 重放所有未确认的动作
            foreach (var action in pendingActions)
            {
                character.ExecuteAction(action);
            }
        }
    }
}
```

#### L1 视觉层：动画即时响应 + 伤害数字延迟

关键原则：**自己发起的动作立即响应，来自外部的反馈等确认**。

| 事件来源 | 即时播放 | 延迟确认 | 原因 |
|---------|---------|---------|------|
| 自己的攻击动画 | ✅ | | 本地预测，可回滚 |
| 自己受到伤害的动画 | | ✅ | 等服务器确认避免误判 |
| 自己的攻击特效 | ✅ | | 提升手感，偏差不影响玩法 |
| 伤害数字弹出 | | ✅ | 等 DamageMsg 确认 |
| 受击音效 | | ✅ | 等 HurtMsg 确认 |
| 自己移动的脚步声 | ✅ | | 由本地速度驱动 |
| 技能 CD 旋转 | ✅ | | 即时反馈按下 |

#### L2 远程实体层：插值缓冲的窗口选择

```
              服务器发送频率 = 20Hz（50ms/帧）
              客户端渲染频率 = 60Hz（16.6ms/帧）

时间轴 ──────────────────────────────────────────→

服务器快照:  S0          S1          S2          S3
             │           │           │           │
             └─── 50ms ──┘           │           │
                                      │           │
客户端渲染:        P0    P1    P2    P3    P4    P5
                   ↑     ↑     ↑     ↑     ↑     ↑
                   插值在 S0-S1 之间         插值在 S1-S2 之间

缓冲延迟 = 一个快照间隔 (50ms) + 安全余量 (50ms) = 100ms
```

```csharp
public class RemoteEntityInterpolation
{
    private const float InterpolationDelay = 0.1f;  // 100ms 缓冲
    private const float MaxExtrapolationTime = 0.2f; // 200ms 外推上限

    private SnapshotBuffer buffer = new(); // 环形缓冲

    public Vector3 GetRenderPosition(int entityId, float currentTime)
    {
        float targetTime = currentTime - InterpolationDelay;

        var (from, to, t) = buffer.GetSurroundingSnapshots(entityId, targetTime);

        if (from != null && to != null)
        {
            // 有两个快照：Hermite 样条插值（位置+速度）
            return HermiteInterpolate(
                from.Position, from.Velocity,
                to.Position, to.Velocity,
                t  // 归一化插值因子 [0,1]
            );
        }

        if (from != null)
        {
            // 只有一个快照：外推（Dead Reckoning）
            float extrapolateTime = targetTime - from.Timestamp;
            if (extrapolateTime <= MaxExtrapolationTime)
            {
                return from.Position + from.Velocity * extrapolateTime;
            }
            else
            {
                // 外推太久，保持最后位置（避免「鬼影」跑飞）
                return from.Position;
            }
        }

        return Vector3.zero; // 实体尚未收到
    }

    private Vector3 HermiteInterpolate(
        Vector3 p0, Vector3 v0, Vector3 p1, Vector3 v1, float t)
    {
        float t2 = t * t;
        float t3 = t2 * t;

        // 三次 Hermite 基函数
        float h00 = 2 * t3 - 3 * t2 + 1;
        float h10 = t3 - 2 * t2 + t;
        float h01 = -2 * t3 + 3 * t2;
        float h11 = t3 - t2;

        return h00 * p0 + h10 * v0 + h01 * p1 + h11 * v1;
    }
}
```

#### 插值 vs 外推的决策矩阵

```
                    有最新快照？
                   /           \
                 是             否
                 /               \
         快照间隔正常?        超出外推时限?
           /      \             /       \
          是       否          是        否
          │        │           │         │
       插值渲染   外推渲染    冻结位置   外推渲染
       (平滑)   (可能偏差)   (防止鬼影)  (短暂容忍)
```

#### 不同延迟下的补偿策略组合

| 网络延迟 | 插值缓冲 | CSP | 外推 | 动画补偿 | 策略说明 |
|---------|---------|-----|------|---------|---------|
| < 50ms | 50ms | 开启 | 不需要 | 可选 | 完美区间，标准插值即可 |
| 50-100ms | 100ms | 开启 | 轻度 | 推荐 | 竞技游戏上限，需 CSP |
| 100-200ms | 150ms | 开启 | 中度 | 必须 | 开始影响体验，需全套补偿 |
| > 200ms | 200ms | 开启 | 激进 | 必须 | 补偿极限，考虑区域服务器 |

#### L3 音频层：常被忽略的延迟感知

```csharp
// 音频的分层补偿
public class NetworkedAudio
{
    public void PlayAttackSound(ActionContext ctx)
    {
        if (ctx.IsLocalPlayer)
        {
            // 本地玩家：立即播放（不等网络）
            audioSource.PlayOneShot(attackClip);
        }
        else
        {
            // 远程玩家：等到插值时间点再播
            float delay = interpolationBufferDelay;
            audioSource.PlayScheduled(AudioSettings.dspTime + delay);
        }
    }

    public void PlayHitSound(DamageMsg msg)
    {
        // 伤害音效：等服务器确认
        // 但如果 150ms 内没收到确认，用预测播放（避免完全无声）
        StartCoroutine(DelayedHitSound(msg));
    }

    private IEnumerator DelayedHitSound(DamageMsg msg)
    {
        float waited = 0;
        while (waited < 0.15f && !msg.Confirmed)
        {
            waited += Time.deltaTime;
            yield return null;
        }
        audioSource.PlayOneShot(hitClip);
    }
}
```

### ⚡ 实战经验

- **插值缓冲的 100ms 不是铁律**：竞技 FPS 可以压到 50ms 甚至更低（配合更快的快照频率），MMO 可以到 200ms。缓冲越长越平滑但越「滞后」——竞技玩家更想要即时性
- **外推必须有上限和纠正**：外推超过 200ms 后角色位置会严重偏离实际，当新快照到达时会出现「跳变」；必须做位置纠错平滑（Lerp 到新位置而非瞬移）
- **动画补偿是最容易被忽略的**：攻击动画的 hit frame（伤害判定帧）如果和视觉帧不匹配，即使网络没问题也会感觉「打不准」；本地预测时动画的 hit frame 要和服务器判定的帧对齐
- **弱网降级策略**：当 RTT > 300ms 时，主动关闭一些功能（如弹道特效、实时阴影其他玩家），只保留核心玩法的同步——比让游戏在极限状态下挣扎要好

### 🔗 相关问题

- Client-Side Prediction 的回滚重放在极端高延迟下为什么会「抖动」？
- 帧同步游戏如何做延迟补偿？（提示：帧缓冲 + 输入延迟）
- 如何度量玩家感知到的延迟（Perceived Latency）？有哪些客观指标？
