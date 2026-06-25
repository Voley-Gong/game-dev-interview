---
title: "享元模式（Flyweight）在游戏中如何应用？如何实现万级同类型对象的内存优化？"
category: "architecture"
level: 3
tags: ["Flyweight", "享元模式", "设计模式", "内存优化", "GPU Instancing", "架构设计"]
related: ["architecture/object-pool-design-pattern", "architecture/data-oriented-design", "architecture/memory-allocation-strategy-architecture"]
hint: "一棵树占 2MB 内存，一万棵树不该占 20GB——享元模式把共享的「内在状态」抽出来复用，每棵树只存自己的坐标和缩放。"
---

## 参考答案

### ✅ 核心要点

1. **核心思想：分离内在状态（共享）与外在状态（各异）**：内在状态 = 所有实例相同的只读数据（网格、纹理、材质、动画帧），只创建一份；外在状态 = 每个实例独有的数据（坐标、旋转、血量、颜色），由调用方传入。一万棵同种树共享一份 Mesh+Texture，各自只存一个 `Vector3 position`。
2. **内存节省来自共享粒度**：一个角色模型 = Mesh(2MB) + Texture(4MB) + AnimationClip(1MB) = 7MB。1000 个同类敌人不共享 = 7GB；享元后 = 7MB + 1000×48B(外在状态) ≈ 7.05MB，节省 99.9%。
3. **Flyweight Factory 管理共享对象的生命周期**：工厂维护一个 `Dictionary<key, Flyweight>` 缓池，首次请求时创建，后续请求直接返回已有实例。引用计数决定何时卸载——不是每个实例销毁时卸载，而是所有引用归零时统一卸载。
4. **游戏中的天然享元：引擎已经做了很多**：Unity 的 Mesh/Texture/Material 共享（同资源引用同一份）、GPU Instancing（一个 DrawCall 渲染万个实例）、Sprite Atlas（图集共享纹理）、Addressables 的引用计数。理解享元模式有助于正确使用这些引擎特性。
5. **Flyweight ≠ Object Pool**：对象池复用的是"空壳对象"（分配/回收避免 GC），享元复用的是"内在数据"（多对象共享同一份数据）。两者经常配合使用：池里的每个对象引用同一个享元。

### 📖 深度展开

**内在状态 vs 外在状态分离：**

```
❌ 不用享元（每个敌人独立加载资源）：
  Enemy[0] → { Mesh:2MB, Texture:4MB, Anim:1MB, Pos:(0,0), Hp:100 }  ┐
  Enemy[1] → { Mesh:2MB, Texture:4MB, Anim:1MB, Pos:(5,0), Hp:80  }  ├ 7000MB!
  ...                                                                 │
  Enemy[999] → { Mesh:2MB, Texture:4MB, Anim:1MB, Pos:(9,9), Hp:60 } ┘

✅ 用享元（共享内在数据，外在状态各存各的）：
  EnemyFlyweight（共享，仅1份）：
    └─ { Mesh:2MB, Texture:4MB, Anim:1MB }  ← 7MB 总共

  EnemyInstance[0]   → { flyweightRef, Pos:(0,0), Hp:100 }  ┐
  EnemyInstance[1]   → { flyweightRef, Pos:(5,0), Hp:80  }  ├ 1000×48B ≈ 48KB
  ...                                                        │
  EnemyInstance[999] → { flyweightRef, Pos:(9,9), Hp:60 }   ┘
  总计 ≈ 7MB + 48KB
```

**Flyweight + Factory 核心实现：**

