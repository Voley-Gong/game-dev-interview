---
title: "技能树/天赋树系统架构怎么设计？如何处理前置依赖、洗点重置和构建预设？"
category: "architecture"
level: 3
tags: ["技能树", "天赋树", "有向无环图", "前置依赖", "洗点", "构建预设"]
related: ["architecture/skill-system", "architecture/save-system-architecture", "architecture/buff-status-effect-system"]
hint: "不是「一棵树随便加点」——是「有向无环图依赖校验 + 点数预算约束 + 洗点事务回退 + 构建预设序列化 + 增益效果归并」"
---

## 参考答案

### ✅ 核心要点

1. **技能树本质是有向无环图（DAG），不是简单的树**：节点间的「前置依赖」形成有向边（A 必须先点才能点 B），多条路径汇聚到同一节点（B 依赖 A1 和 A2）使结构退化为 DAG 而非纯树。解锁校验必须遍历入边检查「所有前置节点是否已激活」，而不是简单查父节点——这是新手最常踩的「只查父节点导致跳级解锁」Bug。
2. **点数预算（Point Budget）约束构建深度**：玩家拥有的技能点是稀缺资源（升级获得、任务奖励、氪金购买），技能树设计的目标是「点数永远不够全点」，逼迫玩家做取舍形成差异化 Build。点数预算必须在配置层声明（每级 +1 点，满级 60 点，树共 80 节点），并在加点时实时校验余额。
3. **洗点（Respec）是事务性回退，不是简单清空**：洗点要把已激活节点全部回收、退还点数、移除对应增益效果，整个过程必须事务化——任意一步失败必须回滚到洗点前状态，否则会出现「点数退了但增益还在」或「点数没退增益没了」的数值错乱。洗点通常消耗资源（金币/道具）或有次数限制，需配置化。
4. **构建预设（Build Preset）支持快速切换流派**：成熟的系统允许玩家保存多套加点方案（如「PVE 输出」「PVP 控制」「坦克」），一键切换而非重新手动点。预设本质是「已激活节点集合」的序列化快照，切换时等价于「洗点 + 批量加点」的事务，需要校验当前点数是否足够覆盖预设。
5. **增益效果归并与实时重算**：树节点激活/移除会增删角色的增益效果（被动属性、技能解锁、机制触发），这些效果必须实时归并到角色的属性修饰器链和技能池中。关键是用「增量更新」而非「全量重算」——只对变化的节点增删 Effect，否则大规模洗点时全量重算会卡帧。

### 📖 深度展开

#### 一、DAG 依赖图与解锁校验

技能树用 DAG 建模，每个节点有入边（前置依赖）和出边（解锁后续）。加点的校验是「所有入边的前置节点均已激活」，拓扑排序用于检测循环依赖和计算可激活节点集：

```typescript
interface SkillNode {
  nodeId: number;
  name: string;
  cost: number;                  // 激活消耗的点数（高层节点更贵）
  prerequisites: number[];       // 前置节点 ID 列表（入边，可能多个）
  grants: SkillGrant[];          // 激活后授予：被动属性 / 解锁技能 / 机制
  branch: 'fire' | 'frost' | 'arcane';  // 分支（同分支有协同加成）
}

interface SkillGrant {
  type: 'stat' | 'ability' | 'mechanic';
  target: string;                // 'crit_rate' / 'fireball' / 'can_dual_cast'
  value: number;                 // 属性加成值 / 技能 ID / 机制开关
}

function canActivate(node: SkillNode, active: Set<number>, points: number): boolean {
  if (active.has(node.nodeId)) return false;          // 已激活
  if (points < node.cost) return false;               // 点数不足
  // 关键：所有前置节点都必须已激活（DAG 入边全满足）
  return node.prerequisites.every(pre => active.has(pre));
}
```

```
火焰天赋树（DAG，非纯树）：
 
  火球术 ──▶ 烈焰精通 ──▶ 熔岩爆发
              │                 ▲
              ▼                 │
           火焰增幅 ──▶ 元素共鸣
                              ▲
            冰霜穿透 ──────────┘  (跨分支前置，形成汇聚 → DAG)

  元素共鸣节点入边 = [熔岩爆发, 冰霜穿透]，两个前置都激活才能点
```

#### 二、点数预算与洗点事务

洗点是高风险操作，必须用事务保证「点数退还」和「增益移除」原子完成，并记录操作日志便于回滚和客诉查证：

