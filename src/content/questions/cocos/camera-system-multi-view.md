---
title: "Cocos Creator 3.x Camera 系统深度解析：多相机、渲染目标与分屏如何实现？"
category: "cocos"
level: 3
tags: ["Camera", "多相机渲染", "RenderTexture", "分屏", "引擎原理"]
related: ["cocos/render-pipeline", "cocos/ui-system", "cocos/drawcall-optimization"]
hint: "一个场景可以有多个 Camera 吗？Camera 的 visibility flag 如何控制渲染范围？RenderTexture 怎么实现小地图和镜面效果？"
---

## 参考答案

### ✅ 核心要点

1. **Camera 是渲染入口**：每个 Camera 独立执行一次渲染流程（Cull → Sort → Draw），多个 Camera 意味着多次完整渲染
2. **Visibility Flag 机制**：Camera 通过 `visibility` 属性与节点的 `layer` 做 AND 运算，决定哪些节点被该相机渲染
3. **Camera 的 Priority**：`priority` 值越小越先渲染，后渲染的覆盖在上方（类似 z-order）
4. **RenderTexture**：将相机输出渲染到纹理而非屏幕，可实现小地图、后视镜、传送门等效果
5. **分屏与画中画**：通过设置 Camera 的 `viewport`（归一化视口）实现分屏，或多 Camera + 不同 RenderTexture 实现画中画

### 📖 深度展开

#### Camera 核心属性全景

```
Camera 组件
    │
    ├── Projection（投影模式）
    │     ├── Perspective（透视）：有近大远小效果，用于 3D 场景
    │     └── Ortho（正交）：无透视变形，用于 2D / UI
    │
    ├── Visibility（可见性控制）
    │     ├── visibility: number（位掩码）
    │     ├── 与 Node.layer 做 AND 运算
    │     └── 默认: Layers.Enum.DEFAULT | Layers.Enum.UI_3D
    │
    ├── Priority（渲染优先级）
    │     ├── 数值越小越先渲染
    │     ├── 主相机通常为 0，UI 相机为 1
    │     └── ClearFlag 决定是否清除上一相机画面
    │
    ├── Target（渲染目标）
    │     ├── screen（默认）→ 直接上屏
    │     └── RenderTexture → 渲染到纹理
    │
    └── Viewport（视口区域）
          ├── 归一化坐标 (x, y, w, h)，范围 0~1
          └── 控制画面在屏幕 / RT 上的位置和大小
```

#### 多 Camera 场景与 Visibility 分层

```typescript
import { Camera, Layers, Node } from 'cc';

// 3.x 中 Layers 默认定义（位掩码）
// Layers.Enum.DEFAULT  = 1 << 0  → 1
// Layers.Enum.UI_2D    = 1 << 1  → 2
// Layers.Enum.UI_3D    = 1 << 2  → 4
// Layers.Enum.GIZMOS   = 1 << 3  → 8
// 可自定义: Layers.Enum.CUSTOM_1 = 1 << 20

// 场景：主相机渲染游戏世界，UI 相机只渲染 UI
const mainCamera = mainCameraNode.getComponent(Camera)!;
mainCamera.visibility = Layers.Enum.DEFAULT;       // 只渲染默认层
mainCamera.priority = 1;                            // 先渲染世界
mainCamera.clearFlags = Camera.ClearFlag.ALL;       // 清除颜色+深度

const uiCamera = uiCameraNode.getComponent(Camera)!;
uiCamera.visibility = Layers.Enum.UI_2D;           // 只渲染 UI 层
uiCamera.priority = 2;                              // 后渲染 UI（覆盖在上面）
uiCamera.clearFlags = Camera.ClearFlag.DEPTH;       // 只清除深度，保留颜色
uiCamera.projection = Camera.ProjectionType.ORTHO;  // 正交投影

// 设置节点到指定层
enemyNode.layer = Layers.Enum.DEFAULT;              // 主相机可见
uiButton.layer = Layers.Enum.UI_2D;                 // UI 相机可见
miniMapIcon.layer = 1 << 10;                        // 自定义层，只有小地图相机可见
```

#### RenderTexture 实现小地图