```csharp
// 1. 享元对象 —— 内在状态（只读、共享）
public class TreeFlyweight {
    public readonly Mesh Mesh;           // 内在：所有同类树共享
    public readonly Material Material;   // 内在：材质/纹理共享
    public readonly AnimationClip[] Anims;
    public int RefCount { get; private set; }  // 引用计数

    public TreeFlyweight(Mesh mesh, Material mat, AnimationClip[] anims) {
        Mesh = mesh; Material = mat; Anims = anims;
    }
    public void AddRef() => RefCount++;
    public bool Release() { RefCount--; return RefCount <= 0; }  // 归零时可卸载
}

// 2. 享元工厂 —— 管理共享对象的创建和缓存
public class TreeFlyweightFactory {
    private readonly Dictionary<string, TreeFlyweight> _pool = new();
    private readonly IAssetLoader _loader;  // AB/Addressables 加载器

    public TreeFlyweightFactory(IAssetLoader loader) { _loader = loader; }

    public TreeFlyweight Get(string treeType) {
        if (!_pool.TryGetValue(treeType, out var fw)) {
            // 首次请求：加载资源，创建享元
            var mesh = _loader.Load<Mesh>($"trees/{treeType}/model");
            var mat = _loader.Load<Material>($"trees/{treeType}/material");
            var anims = _loader.LoadAll<AnimationClip>($"trees/{treeType}/anim");
            fw = new TreeFlyweight(mesh, mat, anims);
            _pool[treeType] = fw;
        }
        fw.AddRef();
        return fw;
    }

    public void Release(string treeType) {
        if (_pool.TryGetValue(treeType, out var fw)) {
            if (fw.Release()) {       // 引用归零 → 卸载资源
                _loader.Unload(fw.Mesh);
                _loader.Unload(fw.Material);
                _pool.Remove(treeType);
            }
        }
    }
}

// 3. 外在状态 —— 每棵树独有，极轻量
public struct TreeInstance {  // struct 避免 GC，适合万级实例
    public TreeFlyweight Flyweight;  // 引用共享数据（指针大小）
    public Vector3 Position;         // 外在：坐标
    public float Scale;              // 外在：缩放
    public Quaternion Rotation;      // 外在：朝向
    public float Health;             // 外在：血量（如果树可被破坏）
}

// 4. 渲染时传入外在状态 —— Graphics.DrawMeshInstanced 一次画万个
public class ForestRenderer : MonoBehaviour {
    private TreeFlyweightFactory _factory;
    private List<TreeInstance> _trees = new();
    private Matrix4x4[] _matrices;  // 外在状态转成变换矩阵

    void Render() {
        // 按树类型分组，每种类型一个 DrawCall（GPU Instancing）
        var groups = _trees.GroupBy(t => t.Flyweight);
        foreach (var group in groups) {
            var fw = group.Key;
            var matrices = group.Select(t =>
                Matrix4x4.TRS(t.Position, t.Rotation, Vector3.one * t.Scale)
            ).ToArray();
            // 一个 DrawCall 渲染同类型的所有树
            Graphics.DrawMeshInstanced(fw.Mesh, 0, fw.Material, matrices);
        }
    }
}
```

**游戏中的享元应用场景：**

| 场景 | 内在状态（共享） | 外在状态（各异） | 收益 |
|------|-----------------|-----------------|------|
| 森林/植被 | Mesh + 材质 | 坐标 + 缩放 + 风力相位 | 10万棵树 → 1个DrawCall |
| 子弹/弹幕 | 弹道模型 + 粒子 | 坐标 + 速度 + 伤害值 | 万级弹幕不掉帧 |
| 瓦片地图 | Tile Sprite + 碰撞体 | 格子坐标 + 变体编号 | 地图只存索引数组 |
| UI 列表项 | 预制体 + 字体 + 图标 | 数据绑定值 + 选中状态 | 背包万格流畅滚动 |
| RPG 装备图标 | 图集 Sprite | 物品ID + 数量 + 品质 | 避免重复加载纹理 |

**Flyweight vs Object Pool vs GPU Instancing：**

| 维度 | Flyweight | Object Pool | GPU Instancing |
|------|-----------|-------------|----------------|
| 共享什么 | 内在数据（Mesh/Texture） | 空壳对象（避免GC） | 渲染命令（DrawCall） |
| 解决的问题 | 内存占用 | GC 压力 / 分配开销 | DrawCall 数量 |
| 配合使用 | ✅ 常与 Pool 配合 | ✅ Pool 引用 Flyweight | ✅ 渲染 Flyweight 数据 |
| 引擎层面 | AB/Addressables 引用计数 | 对象池管理器 | Graphics.DrawMeshInstanced |

### ⚡ 实战经验

- **享元的资源卸载必须用引用计数，不能靠 GC**：Unity 的 Mesh/Texture/AssetBundle 是非托管资源，GC 回收不了。共享资源的生命周期必须由 Flyweight Factory 的引用计数管理——所有引用者 Release 后才能 `Resources.UnloadAsset`，否则要么内存泄漏（忘了卸），要么粉色材质（提前卸了）。
- **外在状态尽量用 struct 而非 class**：万级实例如果外在状态是 class，每个实例都有堆分配，GC 扫描成本惊人。用 struct 数组（如 `NativeArray<TreeInstance>`）不仅避免 GC，还能配合 Burst/Job 做并行更新（和 ECS 的 Chunk 布局思路一致）。
- **GPU Instancing 是硬件级享元，但要材质兼容**：DrawMeshInstanced 要求所有实例用相同材质（可以用 MaterialPropertyBlock 微调颜色等参数）。如果不同树种的材质 Shader 不一样，无法合并成一个 DrawCall——提前规划 Shader 兼容性，或用 SRP Batcher 替代。
- **别对频繁变化的内在状态用享元**：内在状态的核心假设是"只读"。如果把可变的战斗属性（攻击力、移动速度）塞进享元，一个敌人改了属性所有同类敌人都变了——这是隐蔽的 bug 源。可变属性永远放外在状态。

### 🔗 相关问题

1. 享元模式和 Unity 的 GPU Instancing 是什么关系？MaterialPropertyBlock 如何在不打破合批的前提下实现每实例差异化渲染？
2. 在 ECS 架构中，SharedComponentData 天然就是享元模式的应用——它的分桶机制如何与 Chunk 布局协同工作？
3. 游戏中大量重复的特效粒子（如雨雪），如何结合 GPU Instancing 和 Compute Buffer 实现十万级粒子的零 DrawCall 开销？
