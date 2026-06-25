---
title: "游戏云存档（Cloud Save）的存取同步与冲突解决如何设计？离线存档、多设备与版本协调"
category: "network"
level: 3
tags: ["云存档", "存档同步", "冲突解决", "离线", "多设备", "版本控制"]
related: ["network/reconnect-state-recovery", "network/state-convergence-conflict-resolution"]
hint: "玩家在两台设备上离线玩了不同的进度，上线后如何合并存档？"
---

## 参考答案

### ✅ 核心要点

1. **存档即状态快照**：每次存档是游戏完整状态的一个版本（Versioned Snapshot），包含版本号、时间戳、设备标识
2. **Last-Write-Wins（LWW）是基础策略**：简单但可能丢失进度；进阶方案用字段级 Merge 或 CRDT
3. **离线冲突是核心难题**：两台设备离线各自推进剧情/收集物品，上线后需智能合并而非简单覆盖
4. **增量同步优于全量同步**：只上传变化的字段（Delta Patch），减少存储与带宽开销
5. **原子性与幂等性保证**：存档上传需 CAS（Compare-And-Swap）乐观锁，防止并发覆盖

### 📖 深度展开

#### 存档数据模型

```typescript
interface CloudSave {
    // 元数据
    saveId: string;           // UUID，唯一标识
    userId: string;
    version: number;          // 单调递增版本号
    deviceId: string;         // 来源设备
    timestamp: number;        // 服务端接收时间（Unix ms）
    clientTimestamp: number;  // 客户端生成时间
    schemaVersion: number;    // 存档结构版本（应对游戏更新）
    
    // 存档内容（分槽位）
    slots: {
        [slotName: string]: SaveSlot;
    };
    
    // 校验
    checksum: string;         // 内容 CRC32/MD5
    signature?: string;       // 防篡改签名（HMAC）
}

interface SaveSlot {
    // 进度类字段（不可合并，取最新）
    storyProgress: number;        // 主线进度 ID
    playtime: number;             // 总游戏时长（秒）
    
    // 收集类字段（可并集合并）
    collectedItems: string[];     // 已收集物品 ID 列表
    unlockedSkills: string[];     // 已解锁技能
    visitedLocations: string[];   // 已探索地点
    
    // 状态类字段（LWW，最新时间戳获胜）
    playerLevel: number;
    playerPosition: { x: number; y: number; z: number };
    inventory: InventoryItem[];
    
    // 元信息（用于合并决策）
    fieldTimestamps: { [fieldName: string]: number };
}
```

#### 同步流程

```
设备 A (手机)                    云端                     设备 B (PC)
    │                              │                           │
    │  离线游戏：进度到 Chapter 5   │                           │  离线游戏：进度到 Chapter 3
    │  收集了物品 [101,102,103]    │                           │  收集了物品 [101,104]
    │                              │                           │
    │        上线同步               │                           │
    │─────────────────────────────▶│                           │
    │     POST /save/upload        │                           │
    │     {version: 10, ...}       │                           │
    │                              │                           │
    │                    ┌─────────▼──────────┐                │
    │                    │  Conflict Detector  │                │
    │                    │  当前云端 version: 9 │                │
    │                    │  新上传 version: 10  │                │
    │                    │  → 无冲突，直接接受  │                │
    │                    └─────────┬──────────┘                │
    │                              │                           │
    │◀─────────────────────────────│                           │
    │     200 OK {version: 10}     │                           │
    │                              │        上线同步            │
    │                              │◀──────────────────────────│
    │                              │     POST /save/upload     │
    │                              │     {version: 9, ...}      │
    │                              │     (基于旧的 version)     │
    │                              │                           │
    │                    ┌─────────▼──────────┐                │
    │                    │  Conflict Detector  │                │
    │                    │  当前云端 version: 10 │                │
    │                    │  新上传 version: 9   │                │
    │                    │  → 版本回退，冲突！   │                │
    │                    └─────────┬──────────┘                │
    │                              │                           │
    │                              │   返回 409 Conflict       │
    │                              │   + 云端最新存档           │
    │                              │──────────────────────────▶│
    │                              │                           │
    │                              │           ┌───────────────▼───────┐
    │                              │           │  Client-side Merger    │
    │                              │           │  合并：                  │
    │                              │           │  storyProgress = 5 (max)│
    │                              │           │  collectedItems =       │
    │                              │           │    [101,102,103,104]    │
    │                              │           │  (并集)                  │
    │                              │           └───────────┬───────────┘
    │                              │                       │
    │                              │◀──────────────────────│
    │                              │  POST /save/upload    │
    │                              │  {version: 11, merged}│
    │                              │                       │
    │◀─────────────────────────────│──────────────────────▶│
    │     Push Notification:       │   200 OK               │
    │     "存档已更新"              │                       │
    └──────────────────────────────┘                       └──────────────────────
```

#### 冲突解决策略

