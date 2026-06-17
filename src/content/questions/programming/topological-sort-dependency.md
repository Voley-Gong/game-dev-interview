---
title: "拓扑排序在游戏中有什么用？科技树、任务链、资源加载顺序怎么算？"
category: "programming"
level: 2
tags: ["算法", "图论", "拓扑排序", "依赖管理", "策划工具"]
related: ["programming/data-structures-game", "programming/asset-management-async"]
hint: "面试官真正想问的不是 Kahn 算法的代码，而是循环依赖怎么检测、并行加载怎么用分层拓扑排、策划改了配置怎么快速重算。"
---

## 参考答案

### ✅ 核心要点

1. **拓扑排序解决的核心问题是「有先后依赖的排成线性顺序」**：给定一个有向无环图（DAG），输出一个节点序列，使得每条边 u→v 中 u 都排在 v 前面。游戏中凡是「必须先有 A 才能解锁 B」的关系——科技树、任务前置、装备合成、技能点前置、资源加载依赖——本质上都是 DAG，都需要拓扑排序来确定合法顺序。
2. **两种经典算法：Kahn（BFS 入度法）和 DFS 后序逆序**。Kahn 维护每个节点的入度，每次取入度为 0 的节点输出并削减后继入度，天然能分层（同一批入度为 0 的节点可并行）。DFS 用递归后序遍历再反转，实现更紧凑但不天然分层。游戏加载用 Kahn（要并行），策划工具验证用 DFS（要简洁）。
3. **环检测是拓扑排序的副产品**：若 Kahn 跑完后输出节点数 < 总节点数，说明存在环——也就是「合成铁剑需要铁锭，合成铁锭需要铁剑」这种策划配置错误。必须在编辑器/加载期报错并指出环上的节点，而不是让游戏卡死或栈溢出。
4. **分层拓扑排序是实现并行加载的关键**：把 DAG 按层（同层节点互不依赖）切开，同一层资源可以并发请求，整层就绪后再加载下一层。这比单线程串行加载快 N 倍（N 为平均层宽），是大型场景预加载的标准做法。
5. **动态依赖与增量更新**：玩家解锁新科技、策划热更配置后，不需要重排整张图，只需对受影响子图做局部拓扑更新。配合脏标记和缓存，配置表 5 万节点的科技树重算可从 200ms 降到 3ms。
6. **稳定性是工程需求**：当多个节点都无依赖冲突时，应保持「配置表里的书写顺序」或「优先级字段」作为 tie-breaker，否则每次排序结果不同会导致资源加载闪烁、技能解锁顺序抖动。用优先队列（按 id/优先级）代替普通队列即可稳定。

### 📖 深度展开

#### 1. Kahn 算法实现 + 环检测（以装备合成树为例）

```typescript
// 合成关系：铁剑 ← 铁锭 + 木棍；铁锭 ← 铁矿；木棍 ← 木材
// 边 u→v 表示「u 是 v 的合成材料」（v 依赖 u 先存在）
interface RecipeNode { id: string; name: string; }

class DependencyGraph {
  private adj = new Map<string, Set<string>>();  // u → 依赖它的后继们
  private inDegree = new Map<string, number>();  // 入度 = 还差几个前置

  addNode(id: string): void {
    if (!this.adj.has(id)) { this.adj.set(id, new Set()); this.inDegree.set(id, 0); }
  }

  // 依赖关系：before 必须先于 after（edge: before → after）
  addEdge(before: string, after: string): void {
    this.addNode(before); this.addNode(after);
    if (!this.adj.get(before)!.has(after)) {           // 去重防重复计数
      this.adj.get(before)!.add(after);
      this.inDegree.set(after, (this.inDegree.get(after) || 0) + 1);
    }
  }

  // Kahn 拓扑排序，返回 null 表示存在环
  topoSort(): { order: string[]; layers: string[][] } | null {
    const inDeg = new Map(this.inDegree);              // 拷贝，不破坏原图
    const order: string[] = [];
    const layers: string[][] = [];

    // 第 0 层：所有入度为 0 的节点（无任何前置，可立即处理）
    let layer = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    while (layer.length > 0) {
      layers.push(layer);
      const next: string[] = [];
      for (const node of layer) {
        order.push(node);
        for (const succ of this.adj.get(node) || []) {
          const nd = inDeg.get(succ)! - 1;
          inDeg.set(succ, nd);
          if (nd === 0) next.push(succ);               // 入度归零 → 下一层
        }
      }
      layer = next;
    }

    // ★ 环检测：若输出不全，剩余的就是环上的节点
    if (order.length !== this.adj.size) {
      const cyclic = [...this.adj.keys()].filter(id => !order.includes(id));
      console.error(`检测到循环依赖，涉及节点：${cyclic.join(", ")}`);
      return null;
    }
    return { order, layers };
  }
}

// 构建装备合成 DAG
const g = new DependencyGraph();
g.addEdge("铁矿", "铁锭");    g.addEdge("铁锭", "铁剑");
g.addEdge("木材", "木棍");    g.addEdge("木棍", "铁剑");
const result = g.topoSort();
// order: ["铁矿","木材","铁锭","木棍","铁剑"]
// layers: [["铁矿","木材"], ["铁锭","木棍"], ["铁剑"]]  ← 每层可并行
```