```typescript
import { Camera, RenderTexture, Sprite, SpriteFrame } from 'cc';

// 1. 创建 RenderTexture
const rt = new RenderTexture();
rt.reset({
    width: 256,
    height: 256,
    format: Texture2D.PixelFormat.RGBA8888,
});
// 可选：设置采样参数
rt.setMipFilter(Sampler.FilterPoint);

// 2. 将小地图相机输出到 RT
const minimapCam = minimapNode.getComponent(Camera)!;
minimapCam.targetTexture = rt;
minimapCam.visibility = 1 << 10;       // 只渲染 miniMapIcon 层
minimapCam.orthoHeight = 50;           // 正交高度，控制小地图覆盖范围
minimapCam.clearFlags = Camera.ClearFlag.ALL;

// 3. 将 RT 显示到 UI Sprite 上
const sprite = minimapDisplay.getComponent(Sprite)!;
const spriteFrame = new SpriteFrame();
spriteFrame.texture = rt;
sprite.spriteFrame = spriteFrame;

// 4. 设置小地图图标节点的 layer
for (const icon of mapIcons) {
    icon.layer = 1 << 10;  // 与小地图相机 visibility 匹配
}
```

#### 分屏实现方案

```typescript
// 双人分屏：左半屏 Player1，右半屏 Player2
const cam1 = player1Camera.getComponent(Camera)!;
cam1.viewport = new Rect(0, 0, 0.5, 1);     // 左半屏
cam1.priority = 1;
cam1.clearFlags = Camera.ClearFlag.ALL;

const cam2 = player2Camera.getComponent(Camera)!;
cam2.viewport = new Rect(0.5, 0, 0.5, 1);   // 右半屏
cam2.priority = 2;
cam2.clearFlags = Camera.ClearFlag.ALL;
```

#### 多 Camera 方案对比

| 方案 | DrawCall | 适用场景 | 优点 | 缺点 |
|------|---------|---------|------|------|
| 单 Camera + 多 Layer | 1x | 简单 2D / 3D | 性能最优 | 无法独立后处理 |
| 双 Camera（世界 + UI） | ≈2x | 标准游戏 | UI 不受世界后处理影响 | 多一次渲染开销 |
| RT Camera（小地图） | +1x | 小地图、监视器 | 灵活独立视角 | RT 内存 + 额外 DrawCall |
| 分屏 Camera | Nx | 双人同屏 | 各自独立视角 | 渲染开销成倍增加 |
| 后处理 Camera | +1x | 全屏滤镜、Bloom | 视觉效果好 | 额外 GPU 开销 |

> ⚠️ 经验法则：手机平台同时存在的 Camera 数量尽量 **不超过 3 个**（世界 + UI + 可选 RT）。

#### Camera 事件与屏幕坐标转换

```typescript
// Camera 的屏幕坐标 ↔ 世界坐标转换（3.x 写法）
const worldPos = new Vec3();
camera.screenToWorld(new Vec3(screenX, screenY, 0), worldPos);

// 世界坐标 → 屏幕坐标（用于血条跟随）
const screenPos = camera.worldToScreen(worldPos);
uiNode.setPosition(screenPos.x, screenPos.y);

// 注意：3D 场景中还需要考虑 Z 深度
// 用 raycast 确定屏幕点击对应的 3D 位置
const ray = new geometry.Ray();
camera.screenPointToRay(screenX, screenY, ray);
// 然后用 PhysicsSystem.instance.raycast(ray) 做碰撞检测
```

### ⚡ 实战经验

1. **多 Camera 是双刃剑**：每多一个 Camera 就多一轮完整的渲染提交（Cull + Sort + Draw），在中端手机上额外 Camera 可能增加 2-5ms 帧时间。能用 Layer + 单 Camera 解决的就别加 Camera
2. **RenderTexture 的分辨率别贪大**：小地图 256×256 足够，角色头像 RT 用 128×128。RT 分辨率直接影响显存占用和像素填充率开销。一个 1024×1024 的 RGBA RT 占用 4MB 显存
3. **Camera 的 clearFlags 容易踩坑**：如果第二个 Camera 设了 `ClearFlag.ALL`，它会把第一个 Camera 的画面也清掉。后渲染的 Camera 通常应设为 `ClearFlag.DEPTH`（只清深度缓冲）
4. **分屏时 UI 层处理**：分屏游戏如果 UI 也要分区域显示，用第三个 Ortho Camera 只渲染 UI 层并覆盖全屏，避免 UI 也被分屏裁剪

### 🔗 相关问题

- Cocos Creator 3.x 的 Camera 和 2.x 的 Camera 有什么本质区别？
- 如何实现相机震动效果（Camera Shake）？
- RenderTexture 如何实现镜面反射 / 传送门效果？
