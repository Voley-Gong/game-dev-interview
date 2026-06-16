---
title: "Cocos Creator 中如何设计弹窗与 UI 层级管理系统？"
category: "cocos"
level: 2
tags: ["UI架构", "弹窗管理", "层级控制", "设计模式"]
related: ["cocos/ui-system", "cocos/node-component-system", "cocos/scene-management"]
hint: "从单一弹窗到多层叠加、队列展示、遮罩穿透，如何系统化管理？"
---

## 参考答案

### ✅ 核心要点

1. **弹窗分层架构**：按优先级分层（HUD → 普通弹窗 → 系统弹窗 → 引导层 → 顶层 Loading）
2. **栈式管理**：后进先出的弹窗栈，支持返回关闭、批量关闭等操作
3. **遮罩与事件穿透控制**：不同层级的弹窗需要精确控制触摸事件穿透行为
4. **队列展示**：同时触发多个弹窗时排队，避免叠盖混乱
5. **生命周期钩子**：每个弹窗有 `onShow`/`onHide`/`onClose` 钩子，支持入场/出场动画

### 📖 深度展开

#### 1. UI 层级架构设计

```
Canvas (根节点)
├── Layer_GameWorld (z=-100)    ← 游戏世界: 地图、角色、特效
├── Layer_GameUI (z=0)          ← HUD: 血条、摇杆、技能按钮
├── Layer_Popup (z=100)         ← 普通弹窗: 设置、背包、商店
├── Layer_System (z=200)        ← 系统弹窗: 确认框、网络断连提示
├── Layer_Guide (z=300)         ← 新手引导遮罩
└── Layer_TopBar (z=400)        ← 全局 Loading、Toast 提示
```

每一层是一个常驻 Node 容器，弹窗通过 `parent` 切换实现层级管理：

```typescript
export enum UILayer {
    GameUI = 100,
    Popup = 200,
    System = 300,
    Guide = 400,
    TopBar = 500,
}

export class UIManager {
    private static layers: Map<UILayer, Node> = new Map();
    private static popupStack: UIBase[] = [];

    static init(root: Node) {
        // 创建各层级容器节点
        for (const [name, z] of Object.entries(UILayer)) {
            const layer = new Node(`Layer_${name}`);
            layer.addComponent(UITransform);
            layer.parent = root;
            layer.setPosition(0, 0, 0);
            layer.getComponent(UITransform)!.setSiblingIndex(Number(z));
            this.layers.set(Number(z) as UILayer, layer);
        }
    }
}
```

#### 2. 弹窗栈式管理

```typescript
// 弹窗基类
export abstract class UIBase extends Component {
    public layer: UILayer = UILayer.Popup;
    public modal: boolean = true;       // 是否显示遮罩
    public closeOnModal: boolean = true; // 点击遮罩关闭
    public priority: number = 0;         // 同层内优先级

    protected abstract onShow(params?: any): void;
    protected abstract onHide(): void;
    protected onClose(): void {}

    show(parent: Node) {
        this.node.parent = parent;
        this.onShow();
    }

    hide() {
        this.onHide();
        this.node.parent = null;
    }
}

// 弹窗管理器
export class PopupManager {
    private static stack: UIBase[] = [];
    private static queue: { type: any; params?: any }[] = [];
    private static maxConcurrent = 1; // 同层最多同时显示数

    // 打开弹窗
    static async open<T extends UIBase>(
        popupType: { prototype: T },
        params?: any
    ): Promise<T> {
        // 已有同类弹窗 → 复用
        const existing = this.stack.find(p => p instanceof popupType);
        if (existing) {
            existing.onShow(params);
            return existing as T;
        }

        // 队列控制：超过最大并发数则排队
        if (this.stack.filter(p => p.layer === UILayer.Popup).length >= this.maxConcurrent) {
            this.queue.push({ type: popupType, params });
            return null;
        }

        // 实例化并展示
        const node = new Node(popupType.name);
        const popup = node.addComponent(popupType);
        const layerNode = UIManager.layers.get(popup.layer)!;

        // 创建遮罩
        if (popup.modal) {
            this.createModal(layerNode, popup);
        }

        popup.show(layerNode);
        this.stack.push(popup);

        return popup;
    }

    // 关闭弹窗
    static close(popup: UIBase) {
        const idx = this.stack.indexOf(popup);
        if (idx < 0) return;

        popup.onClose();
        popup.hide();
        popup.node.destroy();
        this.stack.splice(idx, 1);

        // 处理队列中的下一个
        if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            this.open(next.type, next.params);
        }
    }

    // 关闭所有弹窗
    static closeAll(layer?: UILayer) {
        const toClose = layer
            ? this.stack.filter(p => p.layer === layer)
            : [...this.stack];

        toClose.reverse().forEach(p => this.close(p));
    }

    private static createModal(layer: Node, popup: UIBase) {
        const modalNode = new Node('Modal');
        modalNode.parent = layer;

        const sprite = modalNode.addComponent(Sprite);
        sprite.type = Sprite.Type.SIMPLE;
        // 设置半透明黑色背景
        modalNode.addComponent(BlockInputEvents); // 拦截下方触摸事件

        // 点击遮罩关闭
        if (popup.closeOnModal) {
            modalNode.on(Node.EventType.TOUCH_END, () => {
                this.close(popup);
            });
        }
    }
}
```

