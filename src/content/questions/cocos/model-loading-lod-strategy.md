---
title: "Cocos Creator 3D 模型加载与 LOD 策略如何实现？"
category: "cocos"
level: 3
tags: ["3D模型", "LOD", "性能优化", "MeshRenderer"]
related: ["cocos/gpu-instancing-batch-rendering", "cocos/memory-management"]
hint: "同屏上百个 3D 模型，远处的模型有必要用高精度 Mesh 吗？"
---

## 参考答案

### ✅ 核心要点

1. **模型加载链路**：`assetManager.load` → 解析 glTF/prefab → 创建 MeshRenderer + Material + Mesh 资源
2. **LOD（Level of Detail）本质**：根据相机距离切换不同精度的 Mesh，近处高精度、远处低精度
3. **Cocos 3.x 原生 LOD 支持**：`LODGroup` 组件管理多个 LOD 级别，自动计算屏幕占比选择最优 Mesh
4. **内存释放策略**：模型资源包含 Mesh + Material + Texture，必须统一释放避免内存泄漏
5. **Instancing 补充**：相同模型的多个实例应配合 GPU Instancing 进一步减少 DrawCall

### 📖 深度展开

#### 模型加载完整流程

```
assetManager.load('models/hero', Prefab)
  ↓ 反序列化
解析 JSON / glTF 数据
  ↓ 资源依赖收集
Mesh 资源 ← Material 资源 ← Texture 资源
  ↓ 实例化
Node(Prefab) + MeshRenderer + AnimationController
  ↓ 提交渲染
DrawCall
```

```typescript
import { _decorator, Component, assetManager, Prefab, instantiate, Node, MeshRenderer } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('ModelLoader')
export class ModelLoader extends Component {
    @property(Node)
    container: Node = null!;

    private _loadedAssets: Prefab[] = [];

    loadHeroModel(modelPath: string) {
        assetManager.loadResources(modelPath, Prefab, (err, prefab) => {
            if (err) {
                console.error(`模型加载失败: ${modelPath}`, err);
                return;
            }
            const node = instantiate(prefab);
            node.parent = this.container;
            this._loadedAssets.push(prefab);

            // 获取 MeshRenderer 检查模型信息
            const renderer = node.getComponent(MeshRenderer);
            if (renderer) {
                const mesh = renderer.mesh;
                console.log(`顶点数: ${mesh?.info.vertCount}, 三角面数: ${mesh?.info triCount}`);
            }
        });
    }

    // 场景切换时释放所有模型资源
    releaseAll() {
        this._loadedAssets.forEach(prefab => {
            assetManager.release(prefab);
        });
        this._loadedAssets = [];
    }
}
```

#### LOD 实现方案

**方案一：Cocos 原生 LODGroup**

```typescript
import { _decorator, Component, LODGroup, MeshRenderer, Node } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('ModelLODSetup')
export class ModelLODSetup extends Component {
    onLoad() {
        // 确保节点上有 LODGroup 组件
        let lodGroup = this.getComponent(LODGroup);
        if (!lodGroup) {
            lodGroup = this.addComponent(LODGroup);
        }

        // LOD 数据通常在编辑器中配置
        // 这里展示运行时配置方式
        const lods = [
            { screenRatio: 0.8, mesh: highPolyMesh },  // 近距离：高精度
            { screenRatio: 0.3, mesh: midPolyMesh },   // 中距离：中精度
            { screenRatio: 0.05, mesh: lowPolyMesh },  // 远距离：低精度
        ];

        // LODGroup 会自动根据相机距离和屏幕占比选择
    }
}
```

**方案二：手动距离判断（无 LODGroup 时）**