```typescript
interface TreeState {
  pointsTotal: number;           // 累计获得的点数
  pointsSpent: number;           // 已消耗
  activeNodes: Set<number>;      // 已激活节点
}

async function respecTransaction(
  tree: TreeState, nodes: Map<number, SkillNode>, costItem: ItemCost
): Promise<TreeState> {
  const snapshot = clone(tree);              // 事务快照，失败可回滚
  try {
    await consumeItem(costItem);             // 1. 先扣洗点道具（失败则整体中止）
    const toRemove = [...tree.activeNodes];
    // 2. 逆序移除增益（按 cost 从高到低，保证依赖一致性）
    for (const nid of toRemove.sort((a, b) => nodes.get(b)!.cost - nodes.get(a)!.cost)) {
      removeGrants(nodes.get(nid)!.grants);  // 从角色属性/技能池移除
    }
    tree.activeNodes.clear();
    tree.pointsSpent = 0;                    // 3. 退还全部点数
    await persistTree(tree);
    await logRespec({ before: snapshot, after: tree });  // 审计日志
    return tree;
  } catch (e) {
    restoreTree(snapshot);                   // 失败 → 回滚到洗点前
    throw e;
  }
}
```

| 洗点策略 | 点数退还 | 增益处理 | 玩家体验 | 实现要点 |
|---------|---------|---------|---------|---------|
| 全额免费洗点 | 100% 退还 | 全部移除 | 零成本试错，适合频繁改版 | 注意防刷（每日限次） |
| 消耗道具洗点 | 100% 退还 | 全部移除 | 有成本，玩家慎重 | 道具发放要平衡经济 |
| 按级递增收费 | 100% 退还 | 全部移除 | 越洗越贵，抑制频繁切换 | 费用配置化 |
| 部分洗点（仅某分支） | 分支点数退还 | 仅移除该分支 | 精细化调整，低风险 | 需分支隔离点数预算 |

#### 三、构建预设与效果增量归并

构建预设是「已激活节点集合」的序列化快照，一键切换等于事务化的洗点+批量加点。效果归并用增量 diff 而非全量重算，保证大规模切换不卡帧：

```typescript
interface BuildPreset {
  presetId: string;
  name: string;                  // 「PVE 爆发」「PVP 控制」
  activeNodes: number[];         // 快照：激活节点 ID 列表
}

// 切换预设 = 计算 diff，只增删变化的节点（增量，不全量重算）
function applyPreset(current: Set<number>, target: number[]): void {
  const targetSet = new Set(target);
  const toAdd = targetSet.difference(current);     // 新增激活
  const toRemove = current.difference(targetSet);  // 移除激活
  // 先移除（逆依赖序），后添加（拓扑序），保证中间态合法
  for (const nid of topologicalSort(toRemove, 'desc')) removeGrants(getNode(nid).grants);
  for (const nid of topologicalSort(toAdd, 'asc'))  applyGrants(getNode(nid).grants);
}

// 增益归并到角色：去重 + 叠加规则（同名取最高 / 叠层 / 独立）
function applyGrants(grants: SkillGrant[], char: Character) {
  for (const g of grants) {
    if (g.type === 'stat') char.modifiers.push(toModifier(g));   // 进修饰器链
    else if (g.type === 'ability') char.abilityPool.add(g.target); // 解锁技能
    else if (g.type === 'mechanic') char.flags.add(g.target);      // 机制开关
  }
  char.recomputeStats();   // 只在归并后重算一次，而非每个节点重算
}
```

### ⚡ 实战经验

1. **只查父节点导致跳级解锁**：早期解锁校验只检查「父节点是否激活」，但某节点有两个前置（汇聚 DAG），玩家只激活了一个前置就能点该节点，导致未满足的分支被白嫖。改为「入边全部满足」校验后修复。教训：技能树建模时务必按 DAG 处理，不要假设是纯树。
2. **洗点点数不退还事故**：洗点时先清空 activeNodes 再退还点数，但中途持久化失败（数据库超时），导致「节点清了但点数没退」，玩家少了 30 点直接投诉。改为事务快照 + 失败回滚后，再未出现。洗点必须和装备强化一样是事务性消耗。
3. **全量重算卡帧**：40 点满级玩家洗点后重新加点，每激活一个节点都触发一次「全角色属性全量重算」（遍历所有装备+Buff+天赋），40 次重算叠加卡帧 320ms。改为「批量加点结束后只 recomputeStats 一次」+ 增量 diff 后，卡帧降到 8ms。增量归并是大规模改动的性能关键。
4. **预设点数不足静默失败**：切换高级预设时当前点数不够覆盖，系统静默只激活了部分节点，玩家以为切完了进战斗发现技能全没。修复：切换前校验「当前点数 ≥ 预设总消耗」，不足时明确提示「还差 5 点」并中止，不部分应用。
5. **跨职业共用树的分支污染**：双职业系统共用一棵树，洗点时误把另一职业分支的节点也清了，导致玩家另一个职业的加点全没。根本原因是状态没按职业隔离。修复：TreeState 按 professionId 分桶，洗点只操作当前职业的桶。

### 🔗 相关问题

- 技能树和装备/符文/称号等多套系统的属性加成如何统一计算？归并到修饰器链时，天赋树的被动加成应该放在加法层还是乘法层？
- 「天赋重铸」（部分节点可随机升级为高级版本）的随机性如何设计才不会让数值失控？和保底系统怎么结合？
- 技能树的「分支协同加成」（同分支点满 N 个有额外加成）如何在配置层表达？这种条件型增益对增量归并有什么影响？
