---
title: "Cocos Creator 富文本渲染原理是什么？RichText 组件、BBCode 解析与超链接交互实现"
category: "cocos"
level: 2
tags: ["富文本", "RichText", "BBCode", "UI系统", "渲染原理"]
related: ["cocos/label-font-rendering", "cocos/ui-system", "cocos/event-system"]
hint: "RichText 是怎么把 <color=#ff0000>红字</color> 渲染成带颜色的文字的？如何实现可点击的超链接？"
---

## 参考答案

### ✅ 核心要点

1. **富文本 = 分段 Label 拼装**：RichText 内部将带标记的文本拆分为多个 Label 节点，每段独立设置颜色/大小/样式
2. **BBCode 解析**：Cocos 使用类 BBCode 的标签语法（`<color>`, `<size>`, `<b>`, `<img>`），解析器逐字符扫描生成样式段
3. **超链接实现**：通过 `<link>` 或自定义标签 + 点击事件检测，判断点击坐标落在哪个文字段上
4. **性能代价**：富文本节点数随段数线性增长，长文本（500+ 字 + 大量样式标记）可能产生数百个子节点
5. **替代方案**：SDF 富文本（Signed Distance Field）可实现任意缩放无锯齿，但需自定义 Shader

### 📖 深度展开

#### RichText 渲染流程

```
原始文本: "Hello <color=#ff0000>World</color>!"
       ↓ BBCode 解析器
样式段数组:
  [
    { text: "Hello ",  color: default, size: default },
    { text: "World",   color: "#ff0000", size: default },
    { text: "!",       color: default, size: default }
  ]
       ↓ 布局排版引擎
计算每段尺寸 → 换行检测 → 位置排布
       ↓ 节点创建
为每个样式段创建 Label 节点
  Node_RichText
    ├── Label ("Hello ")  — 默认颜色
    ├── Label ("World")   — 红色
    └── Label ("!")       — 默认颜色
       ↓ 渲染提交
各 Label 独立渲染（无法合批，因颜色/字体可能不同）
```

#### 支持的 BBCode 标签

| 标签 | 示例 | 说明 |
|------|------|------|
| `<color>` | `<color=#ff0000>红</color>` | 指定文字颜色 |
| `<size>` | `<size=24>大字</size>` | 指定字号 |
| `<b>` | `<b>粗体</b>` | 粗体（需字体支持） |
| `<i>` | `<i>斜体</i>` | 斜体 |
| `<img>` | `<img src='icon'/>` | 行内图片 |
| `<outline>` | `<outline color='black' width=2>描边</outline>` | 文字描边 |

#### 超链接实现方案

**方案一：RichText 原生 link 事件（3.x）**

```typescript
import { RichText } from 'cc';

const richText = node.getComponent(RichText);
richText.string = '点击访问 <color=#0000ff><link=https://example.com>官方网站</link></color>';

richText.linkClickEvent = {
    target: this.node,
    component: 'ChatController',
    handler: 'onLinkClick',
};

// 回调处理
onLinkClick(event: EventHandler, link: string) {
    console.log('用户点击了链接:', link);
    // 可根据 link 内容执行不同逻辑
    if (link.startsWith('http')) {
        // 打开外部链接
        sys.openURL(link);
    } else if (link.startsWith('item:')) {
        // 自定义协议：点击道具链接弹出详情
        const itemId = link.split(':')[1];
        this.showItemTooltip(itemId);
    }
}
```

**方案二：自定义富文本组件（更灵活）**

```typescript
import { Node, Label, UITransform, Color, Vec3 } from 'cc';

interface RichSegment {
    text: string;
    color: Color;
    fontSize: number;
    isLink: boolean;
    linkData?: string;
    node?: Node;       // 运行时创建的渲染节点
    bounds?: { x: number; y: number; w: number; h: number };
}

@ccclass('CustomRichText')
export class CustomRichText extends Component {
    private _segments: RichSegment[] = [];
    private _labelNodes: Node[] = [];

    /** 设置文本（自定义解析） */
    setRichText(text: string): void {
        this.clear();
        this._segments = this.parseCustomMarkup(text);
        this.layout();
    }

    /** 点击检测 */
    onTouchEnd(event: EventTouch): void {
        const uiPos = event.getUILocation();
        const localPos = this.node
            .getComponent(UITransform)!
            .convertToNodeSpaceAR(new Vec3(uiPos.x, uiPos.y));

        for (const seg of this._segments) {
            if (!seg.isLink || !seg.bounds) continue;
            const b = seg.bounds;
            if (
                localPos.x >= b.x && localPos.x <= b.x + b.w &&
                localPos.y >= b.y && localPos.y <= b.y + b.h
            ) {
                this.onLinkTap(seg.linkData!);
                return;
            }
        }
    }
}
```

#### RichText vs Label 性能对比

| 维度 | Label（纯文本） | RichText（富文本） |
|------|----------------|-------------------|
| 节点数 | 1 个 | N 个（N = 样式段数） |
| DrawCall | 1（同字体同图集可合批） | N（不同颜色/样式通常不合批） |
| 内存 | 低 | 中（每段独立 Label 组件） |
| 排版开销 | 低（引擎内置） | 中（需解析 + 分段布局） |
| 适用场景 | 简短统一文本 | 聊天消息、道具描述 |

#### 性能优化策略

```typescript
// 优化1：富文本对象池（聊天列表场景）
export class RichTextPool {
    private _pool: Node[] = [];

    get(parent: Node): Node {
        let node = this._pool.pop();
        if (!node) {
            node = new Node('RichTextItem');
            node.addComponent(RichText);
            node.addComponent(UITransform);
        }
        node.parent = parent;
        node.active = true;
        return node;
    }

    put(node: Node): void {
        node.active = false;
        node.parent = null;
        // 清空文本内容，释放内部子节点
        const rt = node.getComponent(RichText)!;
        rt.string = '';
        this._pool.push(node);
    }
}

// 优化2：截断超长文本
function truncateRichText(text: string, maxLen: number = 200): string {
    // 先剥离标签计算纯文字数
    const plain = text.replace(/<[^>]+>/g, '');
    if (plain.length <= maxLen) return text;
    // 截断后追加省略号
    return text.substring(0, maxLen) + '...';
}
```

### ⚡ 实战经验

1. **聊天列表是 RichText 性能重灾区**：100 条聊天消息如果每条都有 3~5 个样式段，就是 300~500 个 Label 子节点。务必使用对象池复用 RichText 节点，只在数据变化时更新内容，不要每帧重建。

2. **`<img>` 标签的性能陷阱**：行内图片会创建额外的 Sprite 节点，大量 emoji 表情会显著增加节点数。对于高频出现的表情图标，考虑使用自定义字体（把表情做成字体图标），一个 Label 就能渲染。

3. **超链接点击区域的坑**：RichText 的 link 点击在多层嵌套 UI 中可能被父节点的事件拦截。确保超链接所在节点设置了 `BlockInputEvents`，或者手动处理事件冒泡，防止点击穿透到下层。

4. **中英文混排换行问题**：Cocos 的 RichText 对 CJK（中日韩）文本的换行处理在某些版本有 bug，特别是长英文单词嵌入中文段落时。如遇到异常断行，可以手动在合适位置插入零宽空格 `\u200B` 作为软换行点。

### 🔗 相关问题

- Label 的 SDF（Signed Distance Field）渲染方案与 RichText 能否结合？
- 如何实现聊天消息中的 @提及 高亮 + 点击查看用户资料？
- BMFont 富文本怎么做？位图字体支持富文本样式有哪些限制？
