---
title: "Cocos Creator 性能分析工具与 Profiler 如何使用？"
category: "cocos"
level: 2
tags: ["性能优化", "Profiler", "调试工具", "性能分析"]
related: ["cocos/render-pipeline", "cocos/drawcall-optimization", "cocos/memory-management"]
hint: "从引擎内置 Profiler 到 Chrome DevTools，掌握定位性能瓶颈的完整工具链。"
---

## 参考答案

### ✅ 核心要点

1. **引擎 Profiler** → `director.setDisplayStats(true)` 开启实时性能面板，显示 FPS、DrawCall、内存等关键指标
2. **Chrome DevTools** → 通过 Remote Debug 连接 WebView / V8，分析 JS 执行耗时、堆内存、DOM 树
3. **Render Mode 调试** → 使用 `MACRO.ENABLE_TILEDMAP_CULLING`、`showAttachments` 等宏控制渲染调试输出
4. **内存分析** → `profiler.getHeapStatistics()` + Chrome Memory 面板定位内存泄漏
5. **真机 Profiling** → Android 用 GPU Inspector / Xcode Instruments 分析 GPU 和原生层性能

### 📖 深度展开

#### 引擎内置 Profiler 详解

```typescript
import { director, profilo } from 'cc';

// 开启左下角性能面板
director.setDisplayStats(true);

// 显示的信息：
// ┌────────────────────────────┐
// │ FPS: 60  (16.67ms)        │
// │ DrawCall: 48               │
// │ Instance: 32               │
// │ Triangle: 12.5K            │
// │ WebGL: enabled             │
// │ Memory: 45.2MB / 128MB     │
// └────────────────────────────┘
```

```typescript
// 代码采集详细性能数据
import { profiler } from 'cc';

// 自定义性能统计
profiler.enable = true;

// 获取当前帧性能数据
const stats = {
  fps: 1.0 / director.getDeltaTime(),
  drawCalls: renderer.device.drawCall,
  triangles: renderer.device.triangle,
  jsHeap: (performance as any).memory?.usedJSHeapSize || 0,
};
console.table(stats);
```

#### 性能指标基线参考

| 指标 | 绿色（良好） | 黄色（注意） | 红色（需优化） |
|------|-------------|-------------|---------------|
| FPS | 58-60 | 40-57 | < 40 |
| DrawCall | < 100 | 100-200 | > 200 |
| Triangle | < 50K | 50K-100K | > 100K |
| JS堆内存 | < 50MB | 50-100MB | > 100MB |
| 单帧JS耗时 | < 8ms | 8-14ms | > 16ms |
| GC频率 | > 5s/次 | 2-5s/次 | < 2s/次 |

#### Chrome DevTools 远程调试

```bash
# Android WebView 远程调试
# 1. 手机开启 USB 调试，连接电脑
# 2. Chrome 地址栏输入
chrome://inspect

# 3. 找到 Cocos WebView 实例 → Inspect
# 可使用 Performance、Memory、Coverage 面板
```

```typescript
// 在代码中埋点，配合 Performance 面板分析
// 方式1：手动时间戳
const t0 = performance.now();
this.updateEntities(deltaTime);
const t1 = performance.now();
if (t1 - t0 > 5) {  // 超过 5ms 告警
  console.warn(`[Perf] updateEntities took ${(t1-t0).toFixed(2)}ms`);
}

// 方式2：Performance API 标记
performance.mark('updateStart');
this.updateEntities(deltaTime);
performance.mark('updateEnd');
performance.measure('updateDuration', 'updateStart', 'updateEnd');
```

#### 内存泄漏排查流程

```typescript
// Step 1: 在关键生命周期打快照
// 进入场景前
console.log('Scene A: Heap before', performance.memory.usedJSHeapSize);

// 场景中操作...

// 退出场景后
console.log('Scene A: Heap after', performance.memory.usedJSHeapSize);
// 如果退出后内存不回落，说明有泄漏

// Step 2: Chrome Memory 面板
// 1. Take heap snapshot（快照1）
// 2. 执行操作（进入→退出场景）
// 3. Take heap snapshot（快照2）
// 4. 选快照2 → Comparison → 选快照1
// 5. 查看新增的 Delta 对象

// Step 3: 常见泄漏源
// - 事件监听器未移除: node.on('touch', cb) → 必须 node.off('touch', cb)
// - setInterval/setTimeout 未清理
// - 闭包引用大对象
// - 资源未释放: assetManager.releaseAsset()
```

#### 性能分析决策树

```
帧率低 (< 60fps)
  │
  ├── JS 逻辑耗时高？
  │    ├── 是 → Profile JS → 找到热点函数
  │    │    ├── update 循环过重 → 优化实体更新逻辑
  │    │    ├── 序列化/解析慢 → 缓存或异步处理
  │    │    └── GC 频繁 → 减少临时对象分配（对象池）
  │    │
  │    └── 否 → 转 GPU 检查
  │
  ├── GPU 渲染耗时高？
  │    ├── DrawCall 过多 → 合批、合图、减少节点
  │    ├── 三角面过多 → LOD、简化模型
  │    ├── Overdraw 严重 → 减少全屏后处理层级
  │    └── Shader 复杂 → 简化片元计算、移动计算到顶点
  │
  └── 内存/IO 瓶颈？
       ├── 纹理过大 → 压缩纹理（ASTC/ETC2）
       ├── 资源加载卡顿 → 预加载、分帧加载
       └── 内存抖动 → 对象池 + 避免 GC
```

#### 真机性能分析

```typescript
// Android: 通过 adb logcat 监控性能日志
// adb logcat -s cocos2d-x ActivityManager

// iOS: Xcode Instruments → GPU Driver / Time Profiler

// 引擎内置的性能统计 API
import { sys } from 'cc';

// 获取设备信息辅助分析
const deviceInfo = {
  platform: sys.platform,          // 平台类型
  osVersion: sys.osVersion,        // 系统版本
  browserType: sys.browserType,    // 浏览器类型
  pixelRatio: sys.pixelRatio,      // 设备像素比
  // 用于根据设备分级渲染
};

// 根据设备性能分级
const tier = sys.pixelRatio > 2 ? 'high' : 'low';
if (tier === 'low') {
  qualitySettings.enablePostEffect = false;
  qualitySettings.shadowEnabled = false;
  qualitySettings.maxTextureSize = 1024;
}
```

### ⚡ 实战经验

- **先量后优化**：永远先开 Profiler 采集数据，再决定优化方向。"感觉卡"不等于"知道为什么卡"，盲目优化浪费工程量还可能引入新问题。
- **真机数据为准**：PC 浏览器性能强劲，60fps 不代表低端 Android 也流畅。最低测试机型要覆盖目标用户的主力设备（通常是 2-3 年前的千元机）。
- **注意 Profiler 自身开销**：`setDisplayStats(true)` 和 Chrome DevTools 连接会带来额外性能开销（约 3-5ms/帧），正式上线和最终性能测试时必须关闭。
- **GC 是隐形杀手**：很多帧率波动不是逻辑慢而是 GC 触发，用对象池管理频繁创建/销毁的对象（子弹、特效、伤害数字），保持 GC 间隔 > 5 秒。

### 🔗 相关问题

- 如何使用对象池（Object Pool）减少 GC 压力？
- Cocos Creator 的 `assetManager` 分帧加载如何实现？
- 微信小游戏与原生 App 的性能差异在哪里？如何针对性优化？
