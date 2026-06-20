---
title: "Unity Package Manager (UPM) 的原理是什么？如何创建和分发自定义 UPM 包？"
category: "unity"
level: 2
tags: ["工程化", "包管理", "UPM", "模块化"]
related: ["unity/assembly-definition", "unity/scriptableobject-architecture", "unity/editor-extension"]
hint: "UPM 的底层是什么？本地包、Git 包、Registry 包有什么区别？如何搭建私有 Registry？"
---

## 参考答案

### ✅ 核心要点

1. **UPM 底层基于 npm 协议**：Unity Package Manager 与 Node.js 的 npm 生态兼容，包的 `package.json` 遵循 npm 规范扩展，Registry 服务器也是标准 npm registry
2. **包的四种来源**：Registry（官方/私有注册表）、Embedded（项目内 `Packages/` 目录）、Local（磁盘路径 file: 引用）、Git（仓库 URL + tag/branch）
3. **包结构规范**：必须包含 `package.json`，建议包含 `Runtime/`、`Editor/`、`Tests/` 三个 asmdef 程序集域，通过 asmdef 控制 Editor/Runtime 代码隔离
4. **Assembly Definition 是 UPM 的基石**：每个 UPM 包至少需要一个 asmdef，包内代码通过 asmdef 声明依赖关系，实现编译级隔离
5. **版本管理遵循 SemVer**：`MAJOR.MINOR.PATCH` 语义化版本，UPM 也支持预发布标签（如 `1.0.0-beta.1`）和 Git tag 映射

### 📖 深度展开

#### UPM 包目录结构

```
my-custom-package/
├── package.json              # 必需，包元数据
├── README.md
├── CHANGELOG.md
├── LICENSE.md
├── Runtime/
│   ├── MyPackage.Runtime.asmdef   # Runtime 程序集
│   ├── Scripts/
│   │   ├── Core/
│   │   └── Components/
│   └── Resources/                 # 可选
├── Editor/
│   ├── MyPackage.Editor.asmdef    # Editor-only 程序集
│   ├── Inspector/
│   └── Wizard/
├── Tests/
│   ├── Runtime/
│   │   ├── MyPackage.Tests.asmdef
│   │   └── MyPackageTests.cs
│   └── Editor/
│       └── MyPackage.Editor.Tests.asmdef
└── Documentation~               # Unity 自动识别，不编译
    └── my-package.md
```

#### package.json 详解

```json
{
    "name": "com.mycompany.game-framework",
    "version": "1.2.0",
    "displayName": "Game Framework",
    "description": "Core game framework with MVC pattern and service locator",
    "unity": "2022.3",                    // 最低 Unity 版本
    "unityRelease": "0f1",                // 可选，特定 Unity 版本
    "dependencies": {
        "com.unity.ugui": "2.0.0",
        "com.unity.addressables": "1.21.0"
    },
    "keywords": ["framework", "mvc", "utility"],
    "author": {
        "name": "My Company",
        "email": "dev@mycompany.com",
        "url": "https://mycompany.com"
    },
    "changelogUrl": "https://github.com/mycompany/game-framework/blob/main/CHANGELOG.md",
    "documentationUrl": "https://docs.mycompany.com/game-framework",
    "licensesUrl": "https://github.com/mycompany/game-framework/blob/main/LICENSE",
    "type": "library"                     // library | module | tool | template
}
```

#### 包引用方式对比

| 方式 | manifest.json 写法 | 适用场景 | 优缺点 |
|------|-------------------|---------|--------|
| Registry（官方/私有） | `"com.unity.addressables": "1.21.0"` | 生产环境、团队共享 | ✅ 版本精确、缓存好；❌ 需搭建 Registry |
| Git URL | `"com.mycompany.pkg": "https://github.com/mycompany/pkg.git#v1.2.0"` | 开源引用、跨项目复用 | ✅ 无需 Registry；❌ 大仓库克隆慢、难缓存 |
| Git 子目录 | `"com.mycompany.pkg": "https://github.com/mycompany/mono.git?path=/Packages/pkg#v1.2.0"` | Monorepo 架构 | ✅ 单仓库多包；❌ 路径绑定 |
| Local file: | `"com.mycompany.pkg": "file:../../shared-packages/game-framework"` | 本地开发调试 | ✅ 改动即时生效；❌ 路径依赖机器、不可移植 |
| Embedded | 直接放 `Packages/` 目录 | 快速原型、一次性模块 | ✅ 最简单；❌ 无法跨项目复用 |

#### manifest.json 示例

