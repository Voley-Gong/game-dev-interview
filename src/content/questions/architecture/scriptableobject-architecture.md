---
title: "ScriptableObject 在 Unity 架构中能解决哪些问题？有哪些典型用法和坑？"
category: "architecture"
level: 3
tags: ["ScriptableObject", "Unity", "数据驱动", "配置", "架构设计", "解耦"]
related: ["architecture/ecs-architecture", "architecture/object-pool", "architecture/event-driven-vs-data-driven"]
hint: "ScriptableObject 是 Unity 原生的「资产化数据容器」——既是配置文件，又能跨场景共享，还能当事件通道用。"
---

## 参考答案

### ✅ 核心要点

1. **资产化数据容器**：ScriptableObject（SO）是把数据存成 `.asset` 文件的对象，脱离 MonoBeahviour 实例独立存在，编辑器可视化配置，运行时直接引用。
2. **共享实例节省内存**：被多个 MonoBehaviour 引用的同一份 SO 在内存中只有一份拷贝，不像 prefab/MonoBehaviour 每个引用都复制一份数据。
3. **数据与逻辑分离**：SO 存配置数据，MonoBehaviour 读数据执行逻辑——天然实现「配置驱动」，策划改数值无需改代码。
4. **三大典型模式**：① 配置数据（武器/角色属性表）；② 运行时共享状态（全局游戏状态、玩家背包快照）；③ 事件通道（Event Channel）实现跨预制体解耦。
5. **坑点明确**：SO 不是存档系统（运行时改的值在退出后会回写到资产文件，Editor 下尤其危险）；不能直接序列化引用其他场景的 GameObject；Build 后资产只读。

### 📖 深度展开

**1. SO vs JSON/CSV 配置 vs Prefab 变量——为什么用 SO？**

```
MonoBehaviour 内 public 字段（最差）：
  每个角色身上挂一份"属性表" → 100 个敌人 = 100 份重复数据
  策划改数值要进预制体逐个改 → 人肉同步噩梦

JSON/CSV 外部配置：
  集中管理 ✓，但运行时需要解析、查找，无编辑器可视化
  引用资源（贴图/音效）只能存路径字符串，丢失强引用

ScriptableObject（推荐）：
  .asset 文件，编辑器里像改 Inspector 一样改数值 ✓
  跨实例共享单份数据 ✓
  可直接拖拽引用其他资产（贴图/预制体），强引用不丢 ✓
  AssetBundle 引用计数天然支持
```

**2. 配置数据模式：武器/角色定义**

```csharp
// 定义：纯数据的武器配置
[CreateAssetMenu(menuName = "Config/Weapon")]
public class WeaponConfig : ScriptableObject {
    public string weaponName;
    public int damage;
    public float attackRange;
    public float cooldown;
    public GameObject projectilePrefab; // 强引用，不会丢
    public AudioClip fireSound;
}

// 使用：MonoBehaviour 引用 SO 读取配置
public class WeaponController : MonoBehaviour {
    [SerializeField] private WeaponConfig config; // 拖入 .asset
    private float lastFireTime;

    public void TryFire() {
        if (Time.time - lastFireTime < config.cooldown) return;
        lastFireTime = Time.time;
        Instantiate(config.projectilePrefab, transform.position, transform.rotation);
        AudioSource.PlayClipAtPoint(config.fireSound, transform.position);
        // config.damage 由子弹脚本读取
    }
}
```

**3. 事件通道模式（Event Channel）——解耦预制体间通信**

这是 SO 最优雅的架构用法：用 SO 当「事件总线」，让两个互不引用的预制体通信。

```csharp
// 定义：一个空的事件 SO（只承载监听者列表）
[CreateAssetMenu(menuName = "Events/VoidEventChannel")]
public class VoidEventChannelSO : ScriptableObject {
    private UnityEvent onEventRaised = new UnityEvent();
    public void RaiseEvent() => onEventRaised?.Invoke();
    public void Register(Action listener) => onEventRaised.AddListener(() => listener());
    public void Unregister(Action listener) => onEventRaised.RemoveListener(() => listener());
}

// 触发方：玩家死亡时，不用知道 UI 在哪
public class PlayerHealth : MonoBehaviour {
    [SerializeField] private VoidEventChannelSO onPlayerDied;
    public void Die() => onPlayerDied.RaiseEvent();
}

// 监听方：UI 听到事件就弹结算界面，不用知道 Player 在哪
public class GameOverUI : MonoBehaviour {
    [SerializeField] private VoidEventChannelSO onPlayerDied;
    void OnEnable()  => onPlayerDied.Register(ShowGameOver);
    void OnDisable() => onPlayerDied.Unregister(ShowGameOver);
    void ShowGameOver() => /* 显示结算界面 */;
}
```

```
传统直接引用：              SO 事件通道解耦：
Player ──→ GameOverUI        Player ──→ [onDied SO] ←── GameOverUI
（强耦合，必须知道对方）       （双方只知道 SO，互不引用，可独立预制体化）
```

**4. 运行时共享状态模式（如全局游戏状态）**

```csharp
[CreateAssetMenu(menuName = "Runtime/GameState")]
public class GameStateSO : ScriptableObject {
    public int score;
    public int currentLevel;
    public bool isPaused;
    // 注意：Build 后运行时改这些值不会持久化，只在本局有效
}
```

**5. 三种典型用法对比**

| 用法 | 数据所有权 | 持久化 | 典型场景 |
|------|-----------|--------|---------|
| 配置数据（只读） | SO 本身 | 编辑器内编辑 | 武器/角色/关卡数值表 |
| 事件通道 | 监听者列表 | 无状态 | 预制体间解耦通信 |
| 运行时状态 | SO 字段 | ❌（Build 后不写盘） | 单局内全局状态快照 |

### ⚡ 实战经验

- **别用 SO 当存档系统**：SO 运行时修改的字段，Editor 下退出会回写 `.asset` 文件污染配置（坑过无数新人）；Build 后资产只读，改了也不保存。存档请用 JSON/二进制 + `Application.persistentDataPath`。
- **事件通道要注销监听**：`OnEnable` 注册就必须 `OnDisable` 注销，否则对象销毁后事件触发到已释放的委托 → NullRef / 内存泄漏。
- **运行时克隆 SO 做可变副本**：需要可改又不污染原资产时，用 `Instantiate(originalSO)` 创建运行时副本（如背包当前数量的快照），原 `.asset` 保持出厂默认值。
- **SO 不能引用场景内 GameObject**：SO 是资产不是实例，`public GameObject` 字段只能拖入预制体/资产，不能拖场景里的对象。需要场景引用就用事件通道或运行时注入。
- **大批量配置考虑地址化加载**：上百个 SO 全部直接引用会撑大初始包体和内存，配合 Addressables 按需加载更优。

### 🔗 相关问题

- ScriptableObject 和 JSON 配置在大型项目中如何取舍？能否混用？
- 如何用 ScriptableObject 实现一个可扩展的「技能/Buff 定义系统」（类似 RPG Maker 的技能编辑器）？
- 事件通道模式在跨场景通信时有哪些注意事项？
