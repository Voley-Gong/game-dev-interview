---
title: "Unity AssetBundle 和 Addressables 的加载策略？"
category: "unity"
level: 3
tags: ["资源管理", "AssetBundle", "Addressables"]
hint: "从手动管理 AssetBundle 到 Addressables，资源管理方案的演进。"
---

## 参考答案

### ✅ 核心要点

1. **AssetBundle**：资源打包和运行时加载的基础单元
2. **依赖关系**：AB 之间有依赖，加载时需处理依赖链
3. **Addressables**：Unity 官方的资源管理抽象层，简化 AB 管理
4. **卸载策略**：卸载时机影响内存和引用安全

### 📖 深度展开

**AssetBundle 工作流：**

```
编辑器打包 → AB 文件（含资源 + 依赖信息）
  ↓
上传到 CDN / 本地
  ↓
运行时加载 → AssetBundle.LoadFromFile / LoadFromMemory / LoadFromStream
  ↓
加载资源 → ab.LoadAsset<T>("name")
  ↓
使用 → Instantiate 或直接使用
  ↓
卸载 → ab.Unload(true/false)
```

**常见打包策略：**

| 策略 | 适用场景 | 优缺点 |
|------|----------|--------|
| 按场景打包 | 关卡游戏 | 简单但粒度粗 |
| 按类型打包 | UI/音效/模型分类 | 方便管理 |
| 按频率打包 | 常驻/按需分离 | 内存友好 |
| 按功能模块打包 | DLC/热更友好 | 灵活 |

**Addressables 优势：**

```csharp
// 传统 AssetBundle 痛点：
// 1. 手动管理依赖
// 2. 手动处理变体（Variant）
// 3. 手动管理内存引用计数
// 4. 编辑器和运行时代码不统一

// Addressables 解决方案：
var handle = Addressables.LoadAssetAsync<GameObject>("Assets/Prefabs/Player.prefab");
await handle.Task;
var player = Instantiate(handle.Result);
// 使用完后释放
Addressables.Release(handle);
```

### ⚡ 实战经验

- **Unload(true) 的坑**：会卸载所有从此 AB 加载的资源，包括正在使用的
- **引用计数**：建议自建引用计数系统，确保安全卸载
- **热更新**：AB 是 Unity 热更的基础，结合 Lua/ILRuntime 更新逻辑
- **Addressables 学习曲线**：前期投入大但长期收益高
- **打包体积**：注意重复打包问题，合理设置 AssetBundle Labels