```
合成依赖 DAG：
  铁矿 ──► 铁锭 ──┐
                  ├──► 铁剑        分层拓扑：
  木材 ──► 木棍 ──┘                  Layer0: [铁矿, 木材]   (并行采集)
                                     Layer1: [铁锭, 木棍]   (并行合成)
                                     Layer2: [铁剑]         (最终合成)
  若策划误配 铁锭→铁剑 且 铁剑→铁锭 → topoSort() 返回 null + 报出环
```

#### 2. 分层拓扑用于并行资源加载

```typescript
// 场景预加载：场景依赖若干资源，资源间又有依赖（材质依赖纹理，预制体依赖材质）
async function loadSceneParallel(
  graph: DependencyGraph,
  loader: (id: string) => Promise<void>
): Promise<void> {
  const sorted = graph.topoSort();
  if (!sorted) throw new Error("资源依赖图存在环，无法加载");

  for (const layer of sorted.layers) {
    // 同一层的资源互不依赖，可全部并发请求
    await Promise.all(layer.map(id => loader(id)));
    // 整层就绪后才开始下一层，保证依赖的纹理先于材质加载完
  }
}
// 假设 3 层每层 4 个资源，单个加载 100ms：
//   串行：3×4×100 = 1200ms     并行分层：3×100 = 300ms（4 倍提升）
```

| 加载策略 | 总耗时（N 层 × M 个/层，单个 100ms） | 内存峰值 | 失败恢复 |
|---------|--------------------------------------|---------|---------|
| 纯串行 | N×M×100ms | 低（同时只 1 个） | 简单（失败即停） |
| 全部并发 | 100ms（忽略并发上限） | ★极高（N×M 同时在内存） | 难（依赖未就绪就崩） |
| **分层并发** | N×100ms | 中（同层并发） | 中（按层回滚） |

#### 3. Kahn vs DFS：何时用哪个

```typescript
// DFS 版拓扑：递归后序 + 反转
function dfsTopo(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();   // 完成标记
  const onStack = new Set<string>();   // 当前递归栈（用于环检测）
  const result: string[] = [];
  let hasCycle = false;

  function dfs(node: string): void {
    if (hasCycle) return;
    onStack.add(node);
    for (const next of graph.get(node) || []) {
      if (onStack.has(next)) { hasCycle = true; return; }   // 回边 → 环
      if (!visited.has(next)) dfs(next);
    }
    onStack.delete(node);
    if (!visited.has(node)) { visited.add(node); result.push(node); }  // 后序
  }
  for (const node of graph.keys()) dfs(node);
  return hasCycle ? null : result.reverse();  // 后序逆序即拓扑序
}
```

| 维度 | Kahn（BFS 入度） | DFS（后序逆序） |
|------|-----------------|----------------|
| 实现形态 | 迭代 + 队列 | 递归（深图可能栈溢出） |
| 天然分层 | ✅ 同批入度 0 可并行 | ❌ 需额外计算层 |
| 环检测 | 输出数 < 节点数即有环 | 回边检测，能精确定位环边 |
| 稳定性 | 用优先队列可稳定 | 取决于遍历起点顺序 |
| 游戏首选场景 | 资源并行加载、技能解锁顺序 | 配置校验、策划工具查环 |

### ⚡ 实战经验

- **循环依赖上线后才暴露**：某 SLG 科技树策划误配「骑兵科技依赖弓兵科技，弓兵科技又依赖骑兵科技」，测试没覆盖到该分支，上线后玩家点到此处科技树面板直接卡死。修复：在配置加载期强制跑拓扑校验，发现环直接拒绝加载并高亮报错节点，杜绝运行时栈溢出。
- **分层加载内存峰值翻车**：一个开放世界场景资源 DAG 有 8 层，每层并发拉了 40 个贴图，内存峰值瞬间冲到 1.2GB 导致低端机 OOM。改成「每层限制并发数 ≤ 6」+ LRU 卸载上层后，峰值降到 400MB，加载时间仅多 15%。
- **不稳定排序导致技能解锁抖动**：用普通队列做 Kahn，玩家同时满足多个技能解锁条件时，每次重算解锁顺序都不同，UI 列表闪烁。换成按技能 id 排序的优先队列后顺序稳定，并可在策划配置里加 `priority` 字段微调。
- **增量更新比全量重算快 60 倍**：5 万节点的全服活动依赖图，玩家每解锁一个节点全量重排要 200ms（明显卡顿）。改成「只对解锁节点的后继子图做局部拓扑更新」+ 缓存后，单次更新降到 3ms。
- **DFS 栈溢出**：策划工具用递归 DFS 验证一张 3 万节点的长链科技树，Node.js 默认栈深直接 RangeError。改用迭代式 DFS（显式栈）或直接上 Kahn（天然迭代）解决，深链图务必避免递归。

### 🔗 相关问题

1. 如果依赖关系带「可选前置」（A 既可以由 B 解锁也可以由 C 解锁，满足其一即可），这种「或依赖」如何改造拓扑排序？
2. 任务系统里玩家可以任意顺序接任务但有推荐顺序，如何用拓扑排序生成一条「推荐主线」并标注可并行的支线？
3. 资源热更时如何对比新旧依赖图，只重新加载发生变化的子图而非整个场景？
