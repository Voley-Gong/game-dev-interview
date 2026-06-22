---
title: "游戏红点系统怎么设计？百万级红点条件如何做到不卡顿？"
category: "architecture"
level: 3
tags: ["红点系统", "依赖图", "脏标记", "Dirty Flag", "拓扑排序", "UI架构", "数据驱动"]
related: ["architecture/ui-framework", "architecture/event-driven-vs-data-driven"]
hint: "不是「每个按钮轮询一遍条件」——是「把红点条件建模成 DAG 依赖图，源数据变更时自底向上传播脏标记，UI 只读最终布尔值」。"
---

## 参考答案

### ✅ 核心要点

1. **红点本质是「条件求值 + 依赖传播」**：每个红点节点 = 一个布尔条件（有新邮件？任务可领？商店可购买？）+ 一组子节点（父节点在任一子节点亮时也亮）。MMO/二次元游戏里红点节点规模可达上万个，暴力轮询每帧必卡。
2. **核心数据结构是有向无环图（DAG）**：节点分三类——叶子节点（条件求值，如「有未读邮件」）、组合节点（AND/OR 聚合子节点状态）、UI 节点（绑定到具体按钮的显示）。父节点依赖子节点，传播方向严格自底向上，禁止循环。
3. **脏标记（Dirty Flag）模式是性能关键**：源数据变更时（收到新邮件），只标记对应叶子节点为 dirty，延迟到「下一帧 UI 刷新前」才批量传播重算。避免一次数据变更触发整树 O(N) 重算。
4. **条件求值要「事件驱动注册」而非「主动轮询」**：叶子节点不主动每帧检查条件，而是订阅「数据源变更事件」（背包变更/任务进度变更/邮件到达），由事件驱动 MarkDirty。这是「事件驱动触发」+「数据驱动求值」的混合。
5. **传播算法用拓扑排序**：从 dirty 叶子节点出发，按拓扑序向上传播（保证父节点在所有子节点更新后才重算），单次传播成本 = O(受影响节点数)，远低于全量重算 O(总节点数)。MMO 实测从 8-15ms 降到 0.5-1ms。
6. **UI 绑定要支持「路径式订阅」**：UI 按钮按「背包.道具.可升级」「公会.战令.可领奖」这种点分路径订阅，路径注册时框架自动建立父子链。这是策划可配置、不写代码就能加红点的关键。

### 📖 深度展开

**1. 红点节点的 DAG 数据结构**

```typescript
// 三类节点：叶子节点(condition 求值) / 组合节点(AND|OR 聚合子节点) / UI 节点(绑定按钮显示)
class RedDotNode {
  path: string;                 // 点分路径，如 "Bag.Item.Upgradable"
  children: RedDotNode[] = [];  // 子节点（父节点依赖它们的状态）
  parent: RedDotNode | null = null;
  isDirty: boolean = false;     // 脏标记：值可能过期，待重算
  condition?: () => boolean;    // 仅叶子节点有：实际求值逻辑
  cachedValue: boolean = false; // 缓存的最终布尔值，UI 直接读它

  // 组合节点聚合逻辑：OR(任一子亮则亮) 或 AND(全部子亮才亮)
  aggregate: "OR" | "AND" = "OR";

  evaluate(): boolean {
    if (this.children.length === 0 && this.condition) {
      return this.condition();          // 叶子节点：执行条件函数
    }
    if (this.aggregate === "OR") {
      return this.children.some(c => c.cachedValue);  // 组合 OR
    }
    return this.children.every(c => c.cachedValue);   // 组合 AND
  }
}
```

红点节点之间的依赖关系是一棵自底向上的树（也可视作 DAG）：

```
            [MainHUD]              ← UI 根节点（OR 聚合）
           /     |    \
       [Bag]  [Mail]  [Quest]      ← 组合节点（OR 聚合）
        / \      |      /  \
   [Item] [Equip] [New] [Daily] [Achieve]  ← 叶子节点（条件求值）
```

**2. 脏标记传播算法（拓扑排序）**

```typescript
class RedDotSystem {
  private dirtyQueue: RedDotNode[] = [];

  // 源数据变更时调用：只标记叶子节点为脏，入队，不立即重算
  markDirty(node: RedDotNode): void {
    if (!node.isDirty) {
      node.isDirty = true;
      this.dirtyQueue.push(node);
    }
  }

  // 下一帧 UI 刷新前统一处理：按拓扑序（子先于父）批量重算
  processDirtyQueue(): void {
    // 按节点深度排序，保证子节点先于父节点出队（拓扑序）
    this.dirtyQueue.sort((a, b) => this.depth(b) - this.depth(a));

    while (this.dirtyQueue.length > 0) {
      const node = this.dirtyQueue.pop()!; // 最深的（最底层叶子）先处理
      node.isDirty = false;
      const newValue = node.evaluate();
      const flipped = newValue !== node.cachedValue;
      node.cachedValue = newValue;

      // 关键优化：仅当值真正翻转时才向上传播，避免无效重算
      if (flipped && node.parent) {
        this.markDirty(node.parent);
      }
    }
  }

  private depth(n: RedDotNode): number {
    let d = 0;
    let p = n.parent;
    while (p) { d++; p = p.parent; }
    return d;
  }
}
```

收到新邮件后的传播序列（脏标记增量向上扩散）：

```
[收到新邮件] → markDirty(Mail.New)
     ↓ processDirtyQueue()
Mail.New 重算=true(翻转) → markDirty(Mail)
Mail   重算=true(翻转) → markDirty(MainHUD)
MainHUD 重算=true(翻转) → UI 刷新红点显示
（其他 9990 个节点完全不参与，单帧只算 3 个节点）
```

