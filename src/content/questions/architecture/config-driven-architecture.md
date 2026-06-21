---
title: "如何设计一个配置驱动的游戏架构？策划能改的逻辑为什么要走配置？"
category: "architecture"
level: 3
tags: ["配置驱动", "数据驱动", "ScriptableObject", "Excel 导表", "热重载", "类型安全", "架构设计"]
related: ["architecture/scriptableobject-architecture", "architecture/hot-update-architecture", "architecture/event-driven-vs-data-driven"]
hint: "配置驱动的本质是「把会变的逻辑从代码里剥离到数据里」——代码只定义「怎么执行」，配置决定「执行什么」。"
---

## 参考答案

### ✅ 核心要点

1. **配置驱动 = 代码定义「机制」，配置定义「内容」**：攻击系统是代码（怎么算伤害、怎么播放特效），100 把武器的数值/属性是配置。机制稳定（改一次），内容高频变（每周改），分离后策划改表不用程序员发包。
2. **核心收益是「发布解耦」**：数值/关卡/UI 文案走配置后，可走 CDN 热更或运行期重载，无需过 App Store 审核。中重度游戏运营 3 年不改包体是常态，靠的就是配置驱动。
3. **三条管线缺一不可**：①「编辑管线」（策划用 Excel/编辑器写）→ ②「导出管线」（Excel→JSON/二进制 + 校验）→ ③「加载管线」（运行期反序列化成强类型对象 + 索引缓存）。任何一环偷懒都会变成线上事故。
4. **类型安全是底线**：配置文件（JSON/CSV/Excel）本质是字符串，必须在「导出期」和「加载期」双重校验——ID 重复、数值越界、引用的目标不存在，都要在打包前报错，而不是玩家触发时才崩。
5. **「代码-配置-资源」三层分离**：代码 = 引擎逻辑（.dll，跟随版本），配置 = 玩法数据（.json/.bytes，可热更），资源 = 美术音频（.prefab/.png，可热更）。三层各自版本独立，是热更新架构的基础。

### 📖 深度展开

**1. 配置驱动的完整数据流**

```
┌──────────┐   导出    ┌──────────┐  打包   ┌──────────┐  热更   ┌──────────┐
│ Excel/   │ ────────▶ │ JSON/    │ ──────▶ │ AssetBundle│ ──────▶│ 客户端   │
│ 编辑器   │  校验+转换 │ 二进制   │  CDN    │ /热更包   │  下载   │ 运行期   │
└──────────┘           └──────────┘         └──────────┘         └──────────┘
   策划操作                程序校验             运营下发             反序列化
   (人读)                 (机器读)            (二进制流)          (强类型对象)

每层职责：
  Excel：人友好，策划改数值，带公式/批注/多 Sheet 联动
  JSON ：程序友好，强 schema，CI 自动校验 ID 唯一/数值合法
  二进制：运行期友好，体积小、解析快、可加密防解包
```

**2. 典型的「Excel → 强类型」导出代码**

```csharp
// 策划的 Excel（WeaponConfig.xlsx）：
// | id   | name    | atk | crit | skill_id | icon      |
// | 1001 | 木剑    | 10  | 0.05 | 0        | sword_01  |
// | 1002 | 火焰剑  | 25  | 0.15 | 2001     | sword_02  |

// 导出脚本生成的强类型 C# 类（或自动生成代码）
[Serializable]
public class WeaponConfig {
    public int Id;
    public string Name;
    public int Attack;
    public float CritRate;
    public int SkillId;        // 引用 SkillConfig 表的 ID
    public string IconAsset;   // 引用资源路径
}

// 运行期加载 + 索引（O(1) 查询，而非每次遍历）
public class ConfigManager {
    private Dictionary<int, WeaponConfig> _weapons;
    public void Load(byte[] bytes) {
        var list = MessagePackSerializer.Deserialize<List<WeaponConfig>>(bytes);
        _weapons = list.ToDictionary(w => w.Id);
    }
    public WeaponConfig GetWeapon(int id) => _weapons.TryGetValue(id, out var w) ? w : null;
}
// 业务代码只认强类型，不再碰字符串/原始 JSON
var weapon = ConfigManager.Instance.GetWeapon(1001);
player.Atk += weapon.Attack;
```

**3. 配置格式选型对比**

| 格式 | 人读 | 体积 | 解析速度 | 类型安全 | 策划友好 | 典型用途 |
|------|------|------|---------|---------|---------|---------|
| Excel/xlsx | ✅ | ❌ 大 | ❌ 慢 | ❌ 需导出 | ✅✅ 极好 | 策划编辑源 |
| JSON | ✅ | 🟡 中 | 🟡 中 | ❌ 需 schema | 🟡 一般 | 调试/小项目 |
| CSV | ✅ | ✅ 小 | ✅ 快 | ❌ 需导出 | 🟡 一般 | 简单数值表 |
| MessagePack/Protobuf | ❌ | ✅✅ 极小 | ✅✅ 极快 | ✅ 强 | ❌ | 上线正式配置 |
| Unity ScriptableObject | ✅(编辑器) | 🟡 | ✅ | ✅ | ✅(Unity内) | Unity 项目配置 |
| Lua/TS 脚本 | ✅ | 🟡 | 🟡 | ✅(脚本) | 🟡 程序员 | 需要逻辑的配置 |

