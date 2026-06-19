---
title: "Unity Assembly Definition（asmdef）的作用是什么？如何用 asmdef 管理项目代码依赖？"
category: "unity"
level: 2
tags: ["引擎架构", "脚本工程", "编译优化"]
related: ["unity/monobehaviour-lifecycle", "unity/scriptableobject-architecture"]
hint: "asmdef 决定了 C# 代码的编译边界和依赖方向，直接影响编译速度和架构解耦。"
---

## 参考答案

### ✅ 核心要点

1. **asmdef 是编译单元划分工具**：将默认全部编译进 `Assembly-CSharp.dll` 的代码拆分为多个独立 DLL，按需编译
2. **控制依赖方向**：通过显式声明 References，强制模块间单向依赖，防止环形引用
3. **大幅提升编译速度**：修改某模块代码时，只重编译该模块的 DLL，而非整个项目
4. **支持平台条件过滤**：可指定某 asmdef 仅在 Editor、特定平台、特定渲染管线下编译
5. **是大型项目工程化的基础设施**：与 Package Manager、Unity Test Framework、Addressables 等系统深度集成

### 📖 深度展开

#### 默认编译 vs asmdef 编译

Unity 默认将所有 `.cs` 文件编译到 `Assembly-CSharp.dll` 中。任何脚本改动都会触发**全量重编译**，大型项目编译动辄 30-60 秒。

使用 asmdef 后：

```
无 asmdef：
  所有 .cs → Assembly-CSharp.dll（全量编译）
  
有 asmdef：
  Gameplay/  → Gameplay.dll
     ↓ depends on
  Core/      → Core.dll
     ↓ depends on  
  Utils/     → Utils.dll
  
  修改 Gameplay 代码 → 只重编译 Gameplay.dll（2-3秒）
```

#### asmdef 关键配置项

```yaml
# asmdef 文件结构（JSON）
{
    "name": "Com.MyCompany.Gameplay",        // DLL 名称（全局唯一）
    "rootNamespace": "Com.MyCompany.Gameplay",
    "references": [                           // 显式依赖的其他 asmdef
        "Com.MyCompany.Core",
        "Com.MyCompany.Utils",
        "GUID:xxxx-xxxx-xxxx"                 // 也可用 GUID 引用
    ],
    "includePlatforms": ["Android", "iOS"],   // 仅在这些平台编译
    "excludePlatforms": [],                    // 排除这些平台
    "allowUnsafeCode": false,
    "autoReferenced": true,                    // 是否自动被其他 asmdef 引用
    "defineConstraints": ["UNITY_URP"],        // 类似 #if 条件编译
    "versionDefines": [                        // 根据包版本定义符号
        {
            "name": "com.unity.render-pipelines.universal",
            "expression": "10.0.0",
            "define": "HAS_URP_10"
        }
    ],
    "noEngineReferences": false                // 不引用 UnityEngine
}
```

#### 实际项目分层架构

```
Assembly-CSharp（入口层，尽量薄）
    ↓
Com.Game.Gameplay        ← 玩法逻辑、角色控制
Com.Game.UI              ← UI 控制、界面管理
Com.Game.Audio           ← 音频管理
    ↓
Com.Game.Core            ← 公共数据结构、事件系统、工具类
    ↓
Com.Game.ThirdParty      ← 第三方库（Protobuf、Luban 配置等）
```

#### autoReferenced 的陷阱

| autoReferenced = true（默认） | autoReferenced = false |
|------|------|
| 自动出现在所有其他 asmdef 的引用列表中 | 必须手动添加 references |
| 方便但容易产生隐式耦合 | 强制显式声明依赖，架构更清晰 |
| 适合工具类、底层库 | 适合业务模块、独立功能包 |

### ⚡ 实战经验

1. **迁移存量项目时渐进式拆分**：先按大模块拆（如 `Game/`、`Editor/`、`Tests/`），再在模块内部细分。一次性全拆会导致编译错误爆炸，排查极其痛苦
2. **Editor 代码必须单独拆 asmdef**：标记 `"includePlatforms": ["Editor"]`，否则 Editor 命名空间会泄漏到 Runtime 构建，导致打包失败
3. **注意 GUID 引用 vs Name 引用**：团队协作时优先用 Name 引用（可读性好），通过 Package Manager 分发的包用 GUID 引用（更稳定，不怕 rename）
4. **asmdef 与反射的冲突**：跨 asmdef 用 `Type.GetType("MyClass")` 可能返回 null，因为类型在不同 DLL 中。需要用 `AppDomain.CurrentDomain.GetAssemblies()` 遍历搜索

### 🔗 相关问题

- asmdef 和 Unity Package Manager（UPM）是什么关系？如何把自己的 asmdef 打成独立 Package？
- 大型项目有上百个 asmdef，如何管理版本依赖和团队协作？
- asmdef 的 `defineConstraints` 和全局 `Scripting Define Symbols` 有什么区别？
