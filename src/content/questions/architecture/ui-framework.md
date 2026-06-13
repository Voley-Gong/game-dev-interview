---
title: "如何设计一个可扩展的 UI 框架？"
category: "architecture"
level: 3
tags: ["UI框架", "架构设计"]
hint: "从 UI 栈管理到动态加载，一个生产级 UI 框架需要什么？"
---

## 参考答案

### ✅ 核心要点

1. **UI 栈管理**：前进/后退/替换，维护导航历史
2. **分层架构**：底层/场景层/弹窗层/提示层分离
3. **动态加载**：UI 预制体按需加载和卸载
4. **数据绑定**：UI 与数据模型解耦
5. **动画过渡**：打开/关闭动画可配置

### 📖 深度展开

**框架分层：**

```
┌──────────────────────────┐
│  Layer 4: Toast / Tips   │  ← 最顶层提示
├──────────────────────────┤
│  Layer 3: Dialog / Modal │  ← 模态弹窗
├──────────────────────────┤
│  Layer 2: Panel / Page   │  ← 功能面板
├──────────────────────────┤
│  Layer 1: Scene UI       │  ← 场景内 UI（血条等）
├──────────────────────────┤
│  Layer 0: Background     │  ← 背景层
└──────────────────────────┘
```

**核心接口设计：**

```typescript
interface IUIManager {
  // 打开 UI
  open<T>(uiName: string, param?: any): Promise<T>;
  // 关闭 UI
  close(uiName: string): void;
  // 关闭所有
  closeAll(): void;
  // 返回上一页
  back(): void;
}

interface IUIPanel {
  // 生命周期
  onOpen(param: any): void;
  onClose(): void;
  onRefresh(param: any): void;
  // 栈管理
  canClose(): boolean;
  getUIName(): string;
}
```

**UI 栈示例：**

```
操作序列：
open("MainMenu") → open("Shop") → open("ItemDetail", {id: 101})

栈状态：[MainMenu, Shop, ItemDetail]
                                     ↑ 当前页

back() → [MainMenu, Shop]
                     ↑ 当前页，ItemDetail 被关闭和卸载
```

**动态加载策略：**

```typescript
class UIManager implements IUIManager {
  private loadedPanels: Map<string, IUIPanel> = new Map();
  private uiStack: string[] = [];
  
  async open<T>(uiName: string, param?: any): Promise<T> {
    let panel = this.loadedPanels.get(uiName);
    if (!panel) {
      // 按需加载预制体
      const prefab = await resources.load(`ui/${uiName}`);
      panel = instantiate(prefab).getComponent(UIPanel);
      this.loadedPanels.set(uiName, panel);
    }
    this.uiStack.push(uiName);
    panel.onOpen(param);
    return panel as unknown as T;
  }
  
  close(uiName: string) {
    const panel = this.loadedPanels.get(uiName);
    panel?.onClose();
    // 可选：从栈移除并卸载
    // this.loadedPanels.delete(uiName);
    // panel.node.destroy();
  }
}
```

### ⚡ 实战经验

- **常驻 UI vs 临时 UI**：主界面等常驻 UI 一次加载不卸载，二级页面用完即卸
- **打包策略**：常用 UI 打入首包，功能页按模块分包
- **动画统一管理**：所有 UI 打开/关闭走统一动画管理器，避免每个 UI 自己写
- **避免 UI 嵌套过深**：弹窗套弹窗套弹窗，维护和性能都有问题
- **自动化测试**：UI 框架应支持无动画模式，方便自动化测试

### 🔗 相关问题

- 观察者模式如何用在 UI 更新中？
- 如何设计资源管理策略？
