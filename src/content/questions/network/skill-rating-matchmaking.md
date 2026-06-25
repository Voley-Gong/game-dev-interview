---
title: "游戏匹配算法与技能评分系统如何设计？Elo/Glicko/MMR 的原理对比与工程实现"
category: "network"
level: 3
tags: ["匹配算法", "Elo", "Glicko", "MMR", "技能评分", "Matchmaking"]
related: ["network/matchmaking-room-server", "network/server-authority-vs-client-trust"]
hint: "为什么王者荣耀连胜后对手越来越强？背后的技能评分更新公式是怎样的？"
---

## 参考答案

### ✅ 核心要点

1. **Elo 是基础**：基于胜率期望计算分数变更，赢家加分、输家减分——简单但无法衡量不确定性
2. **Glicko 引入 RD（Rating Reliability）**：用正态分布描述"这个分数有多可靠"，久未比赛的玩家 RD 增大，匹配和计分更灵活
3. **MMR（Matchmaking Rating）是工程化封装**：在 Elo/Glicko 之上加入位置偏好、组队修正、段位边界等业务规则
4. **匹配质量 = 技能接近 + 等待时间 + 公平性约束**：纯按分数匹配会导致高段位玩家等待过久，需要用扩张搜索（Widening Search）平衡
5. **商业化项目通用方案**：Trueskill（微软）/ OpenSkill（开源 Glicko 变体）/ 自研 Elo+软重置

### 📖 深度展开

#### 三大评分系统对比

| 维度 | Elo Rating | Glicko-2 | TrueSkill |
|------|-----------|----------|-----------|
| **发明年代** | 1960（国际象棋） | 2012（Glicko 改进版） | 2007（微软） |
| **核心模型** | 确定值（标量） | 正态分布（μ, σ） | 贝叶斯推断（μ, σ） |
| **不确定性度量** | ❌ | ✅ RD (Rating Deviation) | ✅ σ (Uncertainty) |
| **支持多队/多玩家** | ❌（1v1） | ❌（1v1） | ✅（支持多队混战） |
| **计算复杂度** | 低 | 中 | 高 |
| **典型应用** | 国际象棋、早期天梯 | CS:GO Faceit、Lichess | Xbox Live、Halo、Forza |
| **不活跃处理** | 固定值 | RD 自动增大 | σ 自动增大 |

#### Elo 公式详解

```python
# Elo 核心：基于期望胜率更新分数
def elo_update(player_rating, opponent_rating, result, K=32):
    """
    result: 1=胜, 0.5=平, 0=负
    K: K因子，控制单次变化幅度（新手K=40，职业K=10）
    """
    # 期望胜率（标准 Elo，400 分差 = 10倍实力差）
    expected = 1.0 / (1.0 + 10 ** ((opponent_rating - player_rating) / 400))

    # 分数更新
    delta = K * (result - expected)
    new_rating = player_rating + delta
    return new_rating, delta

# 示例
print(elo_update(1500, 1500, 1))  # (1516, +16) 旗鼓相当赢了
print(elo_update(1200, 1800, 1))  # (1230, +30) 爆冷赢了，加分多
print(elo_update(1800, 1200, 1))  # (1802, +2)   应该赢的，加分少
print(elo_update(1800, 1200, 0))  # (1766, -34)  翻车了，扣分多
```

```
期望胜率曲线（Elo）:

1.0 ┤                    ╭──────
    │                 ╭──╯
0.8 ┤               ╭─╯
    │             ╭─╯
0.6 ┤           ╭─╯
    │         ╭─╯
0.5 ┤───────╭─╯──────────────
    │     ╭─╯
0.4 ┤   ╭─╯
    │ ╭─╯
0.2 ┤─╯
    ╰──────────────────────────
   -400   0    +400  分差(玩家-对手)
```

#### Glicko-2：引入不确定性

