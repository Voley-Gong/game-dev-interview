---
title: "Cocos Creator 编辑器扩展与插件开发流程是怎样的？"
category: "cocos"
level: 3
tags: ["编辑器扩展", "插件开发", "工程化", "自动化"]
related: ["cocos/asset-management", "cocos/dynamic-loading"]
hint: "从扩展面板、自定义资源管线到构建流程自动化，编辑器扩展能解决什么工程痛点？"
---

## 参考答案

### ✅ 核心要点

1. **扩展机制** → 基于 Extension系统，通过 `package.json` + `src/` 注册面板和消息
2. **面板开发** → 使用 HTML/CSS/JS 或 Vue/Angular 构建自定义 Inspector 和面板
3. **资源管线钩子** → 自定义资源导入器（Importer），扩展 `.prefab`、`.scene` 之外的资源类型
4. **构建流程钩子** → `build` 生命周期的 before/after 回调，实现打包后处理
5. **进程通信** → 主进程（Main Process）与渲染进程（Panel）通过 Message 系统通信

### 📖 深度展开

#### 扩展项目结构

```
my-extension/
├── package.json          # 扩展描述文件（入口、依赖、contributions）
├── src/
│   ├── main.js           # 主进程入口
│   ├── panels/
│   │   └── my-panel.js   # 面板逻辑
│   └── importers/
│       └── custom-asset.js  # 自定义资源导入器
├── static/
│   └── panel.html        # 面板 UI
└── readme.md
```

#### package.json 核心字段

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "main": "./src/main.js",
  "contributions": {
    "panels": {
      "default": {
        "title": "My Panel",
        "type": "dockable",
        "main": "./static/panel.html"
      }
    },
    "messages": {
      "do-something": {
        "methods": ["handleDoSomething"]
      }
    }
  }
}
```

#### 主进程消息处理

```javascript
// src/main.js
exports.methods = {
  handleDoSomething(assetUuid) {
    const assetManager = Editor.Message.request('asset-db', 'query-asset-info', assetUuid);
    // 处理资源逻辑...
    return { success: true };
  }
};

// 监听构建事件
exports.load = function() {
  Editor.Message.addBroadcastListener('build-started', (event) => {
    console.log('构建开始', event);
  });

  Editor.Message.addBroadcastListener('build-finished', (event) => {
    console.log('构建完成，执行后处理...');
    // 例如：压缩资源、上传 CDN、通知 CI
  });
};
```

#### 自定义资源导入器

```javascript
// src/importers/custom-asset.js
class CustomImporter extends Editor.Importer {
  static get version() { return '1.0.0'; }
  static get defaultSettings() {
    return { compressQuality: 0.8 };
  }

  // 核心导入逻辑
  async execute(assetList) {
    for (const asset of assetList) {
      const buffer = await this.readFile(asset.path);
      const processed = await this.processBuffer(buffer);
      this.createAsset(asset.uuid, processed);
    }
    return true;
  }

  async processBuffer(buffer) {
    // 自定义解码/压缩/格式转换
    return buffer;
  }
}
```

#### 消息通信流程

```
面板 UI (Renderer Process)
  │
  ├── Editor.Message.send('my-extension', 'do-something', uuid)
  │                                    ↓
  主进程 (Main Process)
  │   ├── methods.handleDoSomething(uuid)
  │   ├── 调用 engine API
  │   ├── 访问文件系统
  │   └── 返回结果
  │                                    ↓
  面板 UI 接收广播消息
      Editor.Message.addBroadcastListener(...)
```

#### 常见扩展场景

| 场景 | 说明 | 关键 API |
|------|------|----------|
| 自定义 Inspector | 为组件添加可视化编辑面板 | `Editor.Panel.open()` |
| 批量资源处理 | 一键重命名/压缩/分类 | `asset-db` 消息 |
| 构建后处理 | 压缩/加密/上传 | `build-finished` 事件 |
| 代码生成 | 根据配置生成脚本 | `asset-db:create-asset` |
| 预览增强 | 自定义预览窗口 | Panel + Vue |

### ⚡ 实战经验

- **插件调试是痛点**：编辑器扩展的调试依赖 Chrome DevTools（`--inspect`），建议在 `package.json` 中配置 `"debug": true`，开发时打开 DevTools 面板进行断点
- **版本兼容性陷阱**：Cocos Creator 3.x 的 Editor API 在小版本间偶有 breaking change，发布插件时必须声明兼容版本范围（`"engine-version": ">=3.8.0"`），在多个版本上做回归测试
- **构建钩子要幂等**：`build-finished` 回调中的逻辑必须幂等，因为 CI 可能因失败而重试构建；且回调中的异步操作必须正确 `await`，否则构建工具可能在操作完成前就退出
- **性能敏感操作放主进程**：文件 IO、大量资源处理应放在主进程中执行，面板只负责展示，避免 UI 卡顿；面板与主进程之间通过 Message 异步通信

### 🔗 相关问题

- 如何为自定义资源类型（如 protobuf 配置）编写 Importer，使其能像普通资源一样被引用和管理？
- 在团队工作流中，如何利用编辑器扩展实现"策划填表 → 自动生成预制体"的自动化管线？
