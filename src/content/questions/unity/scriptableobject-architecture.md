---
title: "ScriptableObject 的本质是什么？在项目中如何正确使用？"
category: "unity"
level: 2
tags: ["ScriptableObject", "数据架构", "引擎架构"]
related: ["unity/monobehaviour-lifecycle", "unity/assetbundle-strategy"]
hint: "它既是数据容器，也是架构工具——关键在于区分「数据」和「逻辑」的边界。"
---

## 参考答案

### ✅ 核心要点

1. **ScriptableObject 是资产（Asset），不是场景中的实例**——数据存储在 `.asset` 文件中，内存中只有一份
2. **解决「数据副本问题」**——同一份配置被多个 MonoBehaviour 引用时，不会产生序列化副本
3. **编辑模式下可实时修改并生效**——无需进入 Play Mode 即可调参
4. **不适合存「运行时可变状态」**——它是共享数据，不是实例状态
5. **可与 MonoBehaviour、Addressables、编辑器扩展深度配合**

### 📖 深度展开

#### 本质：独立于场景的数据资产

```
传统方式（MonoBehaviour 内嵌数据）:
┌──────────────────────────┐
│  EnemyA (Scene)           │
│  - hp: 100                │  ← 每个实例各存一份
│  - attack: 15             │
│  - defense: 5             │
└──────────────────────────┘
┌──────────────────────────┐
│  EnemyB (Scene)           │
│  - hp: 100                │  ← 重复数据，内存浪费
│  - attack: 15             │
│  - defense: 5             │
└──────────────────────────┘

ScriptableObject 方式:
┌──────────────────────────┐
│  EnemyConfig.asset        │  ← 内存中只有一份
│  - hp: 100                │
│  - attack: 15             │
│  - defense: 5             │
└─────────┬────────────────┘
          │ 引用引用引用
   ┌──────┼──────┐
   ↓      ↓      ↓
EnemyA  EnemyB  EnemyC      ← 只持有引用，不存数据
```

#### 基本定义与使用

```csharp
// 1. 定义 ScriptableObject
[CreateAssetMenu(fileName = "EnemyConfig", menuName = "Game/Enemy Config")]
public class EnemyConfig : ScriptableObject
{
    [Header("基础属性")]
    public int maxHp = 100;
    public float attackPower = 15f;
    public float defense = 5f;

    [Header("AI 行为")]
    public AIType aiType = AIType.Aggressive;
    public float detectRange = 10f;

    [Header("视觉")]
    public Color tint = Color.white;

    public enum AIType { Passive, Aggressive, Defensive }
}

// 2. MonoBehaviour 引用 SO
public class Enemy : MonoBehaviour
{
    [SerializeField] private EnemyConfig config;

    private int currentHp;

    void Awake()
    {
        // 从 SO 读取初始值，运行时状态存在 MonoBehaviour 侧
        currentHp = config.MaxHp;
    }

    public void TakeDamage(float rawDamage)
    {
        float actual = Mathf.Max(0, rawDamage - config.Defense);
        currentHp -= Mathf.RoundToInt(actual);
    }
}
```

#### 经典架构模式：Strategy + ScriptableObject

```csharp
// 把「行为策略」做成 SO，实现多态而不用继承
public abstract class SkillBase : ScriptableObject
{
    public string skillName;
    public float cooldown;
    public Sprite icon;

    public abstract void Execute(GameObject caster, GameObject target);
}

// 火球术
[CreateAssetMenu(menuName = "Skills/Fireball")]
public class FireballSkill : SkillBase
{
    public float damage = 50f;
    public GameObject fireballPrefab;

    public override void Execute(GameObject caster, GameObject target)
    {
        var go = Instantiate(fireballPrefab, caster.transform.position, Quaternion.identity);
        go.GetComponent<Fireball>().Init(target, damage);
    }
}

// 治疗术
[CreateAssetMenu(menuName = "Skills/Heal")]
public class HealSkill : SkillBase
{
    public float healAmount = 30f;

    public override void Execute(GameObject caster, GameObject target)
    {
        var health = target.GetComponent<Health>();
        health?.Heal(healAmount);
    }
}

// 角色配置：技能槽位用 SO 列表
public class CharacterSkillController : MonoBehaviour
{
    [SerializeField] private List<SkillBase> skills;
    private float[] cooldowns;

    void Start()
    {
        cooldowns = new float[skills.Count];
    }

    public void CastSkill(int index, GameObject target)
    {
        if (cooldowns[index] > 0) return;
        skills[index].Execute(gameObject, target);
        cooldowns[index] = skills[index].cooldown;
    }
}
```

#### ScriptableObject vs MonoBehaviour 对比

| 维度 | ScriptableObject | MonoBehaviour |
|------|-----------------|---------------|
| 存储位置 | 项目资产（.asset 文件） | 场景/Prefab 内 |
| 内存份数 | 全局一份 | 每个实例一份 |
| 序列化副本 | 无（引用共享） | 有（值类型字段被复制） |
| 适合存什么 | 静态配置、共享数据 | 运行时状态、实例数据 |
| 编辑器内编辑 | Inspector 直接编辑，即时生效 | 需要在 Prefab/场景中编辑 |
| 打包后修改 | 不可修改（只读） | 可修改 |
| 与 Addressables 配合 | 完美（按需加载配置） | 不适用 |

#### 常见误用与修正

| ❌ 误用 | ✅ 正确做法 |
|--------|-----------|
| 把玩家当前血量存在 SO 里 | SO 存 maxHp，MonoBehaviour 存 currentHp |
| 用 SO 做存档系统 | SO 是只读资产，存档用 JSON/二进制 |
| 每个 Enemy 实例创建一个 SO 实例 | 共用一个 SO 资产，差异用字段覆盖 |
| 在 SO 的 OnEnable 里做场景逻辑 | SO 的生命周期独立于场景，不依赖场景状态 |

### ⚡ 实战经验

1. **SO + Addressables 是黄金组合**：把配置打包为 Addressable Asset，按需加载，版本更新只替换配置不需要重新出包
2. **注意 Build 后 SO 是只读的**：开发期间编辑器里改 SO 能即时生效，但打包后 SO 数据不可在运行时修改。需要持久化的运行时数据要另存（如 JSON / PlayerPrefs）
3. **用 SO 做事件总线（GameEvent 模式）**：定义 `GameEvent : ScriptableObject`，其他脚本监听/触发事件，实现模块解耦——但要注意事件的生命周期管理，避免内存泄漏
4. **大批量 SO 的创建用编辑器脚本自动化**：100 个敌人配置手动建 `.asset` 文件不现实，写 `AssetDatabase.CreateAsset()` 批量生成

### 🔗 相关问题

- ScriptableObject 和普通序列化类（[System.Serializable]）有什么区别？
- 如何用 ScriptableObject 实现事件驱动的架构？
- Addressables 加载的 ScriptableObject 如何做版本热更？
