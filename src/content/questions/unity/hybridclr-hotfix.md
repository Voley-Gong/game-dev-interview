---
title: "Unity 热更新方案有哪些？HybridCLR 的原理是什么？与 ILRuntime、xLua 相比有何优劣？"
category: "unity"
level: 3
tags: ["热更新", "HybridCLR", "ILRuntime", "xLua", "IL2CPP"]
related: ["unity/assetbundle-strategy", "unity/addressables-system"]
hint: "关键在于理解 IL2CPP 的 AOT 限制，以及各方案如何绕过它实现运行时执行新代码。"
---

## 参考答案

### ✅ 核心要点

1. **IL2CPP 是核心矛盾**：Unity 编译为 C++ 后无法运行时加载新 C# 代码，热更新必须绕过这个限制
2. **HybridCLR（huatuo）**：在 IL2CPP 基础上补充了完整解释器，纯 C# 热更新，无需额外语言
3. **ILRuntime**：用 C# 实现的 IL 解释器，在运行时加载和解释执行 DLL
4. **xLua**：用 Lua 作为热更脚本语言，通过 C# ↔ Lua 绑定交互
5. **行业趋势**：HybridCLR 已成为主流首选（腾讯、网易、莉莉丝等大厂采用），Lua 方案逐渐减少

### 📖 深度展开

#### 为什么需要热更新？

```
┌──────────────────────────────────────────────────────────┐
│                    热更新技术演进                           │
├──────────┬───────────────────────────────────────────────┤
│ 2014-2017│ xLua / toLua / slua                           │
│          │ Lua 生态成熟，但需要学习两门语言                  │
├──────────┼───────────────────────────────────────────────┤
│ 2017-2020│ ILRuntime / ET框架                            │
│          │ 纯 C# 热更，但性能有限、调试困难                   │
├──────────┼───────────────────────────────────────────────┤
│ 2020-2022│ HybridCLR (huatuo) 诞生                       │
│          │ 近乎原生性能的纯 C# 热更方案                      │
├──────────┼───────────────────────────────────────────────┤
│ 2022-至今│ HybridCLR 成为行业标准                          │
│          │ 腾讯/网易/莉莉丝等全面采用，官方社区推荐            │
└──────────┴───────────────────────────────────────────────┘
```

#### IL2CPP 的限制 — 为什么不能直接热更？

```
C# 源码 (.cs)
     │ mcs/csc 编译
     ▼
IL 中间语言 (.dll / .exe)
     │ IL2CPP 工具链
     ▼
C++ 源码 (.cpp / .h)
     │ 平台编译器 (MSVC / Clang)
     ▼
原生机器码 (.so / .dylib / .dll)

问题：最终产物是静态编译的机器码
     → 无法在运行时加载新的 C# 代码
     → App Store 禁止动态代码下载（JIT 也被禁止）
```

#### HybridCLR 原理 — AOT + 解释器 混合

HybridCLR 的核心思想是 **AOT（提前编译）+ 解释器（Interpreter）混合执行**：

```
┌─────────────────────────────────────────────┐
│              HybridCLR 工作模型               │
├─────────────────────────────────────────────┤
│                                             │
│   AOT 程序集（随包编译的 C# 代码）              │
│   ├─ 引擎代码、框架代码                        │
│   ├─ 基础类型、泛型实例化                      │
│   └─ 通过 IL2CPP → 原生机器码执行（全速）       │
│                                             │
│   ──────── 热更分界线 ────────                │
│                                             │
│   热更程序集（运行时下载的 DLL）                │
│   ├─ 游戏业务逻辑                             │
│   ├─ 新增的类、方法、泛型                       │
│   └─ 由 HybridCLR 解释器执行（接近原生性能）     │
│                                             │
└─────────────────────────────────────────────┘
```

HybridCLR 在 IL2CPP 的产物中 **注入了一个完整的 IL 解释器**，使得运行时加载的 DLL 中的方法可以被解释执行，同时 AOT 代码仍然以原生速度运行。

#### 三大方案对比