#### 3. 遮罩与事件穿透控制

| 场景 | 遮罩 | 下层交互 | 实现方式 |
|------|------|---------|---------|
| 确认对话框 | ✅ 半透明黑 | ❌ 拦截 | `BlockInputEvents` 组件 |
| Toast 提示 | ❌ 无遮罩 | ✅ 可交互 | 不加遮罩，设高 z-index |
| 新手引导 | ✅ 全屏暗 | ❌ 仅引导可点 | 自定义遮罩 + 穿透区域 |
| 设置面板 | ✅ 半透明 | ❌ 拦截 | `BlockInputEvents` |

**新手引导的镂空穿透**（高级技巧）：

```typescript
// 引导遮罩：在指定区域挖洞，允许穿透触摸
export class GuideMask extends Component {
    private holes: { x: number; y: number; w: number; h: number }[] = [];

    addHole(x: number, y: number, w: number, h: number) {
        this.holes.push({ x, y, w, h });
    }

    // 重写触摸事件：在洞内放行，洞外拦截
    _onTouchBegin(event: EventTouch) {
        const pos = event.getUILocation();
        for (const hole of this.holes) {
            if (Math.abs(pos.x - hole.x) < hole.w / 2 &&
                Math.abs(pos.y - hole.y) < hole.h / 2) {
                // 在洞内 → 不拦截，事件穿透到下层
                return false; // 不阻止冒泡
            }
        }
        // 在洞外 → 拦截
        return true;
    }
}
```

#### 4. 弹窗入场/出场动画管理

```typescript
export abstract class AnimatedPopup extends UIBase {
    private animDuration = 0.25;

    protected onShow() {
        // 入场动画：缩放 + 淡入
        this.node.setScale(0.8, 0.8);
        this.node.getComponent(UIOpacity)!.opacity = 0;

        tween(this.node)
            .to(this.animDuration, { scale: v3(1, 1, 1) }, { easing: 'backOut' })
            .start();
        tween(this.node.getComponent(UIOpacity)!)
            .to(this.animDuration, { opacity: 255 })
            .start();
    }

    protected async onHide() {
        // 出场动画：缩放 + 淡出（需等待完成后再销毁）
        return new Promise<void>((resolve) => {
            tween(this.node)
                .to(this.animDuration, { scale: v3(0.8, 0.8) }, { easing: 'backIn' })
                .call(() => resolve())
                .start();
            tween(this.node.getComponent(UIOpacity)!)
                .to(this.animDuration, { opacity: 0 })
                .start();
        });
    }
}
```

### ⚡ 实战经验

- **弹窗预制体不要放在场景里**：用 `resources.load` 或 `assetManager.loadBundle` 动态加载。场景内预放弹窗会导致场景文件膨胀，且切换场景时容易被误销毁
- **遮罩的 `BlockInputEvents` 一定要加**：曾遇到弹窗下方按钮依然响应点击的问题，根因就是忘了加遮挡组件。养成习惯：创建弹窗 → 检查遮罩 → 确认事件拦截
- **弹窗队列在联网游戏中尤为重要**：服务器推送多个 Tip/奖励弹窗时，不做队列管理会叠盖成一团。推荐用 `maxConcurrent=1` 串行展示，错开 0.3s 动画时间
- **z-index 的坑**：Cocos Creator 3.x 用 `setSiblingIndex` 控制同级排序。如果弹窗的 parent 不同，z-index 比较无效。务必确保同一层级的弹窗挂在同一个父节点下

### 🔗 相关问题

- Cocos Creator 的 UI 系统中，Widget 和 Layout 组件如何配合使用？
- 如何实现类似 MMO 游戏的多窗口拖拽管理？
- 弹窗系统如何与新手引导框架整合？