**4. 「静态配置」vs「运行期配置」——Unity ScriptableObject 的位置**

```
ScriptableObject 适合「编辑期 + 引擎内」的配置：
  - 策划在 Unity Inspector 里改，所见即所得
  - 编辑器内热重载（改了立刻生效，无需 Play）
  - 但默认打进包体，热更要走 AssetBundle

Excel+二进制 适合「运营期 + 跨引擎」的配置：
  - 策划用 Excel，不打开 Unity
  - 导出后走 CDN 热更，无需重打 AssetBundle
  - 引擎无关（Cocos/Unity/自研引擎都能用）

成熟项目通常混用：
  - 技能/装备/关卡数值 → Excel + 二进制（高频运营改动）
  - 引擎层参数（渲染质量/输入映射）→ ScriptableObject（低频，跟版本走）
```

**5. 配置校验：导出期必须做的 5 件事**

```python
# 导出脚本的伪代码（CI 流程的一部分，发版前必跑）
def validate_weapon_config(rows):
    ids = set()
    for row in rows:
        # 1. ID 唯一性
        assert row.id not in ids, f"重复 ID: {row.id}"
        ids.add(row.id)
        # 2. 数值范围合法
        assert 0 < row.atk <= 99999, f"武器 {row.id} 攻击力越界"
        assert 0 <= row.crit <= 1.0, f"武器 {row.id} 暴击率必须是 0~1"
        # 3. 外键引用存在（skill_id 必须在技能表里）
        if row.skill_id != 0:
            assert row.skill_id in skill_ids, f"武器 {row.id} 引用了不存在的技能 {row.skill_id}"
        # 4. 资源路径存在（icon 必须真有这个文件）
        assert asset_exists(row.icon), f"武器 {row.id} 的图标资源缺失: {row.icon}"
        # 5. 命名规范（id 前缀匹配类型）
        assert row.name and len(row.name) <= 20, f"武器 {row.id} 名字为空或过长"
    # 6. 跨表一致性：初始武器必须在背包表里发放
    for starter in starter_weapons:
        assert starter in ids, f"新手武器 {starter} 在武器表中不存在"
# 任一 assert 失败 → CI 红灯 → 阻断发版，把错误挡在线下
```

**6. 反模式：把配置当数据库**

```csharp
// ❌ 危险：在配置表里塞运行期会变的状态
// WeaponConfig.xlsx 里加了 "current_durability" 列
public class WeaponConfig {
    public int CurrentDurability; // 当前耐久——这是运行期状态！
}
// 后果：
// 1) 玩家砍一刀，改了配置表的内存对象 → 下次加载又被覆盖
// 2) 多个玩家共享同一份配置对象 → 互相污染
// 3) 配置本该不可变（只读），混入状态后无法缓存/共享

// ✅ 正确：配置（只读、共享）与存档（可变、按玩家）分离
public class WeaponConfig { public int MaxDurability; }      // 配置：模板
public class WeaponInstance {                                 // 存档：实例
    public int ConfigId;
    public int CurrentDurability; // 运行期状态，存档里走
}
```

### ⚡ 实战经验

- **「配置即合约」——加列要走流程**：策划不能随便在 Excel 加列就生效，每列必须对应代码里的字段。建立"配置 Schema 版本号"，配置和代码不匹配时启动期直接报错，避免运行时 NullRef。
- **警惕配置膨胀**：一个表 500 列、单行 50KB 是项目晚期常见灾难。拆表原则：按访问模式分（战斗用/ UI 用/ 任务用各自一表），按频率分（常改的/冻结的分库），不要一个"总表"装天下。
- **本地化必须从配置第一天就考虑**：文案列绝不能写死中文，要从一开始就 `name_key → 本地化表查找`。后期把硬编码中文抠出来重做 i18n 是地狱级重构。
- **运行期热重载要带「版本号 + 兼容回退」**：线上热更配置时，老客户端可能拿不到新字段——配置类要给新字段默认值，或在加载时按 schema 版本分支处理。直接 `JsonConvert` 反序列化缺字段会崩。

### 🔗 相关问题

- ScriptableObject 和 Excel 导表各自适合什么场景？能否混用？
- 配置表的「热重载」如何实现？运行期替换配置对象时正在使用的逻辑怎么处理？
- 如何设计一个支持「数值公式 / 条件表达式」的配置系统（如伤害 = atk * (1 + crit) * skillMul）？
