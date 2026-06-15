---
title: "Cocos Creator 中 SpriteAtlas 图集的作用与优化策略是什么？"
category: "cocos"
level: 2
tags: ["图集", "SpriteAtlas", "性能优化", "资源管理"]
related: ["cocos/drawcall-optimization", "cocos/texture-compression-strategy"]
hint: "图集不只是把图片拼在一起，它还直接影响 DrawCall 数量和内存布局。"
---

## 参考答案

### ✅ 核心要点

1. **图集本质** → 多张碎图合并为一张大图，减少纹理切换开销
2. **DrawCall 合并** → 同一图集的 Sprite 如果渲染状态一致，可被自动合批
3. **Auto Atlas vs 手动图集** → 3.x 支持 Auto Atlas 自动打包，也支持手动 TexturePacker 导入
4. **内存与包体** → 图集减少纹理间隙浪费，但过大图集会增加单张纹理内存峰值
5. **动态加载** → 图集作为 Asset 加载后需通过 `getSpriteFrame()` 获取子图

### 📖 深度展开

#### 图集对 DrawCall 的影响

Cocos 的合批（Batch）核心条件之一是**材质（纹理）相同**。没有图集时，每个独立纹理的 Sprite 都可能打断合批：

```
无图集：
  SpriteA (tex1) → DrawCall 1
  SpriteB (tex2) → DrawCall 2  ← 纹理切换，无法合批
  SpriteC (tex1) → DrawCall 3  ← 回到 tex1，但中间被 tex2 打断

有图集（tex1+tex2 → atlas）：
  SpriteA (atlas) → DrawCall 1
  SpriteB (atlas) ┘ 合批
  SpriteC (atlas) ┘ 合批
  → 总计 DrawCall = 1
```

#### Auto Atlas 配置（3.x）

在资源管理器中创建 Auto Atlas，关键参数：

| 参数 | 说明 | 建议 |
|------|------|------|
| Max Width / Max Height | 单张图集最大尺寸 | 1024×1024 或 2048×2048 |
| Padding | 子图间距 | 推荐 2px，防止采样溢出 |
| Allow Rotation | 允许旋转子图 | 紧凑打包可开启，但 UV 需注意 |
| Force Squared | 强制正方形 | 便于 mipmaps 和纹理对齐 |
| Pack Algorithm | 打包算法 | Best Short Side 适合大多数场景 |

#### 代码：动态加载图集并获取 SpriteFrame

```typescript
import { resources, SpriteAtlas, Sprite, SpriteFrame } from 'cc';

// 加载图集资源
resources.load('textures/ui-atlas', SpriteAtlas, (err, atlas) => {
    if (err) {
        console.error('图集加载失败', err);
        return;
    }
    // 通过名字获取子 SpriteFrame
    const frame: SpriteFrame = atlas.getSpriteFrame('btn_close');
    sprite.spriteFrame = frame;
});

// 批量预加载图集中所有 SpriteFrame
preloadAtlasSprites(atlas: SpriteAtlas) {
    const frames = atlas.spriteFrames;
    frames.forEach(frame => {
        // 触发纹理上传 GPU
        frame.texture.getGfxTexture();
    });
}
```

#### 图集大小与内存的关系

```
图集尺寸       纹理内存 (RGBA8888)
512 × 512      ≈ 1 MB
1024 × 1024    ≈ 4 MB
2048 × 2048    ≈ 16 MB
4096 × 4096    ≈ 64 MB ← 移动端需谨慎
```

> ⚠️ 低端 Android 设备最大纹理尺寸可能只支持 4096，部分老旧设备仅 2048。建议图集不超过 2048×2048。

#### 图集规划最佳实践

```
按功能模块拆分图集：
├── ui-common        ← 通用按钮、图标（常驻内存）
├── ui-login         ← 登录界面专用（按需加载/释放）
├── ui-hall          ← 大厅界面
├── ui-battle        ← 战斗界面（可能需要独立图集）
└── effects-shared   ← 特效序列帧
```

### ⚡ 实战经验

- **不要把所有图塞进一张图集**：虽然 DrawCall 最少，但内存峰值爆炸。按 UI 模块或场景拆分，做到"加载即用，退出即释放"
- **九宫格图片不应放进图集**：九宫格（Sliced）Sprite 的中间区域会被拉伸，放进图集后边缘采样可能因 Padding 出现缝隙，建议独立处理
- **图集的 Release 要谨慎**：`resources.release('textures/ui-atlas')` 会释放整个图集，如果还有 Sprite 正在使用其中的 SpriteFrame，会导致渲染异常（粉红块或消失）
- **使用 DevTools 的 Texture 面板**检查图集打包效果，确认没有过多空白浪费

### 🔗 相关问题

- DrawCall 合批的具体条件有哪些？（渲染状态、顶点数限制）
- 纹理压缩格式如何与图集配合使用？
- 如何在运行时动态创建图集？
