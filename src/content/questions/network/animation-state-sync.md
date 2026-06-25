---
title: "游戏中动画状态机的网络同步怎么做？"
category: "network"
level: 3
tags: ["动画同步", "状态机", "插值", "表现层", "网络同步"]
related: ["network/entity-interpolation", "network/movement-smoothing-compensation", "network/snapshot-delta-sync"]
hint: "服务器说角色在"攻击第3帧"，客户端的角色还在" idle"，怎么让所有客户端看到流畅且一致的动画？"
---

## 参考答案

### ✅ 核心要点

1. **动画状态是派生数据**：不要同步动画 State Machine 本身，同步触发事件 + 时间戳，客户端自己跑状态机
2. **事件驱动 + 时间对齐**：服务器下发 Animation Event（含 serverTime），客户端按延迟补偿播放
3. **混合（Blend）插值**：状态切换瞬间不可避免抖动，用 Blend Tree 做平滑过渡
4. **动画优先级**：死亡 > 攻击命中 > 移动 > 待机，高优先级事件打断低优先级
5. **分层同步**：Base Layer（全身状态）和 Upper Body Layer（上半身动作）独立同步

### 📖 深度展开

#### 同步策略对比

| 策略 | 描述 | 优缺点 |
|------|------|--------|
| 全状态同步 | 每帧发 current state + normalized time | 带宽高、表现呆板、不推荐 |
| 事件同步 ✅ | 只发状态切换事件 | 带宽低、客户端自主表现、主流方案 |
| 参数同步 | 发 Animator 参数值 | 需要客户端有完整状态机逻辑 |

#### 事件同步协议设计

```
Animation Event（S→C）
{
    "msgId": "ANIM_EVENT",
    "entityId": 1024,
    "serverTime": 45213.550,       // 服务器时间戳（毫秒精度）
    "events": [
        {
            "type": "STATE_CHANGE",
            "layer": 0,             // Base Layer
            "state": "Attack_Sword_01",
            "playMode": "OVERRIDE", // OVERRIDE / ADDITIVE
            "speed": 1.0,
            "timeOffset": 0.0      // 从动画第几秒开始播
        },
        {
            "type": "STATE_CHANGE", 
            "layer": 1,             // Upper Body Layer
            "state": "Facial_Angry",
            "playMode": "ADDITIVE",
            "speed": 1.0,
            "timeOffset": 0.0
        }
    ]
}
```

#### 延迟补偿播放

客户端收到事件时已经过去了 RTT/2 的时间，需要"追帧"：

```csharp
public class NetworkAnimationPlayer : MonoBehaviour
{
    public Animator animator;
    
    public void OnAnimEvent(AnimEvent evt)
    {
        float currentTime = NetworkTime.ServerTime;
        float latency = currentTime - evt.serverTime; // 事件从服务器到客户端的延迟
        
        // 1. 跳转到对应状态
        animator.Play(evt.state, evt.layer, evt.timeOffset);
        
        // 2. 如果延迟过大，加速播放追帧（限制最多追 0.3s）
        float catchUpTime = Mathf.Min(latency, 0.3f);
        if (catchUpTime > 0.02f)
        {
            // 调整 Animator speed 追帧
            StartCoroutine(CatchUpPlay(evt.layer, catchUpTime));
        }
        
        // 3. 设置播放速度
        animator.speed = evt.speed;
    }
    
    IEnumerator CatchUpPlay(int layer, float catchUpSeconds)
    {
        float targetSpeed = 2.0f; // 2倍速追帧
        animator.SetLayerWeight(layer, 1f);
        
        float elapsed = 0f;
        while (elapsed < catchUpSeconds)
        {
            float dt = Time.deltaTime;
            elapsed += dt * targetSpeed;
            yield return null;
        }
        
        // 恢复正常速度
        animator.speed = 1.0f;
    }
}
```

#### 客户端预测与服务器纠正

```
场景：玩家按下攻击键

客户端                        服务器
  │                             │
  ├─ 1. 立即播放 Attack 动画     │
  │    （预测，不等服务器）       │
  │                             │
  ├─ 2. 发送 ATTACK_INPUT ──────→ │
  │                             │
  │                             ├─ 3. 验证（CD好了？蓝量够？）
  │                             │
  │                             ├─ 4. 执行逻辑（伤害计算等）
  │                             │
  │  ←──── ANIM_EVENT(confirmed) ┤
  │                             │
  ├─ 5. 收到确认                 │
  │    如果与预测一致 → 继续     │
  │    如果不一致 → 立即纠正     │
  │    （切回正确状态 + 追帧）   │
  │                             │
```

#### 动画混合树（Blend Tree）同步

移动动画通常用 Blend Tree（按速度/方向插值），不需要同步离散状态：

```
Blend Tree: Locomotion
    ├── Idle (speed=0)
    ├── Walk (speed=1.5)
    ├── Run  (speed=5.0)
    └── 方向插值（-180° ~ +180°）

同步什么：
  ✅ speed (float) + moveDir (float) — 由移动同步自然带上
  ❌ 不需要单独发动画状态，客户端 Animator 自动根据参数混合
```

#### 分层同步策略

| Layer | 内容 | 同步频率 | 同步方式 |
|-------|------|---------|---------|
| Base Layer | 移动、待机、跳跃 | 高频（每帧参数） | 参数同步（velocity → Blend Tree） |
| Upper Body | 攻击、施法、互动 | 事件驱动 | State Change Event |
| Face Layer | 表情 | 低频 | 事件同步 |
| Additive | 受击、硬直 | 事件 + 优先级 | 高优先级打断 |

### ⚡ 实战经验

1. **永远不要同步 Animator 的全部参数**：有些参数（如 blendWeight）是客户端本地计算用的，同步过去会产生反馈循环。只同步"输入参数"（speed、isGrounded），派生参数让客户端自己算
2. **受击硬直用高优先级通道**：玩家被击中时必须立即打断当前动画播放受击动作。给 HIT_REACT 事件设 priority=CRITICAL，收到后无视动画过渡时间直接切换
3. **动画事件中的伤害判定要服务器权威**：动画里的 Animation Event（如"第 0.3 秒伤害判定"）只是表现层参考，真正的伤害判定在服务器逻辑帧完成。否则玩家改本地动画速度就能改变伤害频率
4. **多角色同屏时做动画 LOD**：远处的角色降级为简单动画（只播 Idle/Walk），不发 Upper Body 层事件。用 Network Priority 系统按距离/重要性分级

### 🔗 相关问题

- 移动同步和动画同步如何统一到同一个插值管线中？
- 帧同步游戏（如格斗游戏）的动画同步与状态同步游戏有什么不同？
- 如何处理动画 Root Motion 在网络环境下的位移不一致？