```python
import math

def glicko2_update(rating, rd, opp_rating, opp_rd, outcome):
    """
    rating, opp_rating: 原始分数（如1500）
    rd, opp_rd: Rating Deviation（不确定性，初始350）
    outcome: 1/0.5/0
    """
    # Step 1: 转换到 Glicko-2 scale (μ = (r-1500)/173.2788)
    mu = (rating - 1500) / 173.2788
    phi = rd / 173.2788
    opp_mu = (opp_rating - 1500) / 173.2788
    opp_phi = opp_rd / 173.2788

    # Step 2: 计算 g(phi) 和 E(mu, mu_j, phi_j)
    def g(phi):
        return 1.0 / math.sqrt(1.0 + 3.0 * phi**2 / math.pi**2)

    g_phi = g(opp_phi)
    E = 1.0 / (1.0 + math.exp(-g_phi * (mu - opp_mu)))

    # Step 3: 计算方差 v 和改进量 Δ
    v = 1.0 / (g_phi**2 * E * (1 - E))
    delta = v * g_phi * (outcome - E)

    # Step 4: 更新 μ 和 φ
    phi_star = math.sqrt(phi**2 + v)  # 新的不确定性
    new_phi = 1.0 / math.sqrt(1.0 / phi_star**2 + 1.0 / v)
    new_mu = mu + new_phi**2 * g_phi * (outcome - E)

    # Step 5: 转回原始 scale
    new_rating = 173.2788 * new_mu + 1500
    new_rd = 173.2788 * new_phi
    return new_rating, new_rd

# 久未比赛的玩家 RD 会自动增大（volatility 参数控制增长速度）
# RD 大的玩家赢了 → 加分更多（因为"真实实力不确定"）
# RD 小的玩家 → 分数变化平稳
```

#### 匹配引擎：扩张搜索算法

```
玩家点击「匹配」
     │
     ▼
┌──────────────────────────┐
│ T=0s: 搜索 ±50 分范围内   │ ← 理想匹配
│          的对手            │
└────────────┬──────────────┘
             │ 无匹配
             ▼
┌──────────────────────────┐
│ T=10s: 扩张到 ±100 分     │ ← 妥协
│   可接受匹配               │
└────────────┬──────────────┘
             │ 无匹配
             ▼
┌──────────────────────────┐
│ T=30s: 扩张到 ±200 分     │ ← 最后手段
│   降低公平性要求            │
└────────────┬──────────────┘
             │
             ▼
┌──────────────────────────┐
│ T=60s: 填入 AI 或放宽到   │ ← 防止无限等待
│       最大范围             │
└──────────────────────────┘

匹配评分函数（选择最优对手）：
  Score = w1 * |rating_diff|    // 分差越小越好
         + w2 * wait_time       // 等待越久越优先
         + w3 * ping            // 延迟越低越好
         + w4 * |streak|        // 避免连败撞连胜
```

#### 组队匹配的修正

```python
# 5 人车队 vs 5 人散人 → 车队有明显优势（沟通+配合）
# 需要对组队 MMR 做"膨胀修正"

def team_mmr(players, party_size):
    """
    players: 队伍中所有玩家的 MMR 列表
    party_size: 最大组队人数（1=全部散人, 5=五排）
    """
    avg = sum(players) / len(players)
    # 经验公式：组队每多一人，队伍有效MMR 上浮
    party_bonus = {
        1: 0,      # 全散人
        2: 30,     # 双排
        3: 60,     # 三排
        4: 90,     # 四排
        5: 150     # 五排
    }
    return avg + party_bonus.get(party_size, 0)

# 匹配时：车队 MMR 整体上浮后寻找对手
# 这样五排车队会匹配到平均分数更高的散人队
```

#### 段位系统与软重置

```
赛季初的段位重置策略：

【硬重置】所有人回到固定起点（如 1200）
  → 问题：高端局玩家碾压低段位，体验极差

【软重置】向均值靠拢
  new_rating = old_rating * 0.6 + baseline * 0.4
  baseline = 1500（设计中位）

  王者（2500）→ 2100（还是偏高，但更接近大众）
  青铜（800） → 1180（略有回升）
  黄金（1500）→ 1500（不变）

【衰减重置】高端衰减
  rating > 2000 → 每周 -20 分（促使活跃）
  rating < 1500 → 不衰减（保护低段位）
```

### ⚡ 实战经验

1. **不要把 MMR 和段位完全绑定**：段位是给玩家看的"脸面"（有保护机制、晋级赛），MMR 是匹配用的"真实实力"（纯数值）。两者解耦能避免"段位焦虑"——输一把掉段但 MMR 微调，玩家体感更温和
2. **新玩家初始分要设准**：初始分太高会碾压老玩家，太低会导致新手一直输而流失。建议初始 σ（不确定性）设大，让系统快速定位真实水平（Glicko 的核心优势）
3. **连胜/连败要有干预**：连胜 5 场后增加对手难度（加速收敛到真实水平），连败 5 场后考虑人机局。这是"系统对你好"的体验设计，纯算法不会做这件事
4. **监控匹配漏斗指标**：平均等待时间、分差中位数、先手胜率、秒退率。如果先手胜率 >55%，说明匹配不公平（地图/角色平衡或匹配算法问题）

### 🔗 相关问题

- 如何防止玩家"故意掉分"（Smurfing）后碾压新手？
- 大逃杀模式（100人）的匹配算法与 1v1 有什么不同？
- 匹配服务如何做水平扩展（分布式匹配引擎设计）？