```python
from typing import Dict, List, Optional
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class SaveSlot:
    story_progress: int = 0
    playtime: int = 0
    collected_items: List[str] = field(default_factory=list)
    unlocked_skills: List[str] = field(default_factory=list)
    player_level: int = 1
    inventory: List[dict] = field(default_factory=list)
    field_timestamps: Dict[str, int] = field(default_factory=dict)

class SaveMerger:
    """存档合并器"""
    
    # 合并策略配置
    MERGE_STRATEGY = {
        "story_progress": "max",         # 取最大值（进度最远）
        "playtime": "max",               # 取最大值（总时长）
        "collected_items": "union",      # 并集（不丢收集）
        "unlocked_skills": "union",      # 并集
        "visited_locations": "union",    # 并集
        "player_level": "lww",           # Last-Write-Wins
        "player_position": "lww",        # Last-Write-Wins
        "inventory": "lww",             # Last-Write-Wins（背包状态）
    }
    
    def merge(self, cloud: SaveSlot, local: SaveSlot) -> SaveSlot:
        """合并云端存档与本地存档"""
        merged = SaveSlot()
        
        for field_name, strategy in self.MERGE_STRATEGY.items():
            cloud_val = getattr(cloud, field_name)
            local_val = getattr(local, field_name)
            cloud_ts = cloud.field_timestamps.get(field_name, 0)
            local_ts = local.field_timestamps.get(field_name, 0)
            
            if strategy == "max":
                setattr(merged, field_name, max(cloud_val, local_val))
                merged.field_timestamps[field_name] = max(cloud_ts, local_ts)
                
            elif strategy == "union":
                setattr(merged, field_name, 
                        list(set(cloud_val) | set(local_val)))
                merged.field_timestamps[field_name] = max(cloud_ts, local_ts)
                
            elif strategy == "lww":
                if cloud_ts >= local_ts:
                    setattr(merged, field_name, cloud_val)
                    merged.field_timestamps[field_name] = cloud_ts
                else:
                    setattr(merged, field_name, local_val)
                    merged.field_timestamps[field_name] = local_ts
        
        return merged
    
    def detect_irreconcilable(self, cloud: SaveSlot, 
                               local: SaveSlot) -> Optional[str]:
        """检测不可合并的冲突（需要玩家决策）"""
        # 例如：同一选择型任务，两边选了不同选项
        if (cloud.story_progress == local.story_progress 
            and cloud.story_progress > 0):
            cloud_choice = cloud.field_timestamps.get("story_choice")
            local_choice = local.field_timestamps.get("story_choice")
            if (cloud_choice and local_choice 
                and cloud_choice != local_choice):
                return (
                    f"检测到剧情分支冲突：设备A选择了路径{cloud_choice}，"
                    f"设备B选择了路径{local_choice}，请选择保留哪个进度。"
                )
        return None
```

#### 服务端 API 设计

```
POST /api/v1/save/upload
  Header: Authorization: Bearer <token>
  Body: { saveId, version, deviceId, slots, checksum }
  
  Response 200: { version, saveId, accepted: true }
  Response 409: { 
      error: "VERSION_CONFLICT", 
      cloudVersion: 10,
      cloudSave: { ... },       // 云端完整存档供客户端合并
      message: "云端有更新的存档，请合并后重新上传"
  }
  Response 422: { error: "CHECKSUM_MISMATCH" }
```

```
GET /api/v1/save/download?slot=all
  Header: Authorization: Bearer <token>
  
  Response 200: { saveId, version, slots, timestamp }
  Response 304: { version }  # Not Modified（客户端已有最新）
```

#### 增量同步 vs 全量同步

| 维度 | 全量同步 | 增量同步 |
|------|----------|----------|
| 数据量 | 大（完整存档 100KB-10MB） | 小（仅变化字段 1-10KB） |
| 实现复杂度 | 简单 | 需要 Diff 引擎 |
| 冲突概率 | 低（整体替换） | 高（字段级冲突） |
| 恢复能力 | 强（完整快照） | 弱（需要基准版本） |
| 适用场景 | 关键节点存档 | 高频自动存档 |

> 实践中采用**混合策略**：关键节点（Boss 战后、章节结束）做全量存档；高频自动存档（每 30 秒）做增量同步，以基准版本 + Delta Patch 形式上传。

### ⚡ 实战经验

- **玩家最痛恨的是丢存档**：云存档的 #1 优先级是数据安全而非性能。服务端必须保留至少 3 个历史版本（N-1、N-2、N-3），并提供回滚功能
- **合并逻辑放在客户端做**：服务端只做版本检查和冲突检测（轻量），合并逻辑在客户端执行。这样减少服务端计算压力，也方便玩家在 UI 上看到冲突详情并手动决策
- **Schema 版本兼容是隐藏地雷**：游戏更新后存档结构变化（如新增字段），老客户端上传的存档缺少新字段。服务端需要 Schema Migration 层，用默认值填充缺失字段
- **存档大小控制**：开放世界游戏的存档可达 10MB+（含地图探索状态）。增量同步时务必做字段级 Diff，否则每次上传全量数据会吃满移动用户的流量配额

### 🔗 相关问题

- 如果玩家恶意修改本地存档并上传，服务端如何检测与回滚？
- 断线重连后的状态恢复（Reconnect & State Recovery）与云存档恢复有什么区别？
- CRDT（Conflict-free Replicated Data Types）能否用于存档合并？在游戏场景中的局限性是什么？