**3. 条件求值的注册式架构**

```typescript
// 叶子节点的条件通过「注册」方式订阅数据源事件，而非主动轮询
interface ICondition {
  register(dataSource: unknown): void; // 订阅数据源变更事件
  evaluate(): boolean;                  // 实际求值
}

class UnreadMailCondition implements ICondition {
  private mailbox: MailBox;
  register(dataSource: MailBox): void {
    this.mailbox = dataSource;
    // 事件驱动：邮件变更 → 触发 MarkDirty，而非每帧检查
    this.mailbox.OnChanged.add(() => redDotSystem.markDirty(this.node));
  }
  evaluate(): boolean {
    return this.mailbox.unreadCount > 0;
  }
}
```

| 数据源事件 | 关联叶子节点路径 |
|---|---|
| `Inventory.OnItemAdded` | `Bag.Item.Upgradable` |
| `Inventory.OnItemRemoved` | `Bag.Item.Upgradable`、`Bag.Equip.Available` |
| `Quest.OnProgressChanged` | `Quest.Daily.Claimable`、`Quest.Achieve.Rewardable` |
| `MailBox.OnChanged` | `Mail.New`、`Mail.RewardClaimable` |
| `Shop.OnRefresh` | `Shop.Limited.Buyable`、`Shop.Free.Claimable` |
| `Guild.OnMemberChanged` | `Guild.War.Joinable` |

**4. 三种实现方案的性能对比**

| 方案 | 单帧成本(5000节点) | 响应延迟 | 实现复杂度 | 适用规模 |
|---|---|---|---|---|
| 全量轮询（O(N) 每帧） | 8-15ms（中端安卓机实测） | 0（即时） | 低（最朴素） | ≤500 节点的小游戏 |
| 事件驱动全量重算（O(N) 但仅变更时） | 3-5ms/事件 | 1 帧 | 中 | ≤2000 节点的中型项目 |
| 脏标记增量传播（O(变更节点数)） | 0.5-1ms/变更 | 1 帧 | 中高 | 万级节点的 MMO/二次元 |

关键差距：脏标记方案将单帧成本从「全量 N」降到「变更数 k」，当 k≪N（典型 20-50 ≪ 10000）时，性能提升 100-300 倍。

**5. 路径式订阅与运行时建树**

```typescript
class RedDotSystem {
  private root: RedDotNode = new RedDotNode();
  private nodeMap: Map<string, RedDotNode> = new Map();

  // 注册一个红点：解析点分路径，自动创建中间组合节点并连接父子链
  register(path: string, condition: () => boolean): RedDotNode {
    const segments = path.split(".");        // "Bag.Item.Upgradable"
    let current = this.root;
    let prefix = "";

    for (const seg of segments) {
      prefix = prefix ? `${prefix}.${seg}` : seg;
      let node = this.nodeMap.get(prefix);
      if (!node) {
        node = new RedDotNode();
        node.path = prefix;
        node.parent = current;
        current.children.push(node);
        this.nodeMap.set(prefix, node);
      }
      current = node;
    }
    current.condition = condition; // 最末节点挂条件函数（成为叶子）
    return current;
  }
}

// 示例：一行注册一个红点，自动建好 Bag → Item → Upgradable 的父子链
redDotSystem.register("Bag.Item.Upgradable", () => inventory.hasUpgradable());
redDotSystem.register("Quest.Daily.Claimable", () => quest.canClaimDaily());
```

这段代码使红点路径可以写进策划配置表：策划在 Excel 里填一行 `Bag.Item.Upgradable` 并指定关联数据键，运行时框架读取配置、自动建树、自动绑定条件。新增红点零代码、热更新、可回滚，彻底解耦了策划与程序的工作流。

### ⚡ 实战经验

- **全量轮询在 5000+ 节点时单帧 8-15ms**（中端安卓机实测），改用脏标记传播后降到 0.5-1ms——只有实际变更的 20-50 个节点重算。这是红点系统从「卡」到「丝滑」的分水岭。
- **循环依赖是红点系统最隐蔽的 Bug**：A 依赖 B、B 又依赖 A → 传播死循环，CPU 直接拉满。建树时必须做 DAG 校验（拓扑排序检测环），一旦发现环立刻报错拒绝注册。
- **UI 面板销毁时必须反订阅红点**：忘记反订阅 → 内存泄漏 + 红点刷新时访问已销毁的 GameObject 抛 MissingReferenceException。规范做法：UI 基类在 OnDisable/OnDestroy 自动注销该面板所有红点订阅。
- **策划配置的红点路径可能 typo**：策划写「Beg.Item.Upgradable」（少了个 a），运行时找不到数据键，红点静默失效。注册时要校验路径存在性 + 输出警告日志，CI 阶段做配置静态检查。
- **跨系统红点要用条件聚合器**：如「公会战可参加」依赖「公会成员 + 战斗CD + VIP等级 + 等级≥30」四个数据源。不要在单个 UI 节点写 100 行 if-else，封装成 CompositeCondition，每个子条件独立测试、独立打日志。

### 🔗 相关问题

- 红点条件和 UI 数据绑定如何彻底解耦？UI 层完全不知道红点逻辑细节？
- 如果红点条件依赖服务器下发数据，断线重连后整树怎么刷新？
- 红点条件求值如果很重（如要遍历整个背包算可升级道具数），怎么做异步/分帧？
