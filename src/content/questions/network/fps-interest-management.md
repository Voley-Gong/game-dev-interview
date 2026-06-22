---
title: "FPS/TPS 游戏中的兴趣区域管理（Interest Management）如何针对射击场景做精细化优化？"
category: "network"
level: 4
tags: ["兴趣区域", "AOI", "FPS", "网络优化", "视野剔除", "空间分区"]
related: ["network/aoi-algorithm", "network/server-authority-vs-client-trust", "network/snapshot-delta-sync"]
hint: "MMO 用九宫格 AOI 就够了，但 FPS 玩家还关心视野遮挡、脚步声、子弹轨迹——怎么管？"
---

## 参考答案

### ✅ 核心要点

1. **IM 的本质**：服务器只为每个客户端发送它"感兴趣"的实体状态，FPS 场景下"感兴趣"的定义远比 MMO 复杂
2. **多层过滤**：距离 → 视锥 → 遮挡 → 游戏逻辑（枪声/脚步声/队友标记），逐层收窄需要同步的实体集
3. **频道化同步（Channel-based）**：位置/朝向走高频低延迟通道，特效/音效走事件驱动通道，互不干扰
4. **反作弊约束**：不能把敌人位置发给你看不见的客户端——否则外挂可以提取出墙后敌人的位置
5. **动态频率调整**：视野内敌人 30Hz 同步，视野外但近距离的 10Hz，远距离的 2Hz 或不同步

### 📖 深度展开

#### FPS Interest Management 过滤管线

```
所有服务器实体 (100 players + NPCs + projectiles)
    │
    ▼  Layer 1: 距离过滤 (Radius Cull)
~30 entities (半径 100m 内)
    │
    ▼  Layer 2: 视锥过滤 (Frustum Cull)
~12 entities (玩家视野方向 ±90°)
    │
    ▼  Layer 3: 遮挡过滤 (Occlusion/LOS)
~7 entities  (射线检测无遮挡)
    │
    ▼  Layer 4: 游戏逻辑层
~10 entities (加上：脚步声范围内、子弹轨迹、队友标记、技能特效)
    │
    ▼
每个客户端的最终同步列表
```

#### 各层实现细节

**Layer 1 — 距离过滤（空间索引加速）**

```cpp
// 使用 Uniform Grid 或 KD-Tree 做快速邻域查询
// FPS 地图通常不大（如 CS 512x512），Uniform Grid 足够

std::vector<EntityID> queryNearby(const Vec3& pos, float radius) {
    // O(1) 查询所在格子，然后检查 9 邻域格子
    auto& cell = grid.getCell(pos);
    std::vector<EntityID> result;
    for (auto& neighborCell : cell.neighbors3x3()) {
        for (auto entity : neighborCell.entities) {
            if (distance(pos, entity.pos) <= radius) {
                result.push_back(entity.id);
            }
        }
    }
    return result;
}
// 复杂度: O(k)，k = 邻域实体数，远优于遍历全部
```

**Layer 2 — 视锥过滤**

```cpp
bool isInViewFrustum(const Vec3& entityPos, const Player& viewer) {
    Vec3 toEntity = entityPos - viewer.eyePos;
    float dist = toEntity.length();
    if (dist > maxViewDistance) return false;

    // 视锥半角 ±视角范围/2（如 ±55° 对应 110° FOV）
    Vec3 forward = viewer.getForwardVector();
    float cosAngle = dot(normalize(toEntity), forward);
    if (cosAngle < cos(DEG2RAD(55))) return false;

    return true;
}
```

**Layer 3 — 遮挡过滤（最昂贵但也最关键）**

```
方法 1: 精确射线检测（每帧对每个候选实体）
  → 散射线检测(eye → entity_center)
  → 命中？可见！被挡？不可见
  → 代价: N 条射线 × map 几何复杂度

方法 2: PVS（Potentially Visible Set）预计算
  → 离线把地图划分为 Region，预计算 "从 Region A 能看到 Region B 吗"
  → 运行时只需查表 O(1)
  → 适合静态地图（如 CS:GO 的竞技地图）

方法 3: Hierarchical Z-Buffer (Hi-Z)
  → 复用上一帧的深度缓冲做遮挡查询
  → GPU 驱动，适合大场景
  → FPS 地图通常不需要这么重的方案
```

