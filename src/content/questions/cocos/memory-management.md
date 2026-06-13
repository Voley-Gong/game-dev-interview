---
title: "Cocos Creator 的 TypeScript/JavaScript 内存管理需要注意什么？"
category: "cocos"
level: 2
tags: ["内存管理", "性能优化"]
related: ["cocos/drawcall-optimization"]
hint: "JS 的 GC 不是万能的，游戏中的内存泄漏有哪些典型场景？"
---

## 参考答案

### ✅ 核心要点

1. **闭包泄漏**：闭包持有外部引用导致对象无法释放
2. **事件监听泄漏**：注册但未移除的事件回调
3. **全局缓存膨胀**：资源/数据缓存无限增长
4. **节点引用残留**：destroy 后仍被其他对象引用
5. **定时器泄漏**：未清理的 setTimeout / schedule

### 📖 深度展开

**常见内存泄漏场景及修复：**

```typescript
// ❌ 泄漏：事件未移除
onEnable() {
  this.node.on('custom-event', this.onEvent, this);
}
// 缺少 onDisable 中的 off

// ✅ 正确：配对注册和移除
onEnable() {
  this.node.on('custom-event', this.onEvent, this);
}
onDisable() {
  this.node.off('custom-event', this.onEvent, this);
}

// ❌ 泄漏：闭包持有引用
createCallback() {
  const bigData = this.loadHugeData();
  setInterval(() => {
    console.log(bigData.length); // bigData 永远无法释放
  }, 1000);
}

// ❌ 泄漏：节点销毁但引用还在
const nodes: Node[] = [];
const n = instantiate(prefab);
nodes.push(n);
n.destroy();
// nodes 数组仍然引用已销毁的节点

// ✅ 正确：destroy 后清理引用
n.destroy();
const idx = nodes.indexOf(n);
if (idx >= 0) nodes.splice(idx, 1);
```

**内存优化策略：**

1. **对象池**：频繁创建销毁的对象使用对象池
2. **资源释放**：及时释放不再使用的资源（`assetManager.release`）
3. **纹理压缩**：使用 ASTC/ETC2 压缩格式减少显存
4. **分帧加载**：大资源分帧加载避免瞬时内存峰值

### ⚡ 实战经验

- 用 Chrome DevTools 的 Memory 面板做 Heap Snapshot 对比
- Cocos 的 `cc.debug.setDisplayStats(true)` 可以看内存和帧率
- 真机上的内存限制比浏览器严格得多（尤其 iOS）
- 图片资源是内存大户，注意纹理尺寸和压缩格式

### 🔗 相关问题

- DrawCall 优化有哪些策略？
- 如何设计通用的对象池？
