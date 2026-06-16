---
title: "Cocos Creator 3.x 空间分割与视锥剔除：大面积场景如何减少渲染开销？"
category: "cocos"
level: 3
tags: ["空间分割", "视锥剔除", "遮挡剔除", "性能优化", "场景管理"]
related: ["cocos/render-pipeline", "cocos/scene-management", "cocos/gpu-instancing-batch-rendering"]
hint: "场景里有上万个物体，每帧只渲染几百个——引擎是怎么做到的？"
---

## 参考答案

### ✅ 核心要点

1. **视锥剔除（Frustum Culling）**：根据相机视锥体剔除范围外的物体，不做渲染提交
2. **空间分割（Spatial Partitioning）**：BVH / Octree / Quadtree 加速剔除判定，避免逐物体遍历
3. **遮挡剔除（Occlusion Culling）**：被前景物体完全遮挡的后景不渲染（Cocos 暂无内置，需自定义实现）
4. **距离剔除（Distance Culling）**：基于距离的 LOD 替代或直接隐藏
5. **层级合并与批次**：剔除后对幸存物体做合批，减少 DrawCall

### 📖 深度展开

#### 剔除管线的完整流程

```
场景中全部物体（可能数万）
  ↓ 视锥剔除 Frustum Culling
  → 只保留相机视野内的（通常数百~数千）
  ↓ 遮挡剔除 Occlusion Culling（可选）
  → 去掉被前景完全遮挡的
  ↓ 距离/LOD 剔除
  → 远处替换为简化模型或直接隐藏
  ↓ 排序 + 合批
  → 最终 DrawCall（几十~上百）
```

#### BVH（Bounding Volume Hierarchy）加速结构

Cocos Creator 3.x 内部使用 **BVH 树** 来加速视锥剔除：

```
              [Root AABB]
             /            \
      [Sub-AABB]        [Sub-AABB]
      /    |    \        /       \
   Leaf  Leaf  Leaf   Leaf      Leaf

每个叶子节点 = 一个渲染组件的包围盒
每个内部节点 = 子节点包围盒的并集

视锥测试时：
  - 从 Root 开始做 AABB vs Frustum 测试
  - 完全在外 → 整棵子树跳过（O(1) 剪掉大量物体）
  - 完全在内 → 整棵子树全部通过
  - 相交 → 递归子节点继续判定
```

**时间复杂度对比：**

| 方法 | 剔除判定复杂度 | 适用场景 |
|------|--------------|---------|
| 逐物体遍历 | O(N) | 物体少（<200） |
| BVH 树 | O(log N) | 通用3D场景 |
| 八叉树 | O(log₈ N) | 均匀分布的3D空间 |
| 四叉树 | O(log₄ N) | 俯视角/2D/地形 |
| 网格哈希 | O(1) 查找 | 规则网格分布 |

#### 手动实现八叉树场景管理

```typescript
class OctreeNode {
  bounds: AABB;
  children: OctreeNode[] = [];
  objects: Renderable[] = [];
  maxDepth: number;
  depth: number;

  insert(obj: Renderable): boolean {
    if (!this.bounds.contains(obj.aabb)) return false;

    if (this.depth >= this.maxDepth || this.isLeaf()) {
      this.objects.push(obj);
      // 超过容量则分裂
      if (this.objects.length > 8 && this.depth < this.maxDepth) {
        this.split();
      }
      return true;
    }

    for (const child of this.children) {
      if (child.insert(obj)) return true;
    }

    this.objects.push(obj); // 放在当前层
    return true;
  }

  private split() {
    const { center } = this.bounds;
    for (let i = 0; i < 8; i++) {
      const newBounds = this.bounds.subdivide(i);
      const child = new OctreeNode();
      child.bounds = newBounds;
      child.depth = this.depth + 1;
      child.maxDepth = this.maxDepth;
      this.children.push(child);
    }
    // 把已有物体重新分配到子节点
    const oldObjects = this.objects;
    this.objects = [];
    for (const obj of oldObjects) {
      let inserted = false;
      for (const child of this.children) {
        if (child.insert(obj)) { inserted = true; break; }
      }
      if (!inserted) this.objects.push(obj);
    }
  }

  cull(frustum: Frustum, result: Renderable[]) {
    const state = frustum.containsAABB(this.bounds);
    if (state === Containment.OUTSIDE) return;       // 整棵树跳过
    if (state === Containment.INSIDE) {
      result.push(...this.collectAll());               // 全部通过
      return;
    }
    // 相交：逐物体判定 + 递归子节点
    for (const obj of this.objects) {
      if (frustum.containsAABB(obj.aabb) !== Containment.OUTSIDE) {
        result.push(obj);
      }
    }
    for (const child of this.children) {
      child.cull(frustum, result);
    }
  }
}
```

#### 距离剔除 + LOD 联动策略

```typescript
/** 基于距离的分段渲染策略 */
const renderStrategy = [
  { maxDist: 30,  lod: 0, visible: true  },  // 近：高精度
  { maxDist: 80,  lod: 1, visible: true  },  // 中：中精度
  { maxDist: 150, lod: 2, visible: true  },  // 远：低精度
  { maxDist: Infinity, lod: -1, visible: false }, // 超远：隐藏
];

function updateEntityLOD(entity: Node, camPos: Vec3) {
  const dist = Vec3.distance(entity.position, camPos);
  const strategy = renderStrategy.find(s => dist <= s.maxDist)!;
  entity.active = strategy.visible;
  if (strategy.visible && strategy.lod >= 0) {
    entity.getComponent(ModelComponent).lodLevel = strategy.lod;
  }
}
```

#### 微信小游戏 / 移动端的剔除策略建议

```
移动端特性：
  - CPU 瓶颈比 GPU 更常见
  - JavaScript 侧遍历大量物体本身就有开销
  - DrawCall 提交次数对性能影响巨大

策略：
  1. 场景分区加载（只有当前区域物体在内存中）
  2. 粗粒度 BVH（减少 JS 遍历次数，牺牲精度）
  3. 大物体用网格简化代替多级 LOD
  4. 2D 游戏用四叉树而非八叉树（维度更低更快）
  5. 使用 Instancing 减少"幸存物体"的 DrawCall
```

### ⚡ 实战经验

1. **不要自己手写 BVH 替换引擎内置的**：Cocos 3.x 内部已经有了成熟的 BVH 加速结构，自己另写一套大概率性能更差且与渲染管线脱节，正确的做法是在逻辑层做场景分区管理
2. **2D 游戏也需要"剔除"思维**：超大的滚动地图（如塔防、横版过关），把屏幕外的节点 `active = false` 能显著减少组件 `update` 开销，虽然渲染层已经做了视锥剔除，但逻辑层的每帧 update 不会被自动跳过
3. **遮挡查询在小游戏平台不可用**：`gl.occlusionQuery` 在 WebGL2 才有，且微信小游戏支持有限，需要遮挡剔除时建议用"预计算的可见性集合"（PVS）方案
4. **LOD 切换时注意 pop-in 效果**：模型突然切换会有视觉跳变，可以加一个淡入淡出过渡或使用 GeoMorph 技术

### 🔗 相关问题

- 如何实现大世界的流式加载（Streaming World）？
- BVH 树在动态场景（物体频繁移动）下如何高效更新？
- GPU Instancing 和空间剔除如何协同工作？
