---
title: "Cocos Creator TiledMap 地图系统原理与优化策略是什么？"
category: "cocos"
level: 2
tags: ["TiledMap", "瓦片地图", "性能优化", "内存管理"]
related: ["cocos/drawcall-optimization", "cocos/memory-management"]
hint: "TiledMap 地图很大、瓦片很多，渲染和内存同时吃紧——怎么破？"
---

## 参考答案

### ✅ 核心要点

1. **TiledMap 渲染本质**：将 Tiled 编辑器导出的 TMX 文件解析为多个 `TiledLayer`，每层通过动态生成 Mesh 合并瓦片渲染
2. **DrawCall 优化**：同一图集的同一层瓦片会自动合批，但不同图集或渲染顺序被打断会产生新 DrawCall
3. **内存核心矛盾**：大地图的 TMX 文件本身不大，但加载的 Tileset 贴图和生成的 Mesh 数据可能占大量内存
4. **分块加载（Chunk Loading）**：超大地图需要按视口可见区域动态加载/卸载瓦片块
5. **碰撞与寻路**：TiledMap 的 Object 层可导出碰撞区域，配合 A* 寻路实现 RPG 地图行走

### 📖 深度展开

#### TMX 文件结构解析

```
map.tmx (XML 格式)
├── <map> 属性：宽高、瓦片大小、渲染方向（正交/等距/六边形）
├── <tileset> 图集信息：引用的图片、瓦片切割规格
├── <layer> 瓦片层：GID 数组（每个位置的瓦片 ID）
├── <objectgroup> 对象层：碰撞体、触发器、出生点
└── <imagelayer> 图片层：背景远景图
```

Cocos Creator 通过 `tiled-map` 组件加载 TMX：

```typescript
import { _decorator, Component, resources, TiledMap } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('MapLoader')
export class MapLoader extends Component {
    @property(TiledMap)
    tiledMap: TiledMap = null!;

    onLoad() {
        resources.load('maps/level_01', TiledMapAsset, (err, asset) => {
            if (err) return;
            this.tiledMap.mapAsset = asset;

            // 获取特定层
            const groundLayer = this.tiledMap.getLayer('ground');
            const obstacleLayer = this.tiledMap.getLayer('obstacles');

            // 读取某个位置的 GID
            const gid = groundLayer.getTileGIDAt(10, 15);

            // 设置瓦片（运行时修改地图）
            groundLayer.setTileGIDAt(200, 10, 15);
        });
    }
}
```

#### 性能瓶颈分析

| 瓶颈点 | 原因 | 典型表现 |
|--------|------|---------|
| DrawCall 过多 | 多个 Layer 各自独立渲染，Object 层打乱合批 | 50x50 地图 5 个 Layer = 5+ DrawCall |
| Mesh 重建 | 运行时频繁 `setTileGIDAt` 触发层 Mesh 重算 | 修改瓦片时卡顿 |
| 内存占用大 | 大地图 Tileset 贴图一次性全加载 | 100x100 地图 + 2048 贴图 ≈ 20MB+ |
| 首帧加载慢 | TMX 解析 + Mesh 构建在主线程同步执行 | 进入地图时 0.5~2s 卡顿 |

#### 分块加载方案

对于超大地图（如开放世界），将整张地图划分为 Chunk，只加载相机附近的块：