```typescript
import { _decorator, Component, Vec3, Camera, Mesh, MeshRenderer } from 'cc';
const { ccclass, property } = _decorator;

interface LODLevel {
    distance: number;
    mesh: Mesh;
}

@ccclass('ManualLOD')
export class ManualLOD extends Component {
    @property(Camera)
    mainCamera: Camera = null!;

    @property(MeshRenderer)
    meshRenderer: MeshRenderer = null!;

    @property([Mesh])
    lodMeshes: Mesh[] = [];

    private _lodLevels: LODLevel[] = [];
    private _currentLOD: number = -1;

    start() {
        // 配置 LOD 级别和切换距离
        this._lodLevels = [
            { distance: 0, mesh: this.lodMeshes[0] },    // 0~10m
            { distance: 10, mesh: this.lodMeshes[1] },   // 10~30m
            { distance: 30, mesh: this.lodMeshes[2] },   // 30~80m
            { distance: 80, mesh: this.lodMeshes[3] },   // 80m+
        ];
    }

    update() {
        const modelPos = this.node.worldPosition;
        const camPos = this.mainCamera.node.worldPosition;
        const dist = Vec3.distance(modelPos, camPos);

        let targetLOD = this._lodLevels.length - 1;
        for (let i = this._lodLevels.length - 1; i >= 0; i--) {
            if (dist < this._lodLevels[i].distance) {
                targetLOD = i;
            }
        }

        // 加入迟滞区（Hysteresis）避免在边界来回闪烁
        if (targetLOD !== this._currentLOD) {
            if (Math.abs(targetLOD - this._currentLOD) > 1 ||
                !this._isInHysteresisZone(dist, targetLOD)) {
                this._currentLOD = targetLOD;
                this.meshRenderer.mesh = this._lodLevels[targetLOD].mesh;
            }
        }
    }

    private _isInHysteresisZone(dist: number, lodIndex: number): boolean {
        if (lodIndex >= this._lodLevels.length - 1) return false;
        const threshold = this._lodLevels[lodIndex + 1].distance;
        const hysteresis = 1.5; // 1.5m 迟滞区
        return Math.abs(dist - threshold) < hysteresis;
    }
}
```

#### LOD 精度制作建议

| LOD 级别 | 三角面数（参考） | 适用距离 | 贴图分辨率 |
|---------|----------------|---------|-----------|
| LOD0 | 8,000 ~ 20,000 | 0 ~ 10m | 1024 / 2048 |
| LOD1 | 3,000 ~ 8,000 | 10 ~ 30m | 512 |
| LOD2 | 500 ~ 2,000 | 30 ~ 80m | 256 |
| LOD3 ( impostor) | 50 ~ 200 | 80m+ | 128 |

#### 模型 LOD 与 GPU Instancing 配合

```typescript
// 当大量相同模型远距离出现时
// LOD 切到最低精度 + 开启 Instancing = 最优渲染
const renderer = node.getComponent(MeshRenderer);
if (renderer) {
    // 确保使用支持 Instancing 的材质
    const mat = renderer.sharedMaterial;
    mat.passes.forEach(pass => {
        pass.setDynamicBatching(true); // 启用动态合批
    });
}
```

#### Impostor（广告牌）替代方案

超远距离的模型可以直接用面片+预渲染贴图替代：

```
渲染策略：
  近（0~30m）: LOD0/LOD1 真实 Mesh
  中（30~80m）: LOD2 低精度 Mesh
  远（80m+）:   Impostor（一张带模型截图的面片，随相机朝向旋转）
```

```typescript
// 简化版 Impostor：用 Sprite 面片替代 3D 模型
import { _decorator, Component, Sprite, SpriteFrame, Camera, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('ImpostorSwitch')
export class ImpostorSwitch extends Component {
    @property(Camera)
    camera: Camera = null!;

    @property(Sprite)
    impostorSprite: Sprite = null!;

    @property(Node)
    modelNode: Node = null!;

    @property
    switchDistance: number = 80;

    update() {
        const dist = Vec3.distance(this.node.worldPosition, this.camera.node.worldPosition);
        const useImpostor = dist > this.switchDistance;

        this.modelNode.active = !useImpostor;
        this.impostorSprite.node.active = useImpostor;

        if (useImpostor) {
            // 面片朝向相机
            this.impostorSprite.node.lookAt(this.camera.node.worldPosition);
        }
    }
}
```

### ⚡ 实战经验

1. **LOD 切换闪烁问题**：切换 Mesh 时会短暂出现"弹出"感（Pop-in）。解决方案：使用 Hysteresis 迟滞区 + 渐变过渡（新 Mesh 淡入），或使用 Geomorphing（几何变形）平滑过渡
2. **glTF 与原生模型格式**：Cocos 3.x 推荐 glTF 格式（`.glb`/`.gltf`），它支持 Mesh + Material + Animation + Skin 一体化。FBX 需要编辑器导入转换
3. **内存分水岭**：iOS 小游戏内存限制约 200MB，10 个 10 万面模型 + 1024 贴图就可能触顶。移动端严格控制单模型面数 ≤ 5000（主角除外），批量小怪用 LOD2 精度
4. **资源释放陷阱**：`instantiate(prefab)` 创建的节点销毁后，`prefab` 及其依赖的 Mesh/Texture 仍驻留内存。必须调用 `assetManager.release(prefab)` 显式释放，或使用 `assetManager.load` 时设置 `preset: 'scene'` 让引擎在场景切换时自动回收

### 🔗 相关问题

- GPU Instancing 与 LOD 如何协同工作？什么情况下两者会冲突？
- 如何实现 Geomorphing（几何变形）过渡来消除 LOD 切换闪烁？
- Cocos Creator 3.x 的 Mesh 数据结构（vertex buffer / index buffer）如何影响性能？
