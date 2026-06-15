---
title: "Cocos Creator 中纹理压缩与多分辨率资源策略如何设计？"
category: "cocos"
level: 2
tags: ["纹理压缩", "性能优化", "资源管理", "多分辨率"]
related: ["cocos/screen-adaptation", "cocos/memory-management", "cocos/drawcall-optimization"]
hint: "不同平台 GPU 支持不同压缩格式，如何在包体、画质和性能之间取平衡？"
---

## 参考答案

### ✅ 核心要点

1. **压缩格式选型** → Android 用 ASTC（或 ETC2），iOS 用 ASTC（或 PVRTC），桌面端用 DXT/BC7
2. **Cocos 自动分发** → 引擎根据运行平台自动选择对应压缩纹理，无需手动判断
3. **多分辨率策略** → 通过 `folder` + `variant` 机制为不同设备提供不同分辨率资源
4. **包体控制** → 纹理占包体 60-80%，压缩纹理可减少 50-75% 显存占用
5. **品质验证** → 压缩后必须人肉检查色带、透明通道、法线贴图等易损场景

### 📖 深度展开

#### 纹理压缩格式对比

| 格式 | 平台 | 压缩率 | 品质 | 备注 |
|------|------|--------|------|------|
| ASTC 4×4 | Android/iOS | 8:1 | 优秀 | 推荐，现代设备首选 |
| ASTC 6×6 | Android/iOS | 18:1 | 良好 | 更高压缩率，UI 背景可用 |
| ETC2 | Android | 4:1 | 中等 | 兼容老设备（GLES 3.0+） |
| PVRTC 4bpp | iOS | 8:1 | 中等 | 旧 iOS 设备兼容 |
| DXT5 (BC3) | 桌面 | 4:1 | 良好 | Windows/Mac GPU |
| RGBA8888 | 全平台 | 1:1 | 最高 | 未压缩，仅调试用 |

#### Cocos Creator 中的配置

在资源 Inspector 中设置纹理压缩：

```
纹理资源 Inspector:
├── Format: Automatic (自动分发)
├── Platforms:
│   ├── Android: ASTC 4x4
│   ├── iOS: ASTC 4x4
│   ├── Mini Game (微信): RGB565 / RGBA4444
│   └── Web: JPEG (不透明) / PNG (透明)
├── Mipmaps: 仅 3D / 远景开启
└── Wrap Mode: Clamp (UI) / Repeat (地砖)
```

#### 多分辨率资源方案

```typescript
// config.ts — 定义多分辨率配置
export const RESOLUTION_VARIANTS = {
  high:   { scale: 2.0, maxTextureSize: 2048 },  // 旗舰机
  medium: { scale: 1.5, maxTextureSize: 1024 },  // 中端机
  low:    { scale: 1.0, maxTextureSize: 512 },   // 低端机
};

// 根据设备内存和屏幕选择资源档位
export function selectQualityTier(): keyof typeof RESOLUTION_VARIANTS {
  const mem = sys.getTotalBytes?.() ?? 4 * 1024 * 1024 * 1024; // 字节
  const screenWidth = view.getFrameSize().width;

  if (mem >= 6 * 1024 * 1024 * 1024 && screenWidth >= 2000) return 'high';
  if (mem >= 3 * 1024 * 1024 * 1024) return 'medium';
  return 'low';
}
```

#### 加载对应资源

```typescript
const tier = selectQualityTier();

// 方式一：根据档位加载不同 Bundle
await assetManager.loadBundle(`textures_${tier}`);
await assetManager.loadResources(`textures_${tier}/ui`);

// 方式二：使用 Cocos 的 variant 系统（3.x）
// 在编辑器中为同一资源设置多个 variant folder
// 引擎根据 deviceInfo 自动选择
```

#### 内存占用估算

```
未压缩 RGBA8888:
  2048×2048 纹理 = 2048×2048×4 = 16 MB (显存)

ASTC 4×4 (每像素 1 字节):
  2048×2048 纹理 = 2048×2048×1 = 4 MB (显存)

→ 一张图节省 12MB 显存，场景 50 张图节省 600MB
```

#### 各场景推荐配置

| 使用场景 | 推荐格式 | Mipmap | 理由 |
|---------|---------|--------|------|
| UI 图集 | ASTC 5×5 | ❌ | UI 不缩放，不需要 mipmap |
| 角色立绘 | ASTC 4×4 | ❌ | 需要较高品质 |
| 背景大图 | ASTC 6×6 | ❌ | 可接受轻微损失 |
| 3D 漫反射贴图 | ASTC 4×4 | ✅ | 远近都需要 |
| 3D 法线贴图 | ASTC 4×4 | ✅ | 压缩法线需测试品质 |
| 粒子贴图 | ASTC 6×6 | ❌ | 粒子有运动模糊，可低质量 |
| 光照贴图 | ASTC 6×6 | ❌ | 低频信息，高压缩可接受 |

### ⚡ 实战经验

- **ASTC 是现代首选但要看兼容性**：ASTC 需要 GLES 3.2+ / iOS 7+ (A8 芯片)，对于低端 Android 机器（2020 年前）可能不支持，必须保留 ETC2 作为 fallback；在微信小游戏环境中，ASTC 支持率更低，建议用 RGB565/RGBA4444 或 JPEG
- **UI 图集的纹理压缩要格外小心**：带文字的 UI 图用 ASTC 4×4（品质优先），纯色背景或装饰图可以用 ASTC 8×8（极致压缩）；UI 图集本身要做好 SpriteAtlas 合并，减少 DrawCall，然后再对合并后的图集做压缩
- **不要忘记测试透明通道**：PVRTC 压缩透明通道经常出现黑边/毛刺；ASTC 对透明通道处理更好，但仍需在真机上检查半透明边缘；如果只有 PVRTC 可用，考虑把 RGB 和 Alpha 分离到两张纹理
- **定期审计纹理内存**：使用 Xcode Instruments / Android Studio Profiler 检查实际显存占用；开发阶段对每张超过 1024×1024 的纹理都设置压缩，防止美术误传未压缩的 PSD/PNG 直接进包

### 🔗 相关问题

- 微信小游戏有 4MB/50MB 的子包限制，纹理压缩策略如何配合分包方案？
- 如何在 Cocos 中实现运行时根据设备性能动态切换资源品质档位（动态降级）？