```typescript
import { _decorator, Component, Vec2, TiledMap, TiledLayer, Node } from 'cc';
const { ccclass, property } = _decorator;

interface ChunkData {
    x: number;
    y: number;
    gids: number[][];
}

@ccclass('ChunkedTiledMap')
export class ChunkedTiledMap extends Component {
    @property(TiledMap)
    tiledMap: TiledMap = null!;

    @property
    chunkSize: number = 16; // 每个 Chunk 16x16 瓦片

    @property
    viewRadius: number = 2;  // 可见半径（Chunk 数）

    private _loadedChunks: Map<string, ChunkData> = new Map();
    private _allChunks: Map<string, ChunkData> = new Map();
    private _tileLayer: TiledLayer = null!;

    // 从完整 TMX 数据中预提取所有 Chunk 数据
    preloadChunks(mapAsset: TiledMapAsset) {
        // 解析 mapAsset，按 chunkSize 分割 GID 数据到 _allChunks
        // 实际项目中可离线预处理为 JSON 文件
    }

    updateChunks(centerTileX: number, centerTileY: number) {
        const centerChunkX = Math.floor(centerTileX / this.chunkSize);
        const centerChunkY = Math.floor(centerTileY / this.chunkSize);

        // 计算需要加载的 Chunk 范围
        const visibleKeys = new Set<string>();
        for (let dy = -this.viewRadius; dy <= this.viewRadius; dy++) {
            for (let dx = -this.viewRadius; dx <= this.viewRadius; dx++) {
                const cx = centerChunkX + dx;
                const cy = centerChunkY + dy;
                const key = `${cx},${cy}`;
                visibleKeys.add(key);

                if (!this._loadedChunks.has(key) && this._allChunks.has(key)) {
                    this.loadChunk(cx, cy);
                }
            }
        }

        // 卸载不可见的 Chunk
        this._loadedChunks.forEach((data, key) => {
            if (!visibleKeys.has(key)) {
                this.unloadChunk(data);
                this._loadedChunks.delete(key);
            }
        });
    }

    private loadChunk(cx: number, cy: number) {
        const key = `${cx},${cy}`;
        const data = this._allChunks.get(key);
        if (!data) return;

        const baseX = cx * this.chunkSize;
        const baseY = cy * this.chunkSize;

        for (let y = 0; y < data.gids.length; y++) {
            for (let x = 0; x < data.gids[y].length; x++) {
                if (data.gids[y][x] > 0) {
                    this._tileLayer.setTileGIDAt(data.gids[y][x], baseX + x, baseY + y);
                }
            }
        }
        this._loadedChunks.set(key, data);
    }

    private unloadChunk(data: ChunkData) {
        const baseX = data.x * this.chunkSize;
        const baseY = data.y * this.chunkSize;
        for (let y = 0; y < data.gids.length; y++) {
            for (let x = 0; x < data.gids[y].length; x++) {
                this._tileLayer.setTileGIDAt(0, baseX + x, baseY + y); // 0 = 清除
            }
        }
    }
}
```

#### 等距地图（Isometric）深度排序

等距地图的瓦片需要按"从后到前"的顺序渲染，否则会出现遮挡错误：

```
等距坐标转换：
  屏幕坐标 = (tileX - tileY) * tileWidth/2, (tileX + tileY) * tileHeight/2
  瓦片坐标 =反向计算
```

Cocos 内部已处理渲染排序，但自定义高度（如多层建筑）需要手动设置节点的 `priority` 或 `zIndex`。

### ⚡ 实战经验

1. **`setTileGIDAt` 是性能黑洞**：每次调用都会标记 Layer 的 Mesh 为脏，批量修改时先收集所有修改点，再用 `beginUpdate()` / `endUpdate()` 包裹（如果引擎版本支持），或减少修改频率
2. **Tileset 贴图尺寸**：移动平台单张贴图不宜超过 2048x2048，多套图集应合并到统一图集减少 DrawCall
3. **碰撞体不要用 TiledMap 渲染层做**：在 Object 层定义碰撞多边形，运行时用物理引擎的 `PhysicsBoxCollider` 或自定义 A* 网格，而非每帧遍历瓦片 GID 判断可通行性
4. **TMX 文件压缩**：Tiled 支持 zlib/gzip 压缩存储 GID 数据，加载时解压开销很小，但文件体积可减少 60%+

### 🔗 相关问题

- 如何实现 TiledMap 的 A* 寻路与动态障碍物规避？
- Cocos Creator 的 `Graphics` 组件能否替代 TiledMap 实现矢量瓦片？
- 大世界地图（如无尽跑酷）如何实现无限滚动与瓦片复用？
