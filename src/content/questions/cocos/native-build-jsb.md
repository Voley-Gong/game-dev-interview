---
title: "Cocos Creator 3.x 原生平台构建流程与 JSB 桥接机制是怎样的？"
category: "cocos"
level: 3
tags: ["原生构建", "JSB", "跨平台", "引擎原理"]
related: ["cocos/asset-management", "cocos/memory-management"]
hint: "从「点击构建」到生成 APK/APA，中间发生了什么？JS 与原生层如何通信？"
---

## 参考答案

### ✅ 核心要点

1. **构建流水线**：资源序列化 → 引擎打包 → 原生工程生成 → 平台编译链
2. **JSB 机制**：通过绑定层实现 JavaScript ↔ C++ 双向调用
3. **引擎裁剪**：按平台和功能需求移除无用模块，减小包体
4. **原生插件**：通过原生代码扩展引擎能力（广告、SDK 接入等）
5. **调试链路**：Chrome DevTools → JS 引擎 → 原生日志双通道

### 📖 深度展开

#### 构建流程全景

```
点击 Build (编辑器)
  ↓
1. 资源处理
   ├── 序列化场景与预制体 → .json
   ├── 压缩纹理（按平台选择格式）
   ├── 资源合并与去重
   └── 生成 settings.json（资源清单）
  ↓
2. 脚本编译
   ├── TypeScript → JavaScript (tsc / esbuild)
   ├── 模块打包（SystemJS / ESM）
   └── 引擎代码裁剪（feature.json → 定义宏）
  ↓
3. 原生工程生成
   ├── Android: proj-android-studio/ (Gradle 工程)
   ├── iOS: proj-xcode/ (Xcode 工程)
   ├── Windows: proj-win64/ (VS 工程)
   └── 拷贝引擎 .so/.dylib/.dll + 资源到工程
  ↓
4. 平台编译
   ├── Gradle → APK / AAB
   ├── Xcode → IPA
   └── MSBuild → .exe
```

#### JSB 桥接原理

Cocos 原生平台使用 V8（Android）或 JSCore（iOS）执行 JavaScript。引擎核心用 C++ 实现，通过 **JSB 绑定**暴露 API：

```cpp
// C++ 侧注册一个 JS 可调用的函数（简化示例）
static bool js_engine_setDesignResolutionSize(se::State& s) {
    float width = s.args()[0].toFloat();
    float height = s.args()[1].toFloat();
    auto* view = cc::Device::getInstance()->getView();
    view->setDesignResolutionSize(width, height);
    return true;
}
sebind::function("setDesignResolutionSize", js_engine_setDesignResolutionSize);
```

```typescript
// TypeScript 侧调用（看起来像普通 JS 调用）
view.setDesignResolutionSize(750, 1334, ResolutionPolicy.FIXED_WIDTH);
// 实际经过 JSB 绑定 → 调用 C++ 引擎代码
```

#### 各平台 JS 引擎对比

| 平台 | JS 引擎 | 特点 | 性能 |
|------|---------|------|------|
| Android | V8 | JIT 编译，性能最强 | ⭐⭐⭐⭐⭐ |
| iOS | JSCore | Apple 限制无法用 V8 JIT | ⭐⭐⭐ |
| Web | 浏览器 V8 | 受 DOM/API 限制 | ⭐⭐⭐⭐ |
| 小游戏 | 平台 Runtime | 微信/抖音各自实现 | ⭐⭐⭐ |

#### 引擎裁剪机制

```json
// feature.json 片段 — 控制引擎模块包含/排除
{
  "modules": {
    "3d": true,
    "2d": true,
    "physics": ["builtin", "cannon"],
    "tiled-map": false,
    "spine": true,
    "dragonbones": false,
    "video-player": false,
    "webview": false
  }
}
```

裁剪后引擎体积变化（参考值）：

| 配置 | 引擎 JS 大小 | APK 增量 |
|------|-------------|----------|
| 全功能 | ~3.2 MB | ~18 MB |
| 仅 2D | ~1.1 MB | ~12 MB |
| 仅 3D + 物理 | ~2.0 MB | ~15 MB |

### ⚡ 实战经验

1. **包体过大先查裁剪**：90% 的「APK 太大」问题是没做引擎裁剪或纹理压缩。构建前在 Project Settings → Engine 模块裁剪中关闭不需要的功能（如不用 Spine 就关掉 DragonBones）
2. **iOS 内存 Jetsume 崩溃**：JSCore 不能 JIT，重度 JS 逻辑在 iOS 上比 Android 慢 2-3 倍。热点逻辑考虑下沉到 C++ 原生插件
3. **原生插件调试地狱**：JSB 报错栈不连贯，建议在 C++ 侧加详尽的日志输出，并通过 `console.log()` 转发到 JS 层统一收集
4. **构建缓存坑**：Gradle/Xcode 缓存导致代码更新不生效，删 `build/` 和 `native/` 目录重新构建可解决 80% 的玄学问题

### 🔗 相关问题

- 如何开发和发布一个 Cocos Creator 原生插件？
- 小游戏平台（微信/抖音）与原生平台的构建差异在哪里？
- Cocos Creator 引擎源码在哪里可以修改和定制？