**Layer 4 — 游戏逻辑补充**

```
即使遮挡也要同步的情况:
  ✅ 脚步声范围（如 15m 内，不管墙不墙）
  ✅ 枪口火焰/枪声（更大范围，如 50m）
  ✅ 投掷物（手雷轨迹所有附近玩家都应看到）
  ✅ 队友位置（队伍共享，Tab 键雷达）
  ✅ 标记系统（"敌人在这"→ 全队同步）

即使可见也降低频率的情况:
  🔻 远距离敌人（>200m）从 30Hz 降到 10Hz
  🔻 背后敌人（虽然不在视锥但距离近）保持 15Hz 以便转身即看
```

#### 动态频率调整表

| 实体状态 | 距离 < 30m | 30-100m | 100-200m | > 200m |
|----------|-----------|---------|----------|--------|
| 视野内敌人 | 30Hz | 20Hz | 10Hz | 不同步 |
| 视野外敌人 | 15Hz | 10Hz | 2Hz | 不同步 |
| 队友 | 20Hz | 20Hz | 10Hz | 5Hz |
| 投掷物 | 30Hz | 30Hz | 15Hz | 不同步 |
| 尸体/掉落物 | 10Hz | 5Hz | 不同步 | 不同步 |
| 远处特效 | — | 事件驱动 | 事件驱动 | 不同步 |

#### 反作弊视角的 IM

```cpp
// 错误做法（会被透视外挂利用）：
// 把所有距离内的敌人发给客户端，由客户端自己做遮挡剔除
// → 外挂读取内存中的实体列表 → 透视（Wall Hack）

// 正确做法：
// 服务器做遮挡判断，只发客户端"应该看到"的实体
// → 外挂内存里没有墙后敌人的数据 → 无法透视

// 代价：服务器需要做射线检测（CPU 开销）
// 优化：PVS 预计算 + 分时间片做射线（不必每帧对每实体）
//      如：高频实体每帧检测，低频实体每 100ms 检测一次
```

#### 与 MMO AOI 的核心区别

| 维度 | MMO AOI | FPS Interest Management |
|------|---------|------------------------|
| 主要过滤 | 距离 | 距离 + 视锥 + 遮挡 + 声音 |
| 同步频率 | 均匀（如 5Hz） | 分层动态（2-30Hz） |
| 反作弊要求 | 低（一般无透视外挂威胁） | 极高（透视是最常见外挂） |
| 地图特征 | 开放世界 | 室内 + 遮挡多 |
| 玩家数 | 同屏可达数百 | 通常 ≤ 20 |
| 空间索引 | 九宫格 / Grid | Uniform Grid + PVS |
| 延迟敏感度 | 中（200ms 可接受） | 极高（>100ms 影响体验） |

### ⚡ 实战经验

- **遮挡检测是最大 CPU 开销**：一个 10v10 的服务器，每帧需要 ~100 条射线检测。优化方案：PVS 预计算 + 分帧轮检（将实体分成 3 组，每帧只检测其中 1 组，相当于 3 帧轮一次）
- **频率切换要做平滑过渡**：敌人从 30Hz 区进入 10Hz 区时，突然降频会导致动作卡顿感。在边界区做 1-2 秒的渐变过渡，或者利用插值掩盖
- **投掷物和特效的降频策略不同**：子弹轨迹不可降频（它决定命中判定），但视觉特效可以降频（客户端收到事件后自己补全动画）
- **测试时要模拟 spectator（观战）模式**：观战玩家的 IM 策略和正常玩家不同——他可以看全场，但不应收到实时数据（防止信息泄露给被观战玩家），需要单独的同步频道

### 🔗 相关问题

- 服务器做遮挡检测的 CPU 开销如何控制在预算内？PVS 预计算适用于动态可破坏地形吗？
- 在大逃杀游戏（PUBG/Apex）中，100 人地图的 IM 策略与传统 FPS 有什么不同？
- 如何防止客户端通过修改视野角度（FOV）来绕过视锥过滤，获取更多信息？
