---
title: "游戏本地化（多语言）系统架构怎么设计？如何支持运行时切换和复杂文本格式？"
category: "architecture"
level: 3
tags: ["本地化", "多语言", "i18n", "Localization", "架构设计", "字体管理"]
related: ["architecture/config-driven-architecture", "architecture/asset-management-architecture", "architecture/ui-framework"]
hint: "本地化不是简单的 key→value 字典——涉及复数规则、RTL 排版、字体图集切换、富文本嵌入变量，还有一整套配置管线。"
---

## 参考答案

### ✅ 核心要点

1. **键值查找为核心**：所有 UI 文本通过 `LocalizationKey`（如 `ui.battle.attack`）引用，运行时根据当前语言查表返回对应文本。禁止在代码或预制体中硬编码任何可见字符串（包括 `Debug.Log` 中的提示也建议走 key），CI 门禁扫描硬编码字符串。
2. **复数与性别规则引擎**：不同语言的复数形式差异巨大——中文无复数变化、英语加 `s`、俄语有 3 种（1/2-4/5+）、阿拉伯语有 6 种。用 Unicode CLDR 复数规则（`one`/`few`/`many`/`other`）驱动，而非 `count > 1 ? "s" : ""` 的硬编码。
3. **占位符模板与变量嵌入**：支持 `{player} 击败了 {count} 个敌人` 式的模板字符串。不同语言中变量顺序可能颠倒（日语是 `{count}体の敵を倒した`），必须用命名占位符 `{player}` 而非位置占位符 `{0}`，更不能用字符串拼接。
4. **字体与图集管理**：CJK（中日韩）需要数千到数万字符的超大字符集，无法预生成完整 Bitmap Font 图集。用动态字体（Dynamic Font）按需渲染字形缓存到图集；阿拉伯语 / 泰语需要字形重塑（Shaping）和连字处理，必须使用支持复杂排版（HarfBuzz）的字体引擎。
5. **运行时热切换架构**：切换语言时遍历所有已注册的 `LocalizedText` 组件刷新显示，用事件驱动（`OnLanguageChanged` 广播）而非手动逐个更新。配合资源管理器按需加载新语言的字体图集和音频资源，避免启动时全量预载。

### 📖 深度展开

**本地化管线全流程：**

```
策划/文案 → Excel/Google Sheets（多语言对照表）
                    ↓ 导出脚本
            JSON / CSV / PO 格式
                    ↓ 构建管线
        ┌───── 验证器（CI 门禁）──────┐
        │ 1. Key 唯一性校验             │
        │ 2. 占位符完整性（{player}缺失）│
        │ 3. 长度溢出检查（对比基准语言）│
        │ 4. 特殊字符转义校验            │
        └───────────┬──────────────────┘
                       ↓ 打包
              二进制 LocalizationBundle
              ├── zh.strings（中文文本）
              ├── en.strings（英文文本）
              ├── ja.strings（日文文本）
              └── metadata.json（字体、RTL 标记）
                       ↓ 运行时
              LocalizationManager 查表 → 渲染到 UI
```

**复数规则引擎（CLDR Plural Rules）：**

```typescript
// CLDR 复数规则——按语言定义不同的判断逻辑
// 每种语言实现 PluralCategory 的映射
type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

// 中文：只有 other（1个敌人、2个敌人 都一样）
function plural_zh(n: number): PluralCategory { return 'other'; }

// 英语：one / other
function plural_en(n: number): PluralCategory {
  return n === 1 ? 'one' : 'other';
}

// 俄语：one / few / many / other（规则最复杂之一）
function plural_ru(n: number): PluralCategory {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'few';
  return 'many';
}

// 本地化文本表带复数后缀
const strings = {
  "ui.kill_count": {
    "zh":    { "other": "击败了{count}个敌人" },
    "en":    { "one": "Defeated {count} enemy",
               "other": "Defeated {count} enemies" },
    "ru":    { "one": "Повержен {count} враг",
               "few": "Повержено {count} врага",
               "many": "Повержено {count} врагов" },
  }
};

// 运行时查询
function t(key: string, params?: Record<string, any>): string {
  const entry = strings[key][currentLang];
  const category = pluralFuncs[currentLang](params?.count ?? 1);
  let template = entry[category] ?? entry['other'];
  return fillPlaceholders(template, params); // {count}→实际值
}
```

**占位符模板处理：**

