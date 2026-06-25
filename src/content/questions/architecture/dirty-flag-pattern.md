---
title: "脏标记模式（Dirty Flag）在游戏开发中如何应用？如何用「延迟计算」避免每帧无效更新？"
category: "architecture"
level: 3
tags: ["脏标记", "DirtyFlag", "设计模式", "性能优化", "延迟计算", "观察者"]
related: ["architecture/event-driven-vs-data-driven", "architecture/object-pool-design-pattern", "architecture/scene-management-architecture"]
hint: "不是每次数据变化都立刻重算，而是打个「脏」标记，等真正需要结果时才统一计算——把 O(每帧×对象数) 的全量更新降到 O(实际变化×对象数)。"
---

## 参考答案

### ✅ 核心要点

1. **脏标记模式 = 「标记变化 + 延迟计算」**：对象内部维护一个 `isDirty` 布尔标志，数据被修改时只置脏、不立即重算；当外部真正读取结果（或帧末统一刷新）时，若脏才重新计算并清脏。核心思想是「把计算推迟到必须发生的时刻」。
2. **解决的核心问题是「冗余计算」**：UI 每帧全量刷新、变换矩阵每帧重算、场景图每帧遍历——如果 99% 的帧数据没变，全量计算就是浪费。脏标记让「没变就不算」，性能立竿见影。
3. **与「观察者/事件驱动」的区别**：事件驱动是「变化时立刻通知并处理」（推模式），脏标记是「变化时只记一笔，稍后批量处理」（拉模式）。脏标记天然合并多次连续修改（同一帧改 10 次属性只重算 1 次），事件驱动会触发 10 次回调。
4. **本质是用空间换时间 + 批量化**：多存一个 bool（几乎零成本），换取可能昂贵计算的跳过。适用于「计算成本高、读取频率低于修改频率、且允许短暂不一致」的场景。
5. **传播性是难点**：父节点脏了，子节点依赖父节点的结果（如世界变换矩阵），子节点也得标记脏。脏标记的「向上标记、向下传播」链路设计不当会导致结果不更新或过度更新。

### 📖 深度展开

**1. 经典应用：变换矩阵的延迟计算**

```
场景：场景图中每个节点有 Position/Rotation/Scale，世界矩阵 = 父世界矩阵 × 本地矩阵
  ❌ 无脑全量：每帧对所有节点重算世界矩阵（哪怕没动）
  ✅ 脏标记：只在节点或其祖先变化时标记脏，渲染前统一刷新脏节点
```

```csharp
public class SceneNode {
    private Vector3 _localPos;
    private Matrix4x4 _worldMatrix;
    private bool _isDirty = true;          // 初始脏（首次必须算）
    private SceneNode _parent;
    public List<SceneNode> Children { get; } = new();

    public Vector3 LocalPosition {
        get => _localPos;
        set {
            if (_localPos != value) {
                _localPos = value;
                MarkDirty();                // 改了 → 标脏，不立刻算
            }
        }
    }

    // 关键：自己脏，所有子节点也得脏（世界矩阵依赖父矩阵）
    private void MarkDirty() {
        if (_isDirty) return;               // 已经脏了，避免重复传播
        _isDirty = true;
        foreach (var child in Children)
            child.MarkDirty();              // 向下传播
    }

    // 真正读取时才计算（渲染/碰撞检测前调用 WorldMatrix）
    public Matrix4x4 WorldMatrix {
        get {
            if (_isDirty) {
                var local = Matrix4x4.CreateTranslation(_localPos);
                _worldMatrix = _parent != null ? _parent.WorldMatrix * local : local;
                _isDirty = false;           // 算完清脏
            }
            return _worldMatrix;
        }
    }
}
// 收益：静止不动的节点 WorldMatrix 直接返回缓存，零计算
```

**2. UI 刷新：合并多次修改**

