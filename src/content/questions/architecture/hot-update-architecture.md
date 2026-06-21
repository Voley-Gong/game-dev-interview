---
title: "游戏热更新架构如何设计代码与资源的分离边界？"
category: "architecture"
level: 4
tags: ["热更新", "HybridCLR", "xLua", "ILRuntime", "资源管理", "版本管理", "架构设计"]
related: ["architecture/game-framework-comparison", "architecture/save-system-architecture", "architecture/game-loop-subsystem"]
hint: "热更新不只是'怎么把新代码塞进去'，而是从一开始就把'可变'与'不可变'的边界划清楚——代码分离、资源分离、版本流、回滚兜底缺一不可。"
---

## 参考答案

### ✅ 核心要点

1. **热更新 = 可变层 + 不可变层**：不可变层（AOT/原生）是 App Store 审核过的包体基础，可变层（热更代码 + 资源）走 CDN 随版本下发。架构设计的核心是「把所有会变的东西都放进可变层」，包括玩法逻辑、配置、UI 预制体、美术资源。
2. **代码分离的三层结构**：`AOT 层`（引擎+基础框架，编译进包体）→ `热更程序集`（HybridCLR 的 HotUpdate.dll / Lua 脚本，走 CDN）→ `桥接层`（接口定义放 AOT，实现放热更，靠反射或注册表连接）。桥接层是关键，AOT 代码不能直接 `new` 热更类（编译期不存在）。
3. **资源分离靠「资源不在包体 + 运行时按版本加载」**：首包只放启动必须的少量资源（Logo、Loading、基础 UI），其余资源全部放 CDN。资源版本用「清单文件（manifest）+ 内容寻址（hash 命名）」实现增量更新——只下载变化的文件。
4. **版本流：版本号比对 → 差异列表 → 增量下载 → 校验 → 生效**。客户端启动时拉取服务端 manifest，与本地 manifest 比对，算出需新增/更新的文件列表，下载后做 hash 校验，全部成功才原子切换到新版本，失败则回滚到上一可用版本。
5. **代码热更 vs 资源热更必须独立解耦**：代码版本和资源版本用不同的版本号通道，资源可以单独发版（改个配置数值不用重发代码），代码热更也要能兼容旧资源（旧资源格式要有版本兼容逻辑），否则会出现「代码热更了但资源没更新」的崩溃。

### 📖 深度展开

**整体架构分层：**

```
┌──────────────────────────────────────────────────────┐
│  CDN 服务器（可变层，随时发版）                          │
│  ├── /v1.2.3/hotupdate.dll      ← 热更代码            │
│  ├── /v1.2.3/manifest.json      ← 版本清单            │
│  ├── /v1.2.3/ui/shop.prefab     ← UI 资源            │
│  ├── /v1.2.3/config/skill.xlsx  ← 配置表             │
│  └── /v1.2.3/scene/battle.ab    ← 场景 AssetBundle   │
└────────────────────────┬─────────────────────────────┘
                         │ 启动时拉取 manifest，差异下载
┌────────────────────────▼─────────────────────────────┐
│  客户端包体（不可变层，App Store 审核版）                 │
│  ├── 引擎原生层（Cocos/Unity Runtime）                 │
│  ├── AOT 程序集（框架骨架 + 接口定义）                   │
│  │     └─ IBattleSystem, IUIManager（接口）           │
│  ├── 热更新引导器（Bootstrapper）                       │
│  │     └── 下载 hotupdate.dll → 加载 → 注册实现         │
│  └── 首包资源（Logo、Loading 界面，约 20MB）            │
└──────────────────────────────────────────────────────┘
```

**代码热更的桥接层设计（关键）：**

```csharp
// === AOT 层（编译进包体，不可热更）===
public interface IEntry {
    void StartGame();
}
// 引导器：负责下载热更 dll，加载后通过反射拿到入口类
public class Bootstrapper {
    public async void Run() {
        await DownloadHotUpdateDll();          // 从 CDN 下 dll
        var asm = Assembly.Load(File.ReadAllBytes(hotUpdatePath));
        // AOT 不能直接 new 热更类，只能反射或注册表
        var entryType = asm.GetType("HotUpdate.GameEntry");
        var entry = (IEntry)Activator.CreateInstance(entryType);
        entry.StartGame(); // 进入热更逻辑
    }
}

// === 热更层（HotUpdate.dll，走 CDN）===
public class GameEntry : IEntry {
    public void StartGame() {
        // 这里可以自由 new 同程序集内的热更类
        var battleSystem = new BattleSystem();
        battleSystem.Init();
    }
}
```

