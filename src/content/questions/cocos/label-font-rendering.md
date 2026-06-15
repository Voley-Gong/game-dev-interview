---
title: "Cocos Creator 3.x Label 文本渲染与字体系统原理是什么？"
category: "cocos"
level: 2
tags: ["Label", "字体渲染", "UI系统", "BMFont", "TTF"]
related: ["cocos/ui-system", "cocos/drawcall-optimization"]
hint: "游戏中的文字渲染涉及多种字体方案，它们各有什么优劣？"
---

## 参考答案

### ✅ 核心要点

1. **三种字体类型** → System（系统字体）、TTF（TrueType）、BMFont（位图字体）
2. **渲染方式差异** → 系统字体走 Canvas 绘制光栅化；TTF 走引擎 FreeType 光栅化；BMFont 直接采样纹理
3. **Cache Mode 优化** → BITMAP / CHAR 两种缓存模式，减少重复纹理上传
4. **富文本 RichText** → 通过 `<color>`、`<size>` 等标签实现混合排版
5. **性能关键** → 大量 Label 是 DrawCall 杀手，需合批 + 限制动态文本更新

### 📖 深度展开

#### 三种字体方案对比

```
System Font（系统字体）
  → 调用平台原生文字渲染（浏览器 Canvas API）
  → 跨平台表现不一致（中文字体差异大）
  → 无需额外资源文件

TTF Font（TrueType 矢量字体）
  → 引擎加载 .ttf 文件，使用 FreeType 光栅化
  → 跨平台一致
  → 需要打包字体文件（中文字体体积大）

BMFont（位图字体 / AngelCode Font）
  → 离线渲染好的字符图集（.fnt + .png）
  → 渲染速度最快，无光栅化开销
  → 字符集固定，不支持动态多语言扩展
```

| 维度 | System | TTF | BMFont |
|------|--------|-----|--------|
| 渲染速度 | 慢 | 中 | 快 |
| 内存占用 | 低 | 中 | 高（纹理） |
| 清晰度（缩放） | 模糊 | 矢量缩放好 | 位图缩放差 |
| 中文支持 | ✅ 系统 | ✅ 需打包大文件 | ⚠️ 图集需预生成 |
| DrawCall | 高 | 中 | 低（可合批） |
| 适用场景 | 调试文本 | 游戏正文 | 分数/HUD数字 |

#### Cache Mode 详解

```typescript
import { Label, LabelOutline } from 'cc';

const label = node.addComponent(Label);
label.string = "Hello World";
label.fontSize = 32;

// Cache Mode 选择
label.cacheMode = Label.CacheMode.CHAR; // 推荐
```

**Cache Mode 对比：**

```
CacheMode.NONE（无缓存）
  → 每帧重新光栅化文字
  → 性能最差，但文本可随时变化
  → 适合：极高频率变化的文本（如计时器毫秒）

CacheMode.BITMAP（位图缓存）
  → 将整个 Label 渲染结果缓存为一张纹理
  → 文本内容不变时直接复用纹理
  → 适合：静态文本（按钮文字、标题）

CacheMode.CHAR（字符级缓存）
  → 将每个字符光栅化结果缓存为共享纹理图集
  → 不同 Label 之间可复用同字符缓存
  → 推荐默认使用，兼顾性能和灵活性
  → 限制：单字符纹理图集有上限，超大会丢失缓存
```

#### BMFont 制作与使用

**制作流程（使用 BMFont 工具）：**

```
1. 导出所需字符集（常用3500中文字 + 英文 + 数字 + 标点）
2. 设置字体大小（推荐 32/48/64 对应 1x/1.5x/2x）
3. 导出格式选择 Cocos 支持（.fnt + .png）
4. 如果需要多彩文字 → 导出多通道 BMFont
```

**代码中使用：**

```typescript
import { Label } from 'cc';

const label = node.addComponent(Label);
label.font = bmFontAsset;    // 加载的 BMFont 资源
label.string = "Score: 9999";
label.fontSize = 48;
label.useOriginalSize = false; // 缩放时保持引擎尺寸控制
```

#### 大量 Label 的性能优化

```typescript
// ❌ 反模式：每个数字位一个 Label，每帧更新
// 10 个 HUD 元素 × 60fps = 600 次纹理更新/秒

// ✅ 优化：减少 Label 数量 + 合理缓存
import { Label, Node, UITransform } from 'cc';

// 方案1：合并文本，用换行符代替多个 Label
const infoLabel = new Node('Info');
const label = infoLabel.addComponent(Label);
label.string = `HP: ${hp}\nMP: ${mp}\nEXP: ${exp}`;
label.cacheMode = Label.CacheMode.CHAR;

// 方案2：BMFont 数字 + 字符拼接
// 适合分数面板，预先用 BMFont 制作 0-9
```

#### 富文本 RichText

```typescript
import { RichText } from 'cc';

const richText = node.addComponent(RichText);
richText.string =
    '<color=#ff0000>HP: </color>' +
    '<color=#00ff00><b>100/100</b></color>\n' +
    '<size=20>等级 <color=#ffff00>Lv.5</color></size>';
```

**RichText 注意事项：**
- 内部为每个样式段创建独立 Label 节点，DrawCall 可能偏高
- 不支持嵌入式图片（用 Label + Sprite 拼接替代）
- 频繁更新的富文本（如战斗飘字）建议用 Label + 手动颜色控制替代

#### 中文字体打包策略

```typescript
// 方案：动态加载 TTF，避免包体过大
import { Font, resources } from 'cc';

// 按需加载字体 Bundle
resources.load('fonts/chinese_font', Font, (err, font) => {
    if (!err) {
        label.font = font;
        label.fontSize = 28;
    }
});
```

| 策略 | 包体影响 | 首屏体验 | 适用场景 |
|------|----------|----------|----------|
| 系统字体 | 无影响 | 不一致 | 原型/调试 |
| 内置 TTF | +3~10MB | 好 | 中文为主的游戏 |
| Bundle 按需加载 | 无影响 | 首次加载延迟 | 多语言游戏 |
| BMFont 常用字 | +1~2MB | 好 | HUD/分数 |

### ⚡ 实战经验

1. **DrawCall 是 Label 的头号杀手** — 多个不同字体的 Label 无法合批。统一使用同一种 BMFont 或 TTF 可大幅减少 DrawCall。特别是 UI 界面中十几处文字，切换为统一 BMFont 后 DrawCall 可从 15+ 降到 2-3
2. **CHAR cache 的纹理图集溢出** — 当使用大量不同字号 + 不同字体的字符时，字符缓存图集会不够用，表现为文字闪烁或消失。监控 `CC_DEBUG` 模式下的 cache miss 日志
3. **中文字体子集化** — 完整中文字体（如思源黑体）约 10MB+，使用 `font-spider` 或 `pyftsubset` 按项目实际用到的字符做子集化，通常可压缩到 1-2MB
4. **像素风游戏的 Bitmap Font** — 像素风游戏必须使用 BMFont 并关闭抗锯齿，设置 `label.enableOutline = false`，否则文字边缘会出现半透明像素，破坏像素艺术风格

### 🔗 相关问题

- Cocos Creator UI 系统的 Layout、Mask、富文本与性能优化？
- Cocos Creator 中 DrawCall 优化有哪些策略？
- 如何实现多语言文本切换与动态字体加载？
