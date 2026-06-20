---
title: "Minimax与Alpha-Beta剪枝怎么做游戏AI？五子棋/卡牌/回合制战斗的博弈树搜索"
category: "programming"
level: 3
tags: ["算法", "博弈树", "Minimax", "Alpha-Beta剪枝", "游戏AI", "搜索算法"]
related: ["programming/recursion-tail-call-game", "programming/behavior-tree-hfsm-game-ai", "programming/priority-queue-binary-heap"]
hint: "五子棋AI为什么能想到10步之后？不是真的'想'，是把所有可能走法展开成一棵树，叶节点用评估函数打分，自底向上取极值。"
---

## 参考答案

### ✅ 核心要点

1. **博弈树是对抗场景的建模**：所有两人零和博弈（五子棋、井字棋、卡牌、回合制战斗）都可以建模成一棵树——根节点是当前局面，每个子节点是"我的一种走法"，再下一层是"对手的应对"，交替展开。"我"要分数最大化（Max 层），"对手"要分数最小化（Min 层），这就是 Minimax 的核心：双方都做最优决策的前提下，倒推当前局面的真实价值。
2. **评估函数是 AI 强弱的关键**：叶子节点（棋下完了或达到搜索深度上限）需要一个 `evaluate(board) → score` 函数把局面转成分数。五子棋评估"连子数+开放度"，卡牌评估"场面价值+手牌潜力"。AI 的水平 90% 取决于评估函数设计——同一套 Minimax，好评估函数能让 AI 从"乱下"变成"职业水平"。
3. **Alpha-Beta 剪枝是性能飞跃**：朴素 Minimax 要展开所有节点（分支因子 b、深度 d，节点数 O(b^d)）。Alpha-Beta 利用"对手不会选对我更好的分支"这一性质，剪掉不可能影响结果的子树，最优情况下节点数降到 O(b^(d/2))——同样算力下搜索深度翻倍。剪枝不改变结果，只减少计算量。
4. **移动排序决定剪枝效率**：Alpha-Beta 的剪枝量取决于"好走法是否先被搜索"。如果先搜坏走法，几乎剪不到；先搜好走法，剪枝接近理论最优。实战用"上一轮迭代的最佳走法先搜"（move ordering）让剪枝率从 30% 提升到 90%。
5. **迭代加深 + 时间控制**：固定深度搜索在复杂局面会超时（玩家等不了 30 秒）。迭代加深（Iterative Deepening）从深度 1 开始逐步加深，配合超时检查——时间到了就返回上一深度的最佳结果。看似重复计算浪费，实际上有置换表缓存且移动排序越来越好，开销 < 10%，换来了"永远能在规定时间内返回"。
6. **置换表避免重复计算**：不同走法顺序可能到达相同局面（如先走 A 再走 B = 先走 B 再走 A）。用 Zobrist 哈希给每个局面算唯一 key，存进置换表（Transposition Table），遇到已算过的局面直接取结果。棋盘 64 格用 64×N 个随机数 XOR 生成哈希，增量更新 O(1)。

### 📖 深度展开

**1. Minimax + Alpha-Beta 核心实现**

```typescript
type Player = 'max' | 'min';
interface Move { x: number; y: number; }
interface Board { /* 棋盘状态 */ cells: Int8Array; size: number; }

// 评估函数：把局面转成分数（正分=Max方有利，负分=Min方有利）
function evaluate(board: Board): number {
  let score = 0;
  // 统计各方向连子：活四=10000, 活三=1000, 活二=100, 活一=10
  score += countPatterns(board, 4, true) * 10000;   // 我方活四
  score -= countPatterns(board, 4, false) * 10000;  // 对方活四
  score += countPatterns(board, 3, true) * 1000;    // 我方活三
  score -= countPatterns(board, 3, false) * 1000;
  return score;
}

// Alpha-Beta 剪枝：alpha=Max方已知最优下界，beta=Min方已知最优上界
function alphabeta(
  board: Board, depth: number, alpha: number, beta: number, player: Player
): number {
  if (depth === 0 || isGameOver(board)) {
    return evaluate(board);                          // 叶子节点：返回评估分
  }
  const moves = generateMoves(board);                // 生成所有合法走法
  orderMoves(moves, board);                          // 移动排序：好走法优先（关键优化）

  if (player === 'max') {
    let best = -Infinity;
    for (const move of moves) {
      makeMove(board, move);
      const score = alphabeta(board, depth - 1, alpha, beta, 'min');
      undoMove(board, move);
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);                 // 更新Max方下界
      if (beta <= alpha) break;                      // ★ Beta剪枝：Min方不会让Max更好
    }
    return best;
  } else {
    let best = Infinity;
    for (const move of moves) {
      makeMove(board, move);
      const score = alphabeta(board, depth - 1, alpha, beta, 'max');
      undoMove(board, move);
      best = Math.min(best, score);
      beta = Math.min(beta, best);                   // 更新Min方上界
      if (beta <= alpha) break;                      // ★ Alpha剪枝：Max方不会让Min更差
    }
    return best;
  }
}

// 迭代加深 + 时间控制：永远在时间预算内返回最佳走法
function findBestMove(board: Board, timeLimitMs: number): Move {
  const deadline = Date.now() + timeLimitMs;
  let bestMove: Move | null = null;
  for (let depth = 1; depth <= 12; depth++) {        // 从浅到深逐步搜索
    const result = searchRoot(board, depth, deadline);
    if (result.timeout) break;                       // 超时：用上一深度的结果
    bestMove = result.move;
  }
  return bestMove!;
}
```

**2. 博弈树搜索与剪枝过程**