**资源版本管理（Manifest + 差异更新）：**

```json
// manifest.json —— 每个文件按内容 hash 命名，支持增量
{
  "version": "1.2.3",
  "codeVersion": "1.2.3",      // 代码版本
  "resourceVersion": "1.2.5",   // 资源版本（独立）
  "files": {
    "ui/shop.prefab":     { "hash": "a3f1b2", "size": 24580, "ab": "ui_ab_1" },
    "config/skill.json":  { "hash": "8c0e44", "size": 1024 },
    "scene/battle.ab":    { "hash": "ff2290", "size": 5021443 }
  }
}
```

```csharp
// 客户端差异计算：对比本地与远端 manifest
public List<string> CalcDiff(Manifest local, Manifest remote) {
    var needDownload = new List<string>();
    foreach (var kv in remote.files) {
        if (!local.files.TryGetValue(kv.Key, out var localFile)
            || localFile.hash != kv.Value.hash) {  // hash 不同才下载
            needDownload.Add(kv.Key);
        }
    }
    return needDownload; // 只下载变化的文件，而非全量
}
```

**三种热更代码方案的架构层差异：**

| 维度 | xLua（Lua） | ILRuntime（C# 解释） | HybridCLR（C# 混合） |
|------|-------------|---------------------|----------------------|
| 热更语言 | Lua | C#（解释执行） | C#（AOT+解释混合） |
| 桥接方式 | CS.Wrap（手写/生成） | AppDomain.Load | Assembly.Load（补充元数据） |
| AOT 与热更通信 | 跨语言 bridge | 虚拟机内调用 | 原生 C# 调用 |
| 资源热更是否独立 | ✅ 是 | ✅ 是 | ✅ 是 |
| 代码与资源版本解耦 | ✅ 完全独立 | ✅ 完全独立 | ✅ 完全独立 |
| 架构复杂度 | 高（双语言） | 中 | 低（纯 C#） |

> 注：资源热更（AssetBundle/资源版本）三种方案完全一致，区别仅在代码热更层。所以「代码热更选型」和「资源热更架构」是两个独立的决策。

**首包→热更启动时序：**

```
App 启动
  ↓
1. Bootstrapper 显示首包 Logo/Loading（不可变层资源）
  ↓
2. 拉取服务端 manifest → 比对本地 → 算出差异
  ↓
3. 下载热更代码 dll + 差异资源文件
  ↓
4. hash 校验全部文件（防篡改、防下载损坏）
  ↓
5. 全部成功 → 原子切换版本（写入新 manifest）
   任一失败 → 回滚旧版本 + 提示重试
  ↓
6. Assembly.Load 热更 dll → 反射创建 Entry → StartGame
```

### ⚡ 实战经验

- **代码热更别碰引擎 API 的签名**：热更代码里调用 `GameObject.Find` 没问题，但如果热更代码引用了 AOT 层某个被裁剪（stripped）的方法，IL2CPP 下会运行时崩溃。HybridCLR 用「补充元数据（AOTMetaData）」解决，但每个 AOT 泛型方法都要预留，漏了就崩——上线前必须跑完整 link.xml 白名单检查。
- **资源版本回滚要做原子切换**：下载了一半网络断了，如果直接用半新半旧的 manifest，会加载到不一致的资源（新代码引用旧资源名）。正确做法：下载到临时目录，全部校验通过后一次性替换 manifest，失败则临时目录丢弃、本地 manifest 不变。
- **AssetBundle 的依赖链是热更地狱**：A.prefab 依赖 B.texture，B 更新了 hash 但 A 的 AB 没重新打包，运行时加载 A 时会引用旧的 B 或找不到 B。必须用「依赖清单」记录每个 AB 引用的其他 AB，更新 B 时级联标记依赖它的 AB。
- **配置热更≠代码热更，但二者要联动**：策划改了技能数值（配置热更），但如果代码逻辑没同步热更，新配置的字段在旧代码里读不到。约定：配置版本号变更时，若代码版本不匹配则强制拉取对应代码热更包，或代码做配置版本兼容（未知字段忽略而非崩溃）。

### 🔗 相关问题

1. HybridCLR 的「补充元数据（AOT Generic）」机制具体怎么解决泛型热更问题？
2. AssetBundle 的冗余打包和依赖管理如何优化？（提示：用 SpriteAtlas、Addressables）
3. 如果热更包有严重 bug 导致大面积崩溃，如何做「紧急回滚」到上一稳定版本？