```csharp
// ❌ 事件驱动：每改一个属性触发一次刷新
player.Hp = 90;  // → 触发 OnHpChanged → 血条刷新 1
player.Hp = 85;  // → 触发 OnHpChanged → 血条刷新 2（同一帧刷了 2 次，浪费）
player.Hp = 80;  // → 触发 OnHpChanged → 血条刷新 3

// ✅ 脏标记：一帧内多次修改只标记脏，帧末统一刷一次
public class PlayerModel {
    private int _hp;
    private readonly DirtySet _dirty = new();  // 脏标记集合
    public int Hp {
        get => _hp;
        set { _hp = value; _dirty.Add(DirtyFlag.Hp); }  // 只标记，不刷新
    }
    public void FlushIfDirty(UITableView ui) {
        if (_dirty.Has(DirtyFlag.Hp)) {
            ui.SetHp(_hp);
            _dirty.Remove(DirtyFlag.Hp);       // 清脏
        }
        // ... 其他脏属性同理，一帧只刷一次
    }
}
```

**3. 脏标记 vs 事件驱动 vs 全量刷新对比**

| 维度 | 全量刷新 | 事件驱动（推） | 脏标记（拉） |
|------|---------|---------------|-------------|
| 触发时机 | 每帧固定 | 数据变化立即 | 读取/帧末按需 |
| 同帧多次修改 | — | 触发多次回调 | ✅ 合并为 1 次 |
| 未变化开销 | 每对象都算 | 无 | ✅ 零（跳过） |
| 结果时效性 | 实时 | 实时 | 有 1 帧延迟 |
| 实现复杂度 | 低 | 中 | 中（需传播管理） |
| 适合场景 | 对象少 | 跨模块通知 | ✅ 高频数据/UI/变换 |

**4. 传播方向图解**

```
脏标记的两种传播方向：

A. 向下传播（变换矩阵类——父变子脏）：
   Parent 脏 ──→ Child 脏 ──→ GrandChild 脏
   （子节点的世界结果依赖父节点的世界结果）

B. 向上收集（聚合统计类——子变父脏）：
   GrandChild 变 ──→ 标记 Parent 脏 ──→ 标记 Root 脏
   （如：子物体移动了，父容器的包围盒要重算）

C. 横向依赖（A 依赖 B 的结果——B 变 A 脏）：
   B.Position 变 ──→ A（依赖 B 的碰撞体）标脏
   注意：横向依赖容易形成环，需用拓扑排序或分层刷新避免循环
```

### ⚡ 实战经验

- **脏标记必须有明确的「同步点」**：标记脏后，必须在确定的时机统一清脏（如帧末 `LateUpdate`、渲染前 `PreRender`、读取时惰性计算）。如果忘了清脏，要么每帧都重算（标记形同虚设），要么结果永远是旧的（脏了再也不清）。最稳妥的做法是把同步点集中在一个地方，别散落在各系统里。
- **警惕「总是脏」的伪优化**：如果数据几乎每帧都变（如战斗中的血条平滑插值），脏标记永远是脏的，等于多了标记开销却没省计算。这种情况要么放弃脏标记改用事件/直接调用，要么降低标记频率（如「变化超过阈值才标脏」）。
- **传播链路要做防环检查**：节点 A 标脏触发 B 标脏、B 又触发 A，形成死循环。设计时明确依赖是 DAG（有向无环图），并在 `MarkDirty` 里加「已经脏就 return」的短路（见上方 `if (_isDirty) return`），这是防止传播风暴的关键一行。
- **脏标记适合「读取少、修改多」或「批量修改」**：如果读取频率远高于修改，脏标记反而不如直接计算（每次修改都重算，读取零成本）。判断标准：看「跳过的计算总成本」是否大于「标记/检查的额外成本」，对象数越多、计算越重，收益越明显。

### 🔗 相关问题

1. 脏标记模式和 ECS 的「变更追踪（Change Tracking / Version Number）」机制有什么联系？Unity DOTS 如何用版本号实现高效的增量查询？
2. 在网络同步中，如何用脏标记决定「哪些属性需要这一帧同步」？和「全量快照同步」相比带宽节省多少？
3. 场景图的包围盒（Bounding Volume）重算也是脏标记的经典应用，如何处理「父包围盒依赖所有子包围盒」的向上传播？
