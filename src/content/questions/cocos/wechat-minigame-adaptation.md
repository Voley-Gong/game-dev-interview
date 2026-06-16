---
title: "Cocos Creator 微信小游戏适配有哪些关键问题？"
category: "cocos"
level: 3
tags: ["微信小游戏", "平台适配", "性能优化", "分包"]
related: ["cocos/native-build-jsb", "cocos/memory-management"]
hint: "从引擎运行环境差异、分包加载、内存限制、性能特性四个维度展开"
---

## 参考答案

### ✅ 核心要点

1. **运行环境差异**：微信小游戏不是浏览器，没有 DOM/BOM，API 经过微信运行时包装
2. **包体限制**：主包 4MB，总分包 20MB（含主包），超限需远程加载
3. **内存敏感**：iOS 微信内存上限约 200MB，超限会被系统强杀无提示
4. **GPU 能力弱**：移动端 GPU 差异大，DrawCall 和 Shader 复杂度需严格管控
5. **API 适配层**：`wx.*` API 替代标准 Web API，引擎层面已做桥接但需注意差异

### 📖 深度展开

#### 包体管理与分包策略

微信小游戏有严格的包体限制：

| 类型 | 大小限制 | 说明 |
|------|----------|------|
| 主包 | 4 MB | 首次加载，必须包含启动场景 |
| 分包 | 单包 ≤ 4MB | 按需加载，可预下载 |
| 总计 | ≤ 20 MB | 主包 + 所有分包 |
| 超出部分 | 不限 | 通过远程资源服务器加载 |

```
游戏目录结构示例：
├── main/          (主包 < 4MB)
│   ├── 启动场景
│   ├── 登录场景
│   └── loading 界面
├── subpack1/      (分包1 - 核心玩法)
│   ├── 战斗场景
│   └── 角色资源
├── subpack2/      (分包2 - 社交系统)
│   └── 聊天/好友
└── remote/        (远程资源 - CDN)
    ├── 音频文件
    ├── 高清贴图
    └── 视频资源
```

Cocos Creator 中配置分包：

```typescript
// project.config.json 或引擎内 Asset Bundle 配置
{
  "subpackages": [
    {
      "name": "battle",
      "root": "subpackages/battle/"
    },
    {
      "name": "social",
      "root": "subpackages/social/"
    }
  ]
}

// 代码中加载分包
assetManager.loadBundle('battle', (err, bundle) => {
  if (err) return;
  bundle.load('scenes/battle', SceneAsset, (err, scene) => {
    director.runScene(scene);
  });
});

// 预下载分包（不打断当前游戏）
assetManager.down('social');
```

#### 内存管理策略

iOS 微信小游戏的内存被系统严格管控，超出阈值会被直接杀进程：

```typescript
// 内存监控与主动释放
export class MemoryGuard {
  private static readonly SAFE_THRESHOLD = 150; // MB，留安全余量

  static getMemoryInfo(): wx.MemoryInfo {
    // 微信提供 wx.getPerformance() 或 performance.memory（部分版本）
    return wx.getPerformance?.() || null;
  }

  static checkAndRelease(): void {
    const info = this.getMemoryInfo();
    if (info && info.used > this.SAFE_THRESHOLD) {
      console.warn(`[MemoryGuard] 内存 ${info.used}MB 超阈值，执行释放`);
      // 1. 释放非活跃 Bundle
      assetManager.getBundle('social')?.releaseAll();
      // 2. 清理纹理缓存
      director.getScene()?.walk(node => {
        const render = node.getComponent(Sprite);
        if (render?.spriteFrame?.texture) {
          // 非可见节点的贴图可安全释放
        }
      });
      // 3. 强制 GC（微信支持）
      wx.triggerGC?.();
    }
  }
}

// 场景切换时调用
director.on(Director.EVENT_AFTER_SCENE_LAUNCH, () => {
  MemoryGuard.checkAndRelease();
});
```

#### 常见平台差异与适配

```typescript
// 1. 音频适配：微信 InnerAudioContext vs WebAudio
export class AudioAdapter {
  private static ctx: wx.InnerAudioContext;

  static playBGM(url: string): void {
    if (sys.platform === sys.WECHAT_GAME) {
      this.ctx = wx.createInnerAudioContext();
      this.ctx.src = url;
      this.ctx.loop = true;
      this.ctx.volume = 0.5;
      // 微信小游戏需要用户交互后才能播放
      wx.onShow(() => this.ctx?.play());
    } else {
      // 标准 WebAudio 路径
      audioSource.clip = url;
      audioSource.play();
    }
  }
}

// 2. 存储适配
export class StorageAdapter {
  static set(key: string, value: any): void {
    if (sys.platform === sys.WECHAT_GAME) {
      wx.setStorageSync(key, value);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }

  static get<T>(key: string): T | null {
    if (sys.platform === sys.WECHAT_GAME) {
      return wx.getStorageSync(key) || null;
    }
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  }
}

// 3. 分享与录屏（微信特有能力）
export class WeChatShare {
  static shareAppMessage(title: string, imageUrl: string): void {
    if (sys.platform === sys.WECHAT_GAME) {
      wx.shareAppMessage({ title, imageUrl });
      // 也可以用 wx.onShareAppMessage 设置默认分享
    }
  }

  static showShareMenu(): void {
    if (sys.platform === sys.WECHAT_GAME) {
      wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
    }
  }
}
```

#### 性能优化要点

```
微信小游戏性能优化优先级：
┌─────────────────────────────────────┐
│ 1. DrawCall 数 ≤ 50（低端机）       │  ← 合批、图集、静态合批
│ 2. 单帧三角形数 ≤ 30K               │  ← LOD、裁剪、简化模型
│ 3. 纹理内存 ≤ 60MB                  │  ← 压缩纹理、释放策略
│ 4. 逻辑帧 ≤ 16ms                    │  ← 避免大循环、对象池
│ 5. GC 频率 ≤ 1次/秒                 │  ← 对象复用、减少分配
└─────────────────────────────────────┘
```

### ⚡ 实战经验

1. **首屏速度是生死线**：主包必须控制在 4MB 以内，启动场景极简（logo + loading 条），核心资源全部分包化。实测主包每多 1MB，冷启动慢 0.5~1 秒
2. **iOS 内存崩溃无警告**：微信不会给你 onMemoryWarning（部分版本有但不可靠），必须在测试阶段就用 Instruments 模拟内存压力，提前做好资源释放策略
3. **压缩纹理格式必须用**：ASTC（iOS）+ ETC2（Android），不要用 PNG/JPG，贴图内存占用差 4~6 倍
4. **微信开发者工具 ≠ 真机表现**：工具上性能很好但真机可能卡死，必须用低端真机（如 iPhone 8 / 红米）测试帧率和内存

### 🔗 相关问题

- 微信小游戏的网络请求与标准 WebSocket 有什么差异？
- 如何实现微信小游戏的录屏分享功能？
- Cocos Creator 构建微信小游戏时，引擎模块裁剪策略是怎样的？