```csharp
// 占位符替换——用命名占位符而非位置占位符
public static string Format(string template, Dictionary<string, object> args) {
    // 模板: "{player} 击败了 {count} 个敌人"
    // 英文: "{player} defeated {count} enemies"
    // 日文: "{player} が敵を{count}体倒した"（变量顺序不同！）
    foreach (var kv in args)
        template = template.Replace($"{{{kv.Key}}}", kv.Value.ToString());
    return template;
}

// ❌ 绝对禁止的做法: 字符串拼接
// text = player + " defeated " + count + " enemies";
// → 翻译无法改变变量顺序，日语德语等语序不同的语言必然出错

// ❌ 位置占位符也有坑: {0} {1} 在不同语言中可能需要交换顺序
// 正确: 用命名占位符 {player} {count}，翻译者可自由调整顺序
```

**多语言字体管理方案对比：**

| 方案 | 原理 | 内存占用 | CJK 支持 | RTL/连字 | 适用场景 |
|------|------|---------|---------|---------|---------|
| Bitmap Font | 预渲染所有字形到图集 | 固定（大） | ❌ CJK 图集过大 | ❌ 不支持 | 英文小游戏、像素风 |
| Dynamic Font | 按需渲染字形，LRU 缓存图集 | 动态（小） | ✅ 按需渲染 | ⚠️ 需扩展 | ✅ 通用首选 |
| SDF Font | 矢量距离场，任意缩放清晰 | 中等 | ✅ | ✅ HarfBuzz | UI 需多尺寸缩放 |
| 系统字体回退 | OS 原生字体引擎 | 零（用系统） | ✅ | ✅ | 移动端兜底方案 |

**运行时语言热切换流程：**

```
用户点击「切换为 English」
    ↓
1. LocalizationManager.SetLanguage("en")
    ↓
2. 卸载旧语言资源 (zh.strings, zh_font.atlas)
    ↓  ResourceService.Unload(langBundle)
3. 异步加载新语言资源 (en.strings, en_font.atlas)
    ↓  await ResourceService.LoadAsync("en_bundle")
4. 广播事件 OnLanguageChanged("en")
    ↓  EventBus.Emit("lang_changed", { lang: "en" })
5. 所有 LocalizedText 组件监听到事件 → 重新查表刷新
    ↓  foreach (var txt in registeredTexts) txt.Refresh();
6. RTL 语言额外触发布局重排（Arabic/Hebrew）
    ↓  LayoutRebuilder.ForceRebuild(layoutRoot);
```

### ⚡ 实战经验

- **翻译文本长度溢出是头号 Bug**：中文"攻击"2 字 → 英文 "Attack" 6 字符 → 德文 "Angriff" → 葡萄牙文 "Ataque" 可能换行。CI 门禁用基准语言（通常英文）长度 ×1.3 做溢出预警。某项目上线后发现德文按钮文字截断，紧急加了 Overflow→Ellipsis + Tooltip 兜底。
- **CJK 动态字体图集会膨胀**：一个大型 RPG 包含数万条文本，动态字体图集从初始 512×512 膨胀到 2048×2048，内存增加 **12MB**。方案：图集满了时用 LRU 淘汰冷字形（超过 10s 未使用的字形回收），配合分页图集（每页 256 字形）。
- **阿拉伯语 RTL 是地狱级需求**：RTL 文本中混入 LTR 变量（如数字、玩家名）会触发双向排版（Bidi Algorithm）。某游戏 UI 中 "{player}进入了房间" 的阿语版本，玩家名和房间名位置完全错乱。需要用 Unicode Bidi 控制字符（U+200E LRM / U+202B RLE）包裹 LTR 片段。
- **本地化测试要自动化**：人工覆盖 15 种语言 × 5000 条文本不现实。用"伪本地化"（Pseudo-localization）：在英文文本中自动加变音符号（`Ãttäck→Åttäçk`）并拉长 40%，提前暴露溢出和编码问题，不用等翻译完成就能测布局。

### 🔗 相关问题

1. 如何设计一个支持模组（Mod）自定义文本的本地化系统？（提示：多层 key 查找优先级——Mod 文本覆盖基础文本）
2. 游戏中语音配音和字幕如何与本地化系统协同？（提示：音频按语言分包，字幕走同一套 key→value 查找）
3. Excel 多语言翻译表如何做版本控制和协作冲突处理？（提示：按模块分 Sheet / 一行一 Key 减少合并冲突）
