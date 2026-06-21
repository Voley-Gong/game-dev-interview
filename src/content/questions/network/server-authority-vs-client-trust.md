---
title: "服务器权威 vs 客户端可信：游戏网络架构如何选择信任边界？"
category: "network"
level: 3
tags: ["服务器权威", "客户端预测", "反作弊", "网络架构", "信任模型"]
related: ["network/client-side-prediction", "network/lag-compensation", "network/frame-vs-state-sync"]
hint: "为什么 DOTA2 的移动完全由服务器说了算，而 Minecraft 的红石电路却可以纯客户端计算？"
---

## 参考答案

### ✅ 核心要点

1. **服务器权威（Server-Authoritative）**：服务器是唯一真相源，客户端只发操作请求、接收结果——最安全但延迟敏感
2. **客户端可信（Client-Trust / Client-Authoritative）**：客户端自己模拟状态并广播——零延迟但极易作弊
3. **混合信任模型**：大部分游戏在"关键状态"用服务器权威、"表现层"用客户端自治，按影响范围划分边界
4. **Lockstep 是特殊的对等信任**：所有客户端运行确定性模拟，互相验证输入——作弊难度高但仍存在"暗箱"风险
5. **信任边界设计**：影响战斗平衡的（位置、伤害、技能CD）→ 服务器权威；纯视觉表现的（特效、动画、UI）→ 客户端自治

### 📖 深度展开

#### 信任光谱

```
完全服务器权威 ←————————————————————→ 完全客户端可信

  [FPS射击]    [MOBA]    [MMO]    [ARPG]    [休闲游戏]
  CS/Valorant  DOTA2     WoW      Diablo    Among Us
  ↑            ↑         ↑        ↑         ↑
  严格权威      严格权威   混合     混合       客户端主导
```

#### 架构对比

| 维度 | 服务器权威 | 客户端可信 |
|------|-----------|-----------|
| 延迟体感 | 高（需等服务器确认） | 零（本地立即响应） |
| 防作弊 | ✅ 强（数据不可篡改） | ❌ 弱（内存修改即生效） |
| 带宽消耗 | 高（状态全量同步） | 低（仅同步操作输入） |
| 服务器成本 | 高（需模拟游戏逻辑） | 低（仅转发/验证） |
| 断线影响 | 断线即停 | 可离线继续 |
| 典型场景 | 竞技 FPS、MOBA | 单机合作、休闲派对 |

#### 服务器权威的典型流程

```csharp
// === 客户端：发送移动请求 ===
public class ClientMovement : MonoBehaviour {
    void Update() {
        float h = Input.GetAxis("Horizontal");
        float v = Input.GetAxis("Vertical");
        if (h != 0 || v != 0) {
            // 不直接移动！发送请求给服务器
            SendMoveRequest(h, v, transform.position);
        }
    }
}

// === 服务器：权威模拟 + 验证 ===
public class ServerMovementAuthority {
    Dictionary<int, PlayerState> players;

    public void HandleMoveRequest(int playerId, float h, float v, Vector3 claimedPos) {
        var state = players[playerId];

        // 1. 防作弊验证：客户端声称的位置是否合理？
        float maxSpeed = state.moveSpeed * 1.1f; // 允许10%误差
        float expectedDist = maxSpeed * Time.fixedDeltaTime;
        float actualDist = Vector3.Distance(state.position, claimedPos);

        if (actualDist > expectedDist) {
            // 疑似加速挂：拒绝并纠正
            SendCorrection(playerId, state.position);
            return;
        }

        // 2. 服务器执行移动模拟
        state.velocity = new Vector3(h, 0, v).normalized * state.moveSpeed;
        state.position += state.velocity * Time.fixedDeltaTime;

        // 3. 广播给所有玩家
        BroadcastState(playerId, state.position, state.velocity);
    }
}
```

#### 混合信任模型（最常用）

实际游戏很少走极端，而是按"影响范围"划分：

```
┌─────────────────────────────────────────────┐
│              信任边界划分                     │
├──────────────┬──────────────────────────────┤
│  服务器权威   │  客户端自治                    │
├──────────────┼──────────────────────────────┤
│  角色位置     │  摄像机控制                    │
│  伤害计算     │  动画状态机                    │
│  技能CD       │  粒子特效触发                  │
│  物品掉落     │  UI 交互反馈                   │
│  匹配结果     │  本地音效播放                  │
│  经济交易     │  预览/预测表现层               │
└──────────────┴──────────────────────────────┘
```

#### CS:GO / Valorant 的分层信任案例

```
玩家扣扳机
  ↓
客户端：立即播放开火动画 + 枪口火焰 + 音效（表现层，客户端自治）
  ↓
客户端：发送 FireInput{timestamp, aimDir} 给服务器（操作层，请求权威）
  ↓
服务器：验证瞄准方向 + 射速CD + 弹药量 → 计算命中（战斗层，严格权威）
  ↓
服务器：返回 HitResult{target, damage, headshot}（结果层，权威推送）
  ↓
客户端：收到结果后显示击杀标记 + 飘血（表现层，客户端渲染）
```

**注意**：客户端"立即播放动画"但不"立即造成伤害"——这就是信任边界的精髓。

#### 性能优化：服务器负载削减

服务器权威的代价是服务器要模拟整个游戏世界。削减策略：

- **兴趣区域裁剪（AOI）**：只模拟玩家附近的实体
- **低频模拟（LOD Simulation）**：远离玩家的NPC降为2Hz更新
- **物理简化**：服务器用 AABB 替代精确物理碰撞
- **状态缓存**：不变化的实体不重新广播

### ⚡ 实战经验

1. **永远不要信任客户端发送的"结果数据"**——客户端说"我打中了敌人扣了100血"，服务器必须自己重新模拟验证。只信任"输入数据"（按键、瞄准方向），不信任"输出数据"（伤害、位置）
2. **移动验证要用"速度上限"而非"位置比对"**——直接比对位置容易被网络波动误判，改用 `maxSpeed × deltaTime` 作为位移上限更鲁棒。预留 10%~15% 误差容忍避免误杀正常玩家
3. **客户端预测 + 服务器调和不是万能药**——复杂物理交互（碰撞、推开、击退）的预测极难做对。如果预算有限，优先对"移动"做预测，其他操作老实等服务器确认
4. **反作弊的成本是指数级递增的**——从"服务器验证"到"行为分析"到"内核级反作弊（Vanguard/EAC）"，每一步都是数十万到数百万的成本。在项目早期，合理的信任边界设计比堆反作弊软件更有效

### 🔗 相关问题

- 如何在不牺牲手感的前提下，实现服务器权威的移动系统？（提示：Client-Side Prediction）
- 帧同步（Lockstep）中所有客户端都是"权威"，如何防止作弊？
- 区块链游戏中的"链上权威"和传统服务器权威有何异同？