```json
{
    "dependencies": {
        "com.unity.ide.rider": "3.0.0",
        "com.unity.addressables": "1.21.19",
        
        // Git 包 —— 指定 tag
        "com.mycompany.core": "https://git@github.com/mycompany/core.git#v2.1.0",
        
        // Git 包 —— 指定分支
        "com.mycompany.tools": "https://git@github.com/mycompany/tools.git#dev",
        
        // Local 包 —— 团队统一路径约定
        "com.mycompany.framework": "file:../shared-packages/framework",
        
        // 私有 Registry
        "com.mycompany.ui-kit": "1.0.0"
    },
    "scopedRegistries": {
        "npm.mycompany.com": {
            "url": "https://npm.mycompany.com",
            "scopes": ["com.mycompany"]
        }
    }
}
```

#### asmdef 依赖管理

```csharp
// Runtime asmdef (MyPackage.Runtime.asmdef)
{
    "name": "MyPackage.Runtime",
    "rootNamespace": "MyCompany.GameFramework",
    "references": [
        "GUID:...",                          // 引用其他包的 asmdef（用 GUID 最稳定）
        "Unity.Addressables"                 // 或用名称引用
    ],
    "includePlatforms": [],                  // 空数组 = 全平台
    "excludePlatforms": [],
    "allowUnsafeCode": false,
    "versionDefines": [                      // 条件编译
        {
            "name": "USE_ADDRESSABLES",
            "expression": "com.unity.addressables>=1.20",
            "define": "USE_ADDRESSABLES"
        }
    ]
}

// Editor asmdef (MyPackage.Editor.asmdef)
{
    "name": "MyPackage.Editor",
    "references": ["MyPackage.Runtime"],
    "includePlatforms": ["Editor"],          // 只在编辑器编译
    "defineConstraints": ["UNITY_EDITOR"]
}
```

#### 搭建私有 Registry 方案

```
方案对比：
┌─────────────────────┬────────────────┬──────────────────────────┐
│ 方案                │ 复杂度         │ 适用场景                 │
├─────────────────────┼────────────────┼──────────────────────────┤
│ Verdaccio (npm)     │ 低，Docker 一键│ 小团队，内部共享         │
│ AWS CodeArtifact    │ 中，云托管     │ 企业级，已有 AWS 基础设施│
│ GitHub Packages     │ 低             │ 开源/小团队，GitHub 生态 │
│ Unity 自建 Registry │ 中             │ 需要特殊审核流程         │
└─────────────────────┴────────────────┴──────────────────────────┘
```

**Verdaccio 快速搭建：**
```bash
# docker-compose.yml
version: '3'
services:
  verdaccio:
    image: verdaccio/verdaccio:5
    ports:
      - "4873:4873"
    volumes:
      - ./storage:/verdaccio/storage
      - ./conf:/verdaccio/conf

# 发布包
cd /path/to/my-package
npm publish --registry http://localhost:4873

# Unity 项目 manifest.json 配置
# "scopedRegistries": { ... } 如上所示
```

#### 与传统 "Assets/Plugins" 导入的区别

| 维度 | UPM 包 | Assets/Plugins 导入 |
|------|--------|-------------------|
| 版本管理 | 内置，manifest.json 锁版本 | 手动管理，容易冲突 |
| 编译隔离 | asmdef 独立编译域 | 全局编译，易产生环形依赖 |
| 平台裁剪 | asmdef includePlatforms 自动裁剪 | 需手动 `#if UNITY_EDITOR` |
| 升级更新 | 修改版本号即可 | 手动替换文件 |
| 项目体积 | 包在 Library/ 缓存，不进 Assets/ | 直接占项目空间 |
| Git 冲突 | 几乎不会（manifest.json 小） | 高频冲突（meta 文件等） |

### ⚡ 实战经验

- **用 GUID 引用 asmdef，不用名称**：名称可能被重命名，GUID 不会变。在 `references` 中使用 `"GUID:<实际GUID>"`，协作时不会因为重命名断裂
- **Git 包锁定 tag 不是 branch**：生产项目永远用 `#v1.2.0` 这种 tag 锁定。用 `#main` 分支会导致 UPM 缓存失效，每次刷新都拉新代码，出现"昨天好好的今天就坏了"的幽灵 Bug
- **CHANGELOG.md 是必须的**：即使只有自己用，也坚持写。UPM 包管理窗口会直接展示 CHANGELOG，团队成员升级包时能快速判断风险
- **私有包用 Verdaccio + scopedRegistries**：小团队 5 人以下直接 Docker 跑 Verdaccio，`scopedRegistries` 配置好 scope（如 `com.mycompany`），团队成员只需 clone 项目，UPM 自动从私有 Registry 拉取

### 🔗 相关问题

- Assembly Definition（asmdef）的依赖管理机制是什么？如何避免环形依赖？
- 如何将现有的 Assets/Plugins 老项目迁移到 UPM 包架构？
- Unity 的 Scriptable Object Pipeline 和 UPM 有什么关系？
