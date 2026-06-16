---
title: "Cocos Creator 序列帧动画怎么用才不卡？SpriteAnimation 与图集帧动画的性能优化"
category: "cocos"
level: 2
tags: ["序列帧动画", "性能优化", "图集", "内存管理"]
related: ["cocos/sprite-atlas-management", "cocos/drawcall-optimization", "cocos/memory-management"]
hint: "同一屏 50 个角色播放序列帧动画，瓶颈在哪里？图集大小、DrawCall 还是内存？"
---

## 参考答案

### ✅ 核心要点

1. **图集合并**：所有帧打到同一张图集，避免频繁切换纹理导致 DrawCall 上升
2. **内存控制**：图集尺寸 ≤ 2048×2048，超大图集拆分按角色/动作分组
3. **SpriteFrame 缓存**：预创建 SpriteFrame 数组，避免运行时反复 `resources.load`
4. **播放频率**：合理设置 `sample`（采样率），12~15 FPS 对于大多数 2D 游戏够用
5. **逐帧 vs 补间**：简单位移/缩放优先用 Tween，仅复杂形变用序列帧

### 📖 深度展开

#### 序列帧动画的两种实现方式

**方式一：AnimationClip + SpriteFrame（官方推荐）**

```typescript
import { AnimationClip, SpriteFrame, Sprite, animation } from 'cc';

// 动态构建 AnimationClip
function createFrameClip(
    frames: SpriteFrame[],
    fps: number = 15
): AnimationClip {
    const clip = new AnimationClip();
    clip.duration = frames.length / fps;
    clip.sample = fps;

    const track = new animation.ObjectTrack();
    track.path = new animation.TrackPath()
        .toComponent(Sprite)
        .toProperty('spriteFrame');

    const curve: animation.Channel<SpriteFrame> = track.channels();
    for (let i = 0; i < frames.length; i++) {
        curve.addKeyFrame(i / fps, frames[i]);
    }

    clip.addTrack(track);
    return clip;
}
```

**方式二：手动逐帧切换（精细控制）**

```typescript
const { _frames: SpriteFrame[], _fps: number } = config;
private _currentFrame = 0;
private _accumulator = 0;

update(deltaTime: number) {
    this._accumulator += deltaTime;
    const frameInterval = 1 / this._fps;

    while (this._accumulator >= frameInterval) {
        this._accumulator -= frameInterval;
        this._currentFrame = (this._currentFrame + 1) % this._frames.length;
        this.sprite.spriteFrame = this._frames[this._currentFrame];
    }
}
```

#### 性能瓶颈分析

| 瓶颈点 | 症状 | 原因 | 优化方案 |
|--------|------|------|----------|
| DrawCall 过高 | 帧率波动 | 角色图集未合并 | 合并到同一 SpriteAtlas |
| 内存峰值飙升 | 闪退/卡顿 | 全部帧一次性加载 | 分段加载，按场景分组 |
| GC 频繁 | 周期性掉帧 | 运行时创建临时对象 | 预创建 SpriteFrame 数组 |
| 渲染卡顿 | GPU 瓶颈 | 图集尺寸过大 | 限制 ≤ 2048，压缩格式 |

#### 图集规划策略

```
角色动作图集规划示例：
├── hero/
│   ├── hero_idle.plist/spriteFrame    （32帧，256×256 → 1024×2048）
│   ├── hero_run.plist/spriteFrame     （24帧）
│   ├── hero_attack.plist/spriteFrame  （18帧）
│   └── hero_skill.plist/spriteFrame   （12帧）
├── enemy_goblin/
│   ├── goblin_idle.plist
│   └── goblin_die.plist
└── effects/
    └── hit_flash.plist                （8帧，128×128）
```

**核心原则：** 同屏播放动画的角色图集尽量在同一张或少量几张图集上，最大化合批效率。

#### 内存分页加载

```typescript
/** 序列帧动画资源管理器 */
export class FrameAnimManager {
    private _loadedClips: Map<string, AnimationClip> = new Map();
    private _loadedAtlas: Map<string, SpriteAtlas> = new Map();

    /** 预加载某角色的全部动作 */
    async preloadCharacter(charId: string): Promise<void> {
        const atlas = await resources.load(
            `animations/${charId}/${charId}`,
            SpriteAtlas
        );
        this._loadedAtlas.set(charId, atlas);

        // 预提取所有 SpriteFrame
        const frameMap = new Map<string, SpriteFrame>();
        const sfNames = atlas.getSpriteFrameNames();
        for (const name of sfNames) {
            frameMap.set(name, atlas.getSpriteFrame(name));
        }
        this._frameCache.set(charId, frameMap);
    }

    /** 释放角色资源 */
    releaseCharacter(charId: string): void {
        const atlas = this._loadedAtlas.get(charId);
        if (atlas) {
            // 释放图集依赖的纹理
            const sf = atlas.getSpriteFrame(atlas.getSpriteFrameNames()[0]);
            if (sf?.texture) {
                sf.texture.destroy();
            }
            assetManager.releaseAsset(atlas);
            this._loadedAtlas.delete(charId);
        }
    }
}
```

### ⚡ 实战经验

1. **不要用散图做序列帧动画！** 早期项目把每帧存为独立 PNG，同屏 10 个角色就产生 150+ DrawCall。合并为图集后降至 10~15 个 DrawCall，帧率直接翻倍。

2. **图集尺寸红线 2048×2048**：某些低端 Android 设备对 4096 纹理支持不佳，渲染异常但不报错。按 2048 上限拆分图集，如果单角色帧数多就拆成 idle 集和 action 集。

3. **精灵帧缓存复用**：同一种小怪共享一套动画帧，通过不同 Node 实例播放不同进度的 AnimationClip，可以极大节省内存。用 `AnimationClip` 的 `clip.sample` 控制各实例播放偏移。

4. **压缩格式选择**：Android 用 ETC2 + Alpha 图（双纹理），iOS 用 ASTC 4×4。TexturePacker 设置 `--opt rgba4444` 可减少 50% 内存，但要检查带透明边缘的帧是否有色阶问题。

### 🔗 相关问题

- SpriteAtlas 如何手动管理引用计数，避免提前释放？
- 序列帧动画和 Spine 骨骼动画如何选型？性能差异有多大？
- 如何实现序列帧动画的「打断 → 衔接」过渡效果？