| 维度 | HybridCLR | ILRuntime | xLua |
|------|-----------|-----------|------|
| **热更语言** | C# | C# | Lua |
| **学习成本** | 低（纯 C#） | 中（需理解 IL 注入） | 高（需学 Lua + 绑定） |
| **运行性能** | ★★★★☆（接近原生） | ★★☆☆☆（解释器较慢） | ★★★☆☆（LuaJIT 较快） |
| **调试体验** | 好（VS 可断点） | 一般（自带调试器） | 差（Lua 调试受限） |
| **类型系统** | 完整 C# 类型系统 | 受限（需跨域适配器） | 无类型（Lua 动态类型） |
| **GC 跨域** | 无缝（共享 Unity GC） | 有坑（双 GC 需手动管理） | 有坑（Lua GC 独立） |
| **泛型支持** | 完整支持 | 部分限制 | 不适用 |
| **第三方库** | 所有 NuGet / Unity 包 | 受限（需特殊处理） | Lua 生态 |
| **包体增量** | ~2-5MB | ~1MB | ~1-2MB |
| **维护活跃度** | 活跃（官方支持） | 低维护 | 低维护 |

#### HybridCLR 接入流程（概要）

```csharp
// 1. 安装 HybridCLR（Unity Package Manager）
// 通过 git URL: https://github.com/focus-creative-games/hybridclr_unity.git

// 2. 在 HybridCLR 设置面板中：
//    - 设置 AOT 程序集列表（不参与热更的 DLL）
//    - 设置热更程序集列表
//    - 生成 supplement AOT DLL（补充泛型实例化）

// 3. 热更代码示例（普通 C#，无特殊写法）
namespace HotUpdate
{
    public class HotUpdateEntry
    {
        public static void Main()
        {
            Debug.Log("热更代码执行！");
            // 可以自由使用 Unity API、第三方库、泛型...
            var list = new List<int> { 1, 2, 3 };
            Debug.Log($"Sum = {list.Sum()}");
        }
    }
}

// 4. 运行时加载热更 DLL
using HybridCLR;

public class HotUpdateLoader : MonoBehaviour
{
    async void Start()
    {
        // 通过 Addressables / AssetBundle 加载热更 DLL
        byte[] hotUpdateDll = await LoadDllAsync("HotUpdate.dll");
        byte[] aotDllBytes = await LoadDllAsync("AOTGeneric.dll"); // 补充泛型

        // 加载补充元数据（关键步骤！用于 AOT 泛型实例化）
        RuntimeApi.LoadMetadataForAOTAssembly(aotDllBytes, HomologousImageMode.SuperSet);

        // 加载热更程序集
        Assembly hotUpdateAss = Assembly.Load(hotUpdateDll);

        // 通过反射调用入口方法
        var entryMethod = hotUpdateAss.GetType("HotUpdate.HotUpdateEntry")
            .GetMethod("Main");
        entryMethod?.Invoke(null, null);
    }
}
```

### ⚡ 实战经验

- **AOT 泛型补充元数据是最大坑点**：如果热更代码中使用了 AOT 程序集里没有实例化过的泛型类型（如 `Dictionary<string, 自定义类>`），运行时直接崩溃。必须在打热更包时生成并携带补充元数据 DLL
- **开发模式用 Mono、发布用 IL2CPP**：Mono 后端不需要 HybridCLR（可以直接加载 DLL），只有 IL2CPP 后端才需要。开发期用 Mono 方便调试，发布前用 IL2CPP + HybridCLR 完整验证
- **热更 DLL 的分发**：推荐用 AssetBundle 或 Addressables 打包热更 DLL，注意 DLL 不要被压缩损坏（AssetBundle 的 LZ4/LZMA 没问题，但自定义加密要注意格式）
- **iOS 合规**：HybridCLR 是解释器方案，不涉及 JIT 代码生成，符合 App Store 审核（但首次提审仍建议注明热更用途）

### 🔗 相关问题

- HybridCLR 的补充元数据（Supplement AOT Metadata）具体解决什么问题？
- 热更新中如何处理协议变更（新增/删除字段的序列化兼容性）？
- 除了 HybridCLR，还有哪些纯 C# 热更方案（如 Puerts、Nelua）？各自的定位差异？