```
五子棋 Max（黑） vs Min（白），深度3，分支因子5（简化）

          [当前局面] Max层（我下黑子，要最大化分数）
         /     |     |     |     \
       走法A  走法B  走法C  走法D  走法E
       /|\    /|\    /|\    /|\    /|\
      ...    ...    ...    ...    ...

Alpha-Beta 剪枝示例（alpha=-∞, beta=+∞）：
  ① 搜完A子树 → A=10 → alpha=10（Max至少能拿10）
  ② 搜B子树，Min层第一个应对算出8
     → Min层在这个分支最多给8，8 < alpha(10)
     → Max不会选B（A更好），B的其余子树全部剪掉 ★
  ③ 搜C子树，Min层第一个应对算出15
     → 高于alpha，继续搜，最终C=12 → alpha=12
  ④ 搜D子树，Min层第一个应对算出5 < alpha(12) → 剪掉 ★
  ⑤ 搜E子树，Min层第一个应对算出11 < alpha(12) → 剪掉 ★

无剪枝：5×5×5 = 125 个叶节点
有剪枝：约 5 + 4×2 + ... ≈ 35 个叶节点（节省 72%）
最优排序下：O(b^(d/2)) = 5^1.5 ≈ 11 个叶节点（节省 91%）
```

**3. 优化手段对比**

| 优化手段 | 原理 | 效果 | 实现难度 | 适用场景 |
|---------|------|------|---------|---------|
| **Alpha-Beta剪枝** | 剪掉不影响结果的子树 | 节点数↓50-90% | 低 | 必装 |
| **移动排序** | 好走法先搜，提升剪枝率 | 剪枝率30%→90% | 中 | 必装 |
| **迭代加深** | 浅→深逐步搜+超时控制 | 时间可控 | 低 | 必装 |
| **置换表(Zobrist)** | 缓存已算局面 | 重复局面O(1) | 中 | 棋类必装 |
| **静态评估剪枝** | 分数远离alpha/beta直接返回 | 浅层提前返回 | 中 | 棋类 |
| **杀手启发** | 同层兄弟节点都剪同一走法 | 剪枝+10% | 中 | 棋类 |
| **MTD(f)/NegaScout** | 零窗口搜索 | 比Alpha-Beta快10% | 高 | 竞赛级AI |
| **蒙特卡洛MCTS** | 随机模拟代替评估函数 | 无需评估函数 | 高 | 围棋/复杂博弈 |

```typescript
// Zobrist 哈希：增量更新棋局唯一标识，O(1) 查置换表
class ZobristHash {
  private table: BigUint64Array;  // [位置×棋子类型] → 随机数
  constructor(size: number, pieceTypes: number) {
    this.table = new BigUint64Array(size * pieceTypes);
    for (let i = 0; i < this.table.length; i++) {
      this.table[i] = randomU64();  // 初始化：每个格子每种棋子一个随机数
    }
  }
  // 落子/悔子：XOR 翻转对应位，O(1) 增量更新
  toggle(hash: bigint, pos: number, piece: number): bigint {
    return hash ^ this.table[pos * pieceTypes + piece];
  }
}
```

### ⚡ 实战经验

- **移动排序是性能分水岭**：五子棋 AI 朴素 Alpha-Beta 深度 6 耗时 8 秒（玩家无法接受），加上"中心位置优先 + 上一步周围优先"的简单排序后，同样深度降到 1.2 秒，再叠加置换表后深度 8 只要 2 秒。移动排序成本极低（一次排序），收益是数量级的——永远先实现移动排序再做其他优化。
- **评估函数过拟合导致"只会一种套路"**：早期五子棋评估只看"连子数"，AI 疯狂造活三但不会防守，被玩家用"双活三"秒杀。加入"对方威胁权重"（对方活四 = 我方负 10000）后 AI 才学会攻守平衡。教训：评估函数要双向加权，不能只算自己的分。
- **JavaScript 数组 vs TypedArray 性能差 10 倍**：棋盘用 `number[][]` 二维数组，15×15 五子棋深度 6 搜索 3.5 秒；改成 `Int8Array(225)` 一维数组（cache 友好）后降到 0.4 秒。根因是 TypedArray 连续内存 + 无装箱，makeMove/undoMove 的 32 位整数读写极快。
- **迭代加深看似浪费实则高效**：担心"深度1到6重复搜索浪费时间"，实测有置换表时总开销只多 8%，换来的是"时间到必返回"的强保证。曾用固定深度搜索，复杂局面卡 15 秒被投诉"AI卡死"，改迭代加深 + 3 秒时限后体验完全流畅。
- **偶数深度陷阱**：搜索深度为偶数时（2、4、6），最后一层是 Min 层（对手下），AI 倾向保守；奇数深度（3、5、7）最后一层是 Max 层（自己下），AI 倾向激进。表现为 AI 时而贪时而怂。解决方案：固定用奇数深度，或在评估函数里补偿一层视角差异。

### 🔗 相关问题

1. 蒙特卡洛树搜索（MCTS）和 Minimax 的根本区别是什么？为什么围棋（AlphaGo）用 MCTS 而国际象棋（Stockfish）用 Alpha-Beta？评估函数难以设计的博弈（如星际争霸）该用哪种？
2. 卡牌游戏（炉石/杀戮尖塔）的 AI 比棋牌难在哪？隐藏信息（对手手牌未知）和随机性（抽牌）如何影响 Minimax 的建模？是否需要用 Expectimax（期望最大值）替代 Minimax？
3. 实时游戏（MOBA/RTS）的 AI 为什么很少用博弈树搜索？单位数量大、连续状态空间、实时决策时间窗（<50ms）这些约束下，应该用什么替代方案（行为树+效用系统+影响图）？
