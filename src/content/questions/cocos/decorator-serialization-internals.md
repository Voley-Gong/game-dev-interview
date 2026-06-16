---
title: "Cocos Creator 的 @ccclass 装饰器做了什么？组件注册与序列化底层原理详解"
category: "cocos"
level: 3
tags: ["装饰器", "序列化", "反射", "引擎原理", "TypeScript"]
related: ["cocos/script-lifecycle", "cocos/node-component-system", "cocos/asset-management"]
hint: "为什么编辑器能识别你的脚本组件？@ccclass 和 @property 背后发生了什么？"
---

## 参考答案

### ✅ 核心要点

1. **@ccclass 是注册器**：将类注册到引擎的 Class 系统（CCClass），让编辑器知道这个组件的存在
2. **@property 生成属性描述符**：声明属性的可见性、类型、默认值、分组，供编辑器面板和序列化使用
3. **序列化 = 对象 → JSON**：引擎将组件状态写入 scene/prefab 文件，反序列化时按描述符重建对象
4. **类型识别靠元数据**：编辑器通过 CCClass 的 metadata 判断组件类型、属性如何在 Inspector 面板展示
5. **自定义序列化**：通过 `Editor.Serializer` 或 `@serializable` 可以控制特定类型的序列化/反序列化行为

### 📖 深度展开

#### 装饰器执行时机

```typescript
// 你写的代码
@ccclass('PlayerController')
export class PlayerController extends Component {
    @property({ type: CCInteger })
    public maxHp: number = 100;

    @property({ type: SpriteFrame })
    public avatar: SpriteFrame | null = null;

    @property({ type: [Node], tooltip: '技能挂载点' })
    public skillNodes: Node[] = [];
}

// ────── 编译/加载后，装饰器函数执行 ──────

// 等价于引擎内部做了这些：
// 1. 注册类到 ClassFactory
ccclass('PlayerController')(PlayerController);

// 2. 为每个属性创建 AttrDescriptor
//    { name: 'maxHp', type: CCInteger, default: 100, ctor: Number }
//    { name: 'avatar', type: SpriteFrame, default: null, ctor: SpriteFrame }
//    { name: 'skillNodes', type: [Node], default: [] }
```

#### CCClass 注册信息结构

```typescript
// 引擎内部 ClassFmt 结构（简化）
interface ClassInfo {
    name: string;              // 'PlayerController'
    extends: string;           // 'cc.Component'
    properties: PropertyDef[]; // 属性描述列表
    ctor: Constructor;         // 构造函数引用
    scripts: boolean;          // 是否用户脚本
    // ... 生命周期、-editor 信息等
}

interface PropertyDef {
    name: string;              // 属性名
    type: TypeCtor;            // 类型构造器（CCInteger, Node, Vec3...）
    default?: any;             // 默认值
    readonly?: boolean;        // 是否只读
    visible?: boolean;         // Inspector 中是否显示
    tooltip?: string;          // 提示文字
    group?: string;            // Inspector 分组
    serializable: boolean;     // 是否参与序列化
    animatable: boolean;       // 是否可在动画面板编辑
}
```

#### 序列化与反序列化流程

```
=== 保存场景/预制体（序列化）===

组件实例 PlayerController:
  maxHp = 200
  avatar = SpriteFrame(uuid="abc123...")
  skillNodes = [Node(uuid="def456..."), Node(uuid="ghi789...")]
       ↓
遍历 CCClass 属性描述符
  → maxHp: serializable=true → 写入 { maxHp: 200 }
  → avatar: serializable=true → 写入 { avatar: { __uuid__: "abc123..." } }
  → skillNodes: serializable=true → 写入 { skillNodes: [{ __uuid__: "def456..." }, ...] }
       ↓
生成 Scene JSON:
{
  "__type__": "PlayerController",
  "maxHp": 200,
  "avatar": { "__uuid__": "abc123..." },
  "skillNodes": [
    { "__uuid__": "def456..." },
    { "__uuid__": "ghi789..." }
  ]
}

=== 加载场景/预制体（反序列化）===

读取 JSON → 根据 __type__ 查找 CCClass
       ↓
new PlayerController()  → 创建实例
       ↓
遍历属性描述符，逐个赋值：
  → 反序列化基本类型：instance.maxHp = 200
  → 反序列化引用类型：通过 uuid 从 AssetManager 查找资源 → 赋值
  → 反序列化节点引用：通过 uuid 从场景树查找 → 赋值
       ↓
反序列化完成，组件进入生命周期
```

#### @property 类型声明方式对比

```typescript
// 方式1：基本类型
@property(CCInteger)
hp: number = 0;

@property(CCString)
playerName: string = '';

// 方式2：引用类型（资源）
@property(SpriteFrame)
icon: SpriteFrame | null = null;

// 方式3：数组类型
@property([SpriteFrame])
frames: SpriteFrame[] = [];

// 方式4：节点引用
@property(Node)
targetNode: Node | null = null;

// 方式5：枚举
enum MoveState { Idle, Run, Jump }
@property({ type: CCInteger, enum: MoveState })  // 旧写法
@property({ type: Enum(MoveState) })              // 推荐写法
state: MoveState = MoveState.Idle;

// 方式6：完整属性描述符
@property({
    type: CCFloat,
    tooltip: '移动速度（像素/秒）',
    range: [0, 1000, 1],          // [min, max, step]
    slide: true,                    // Inspector 中显示为滑条
    group: { name: '战斗参数', id: 'battle', displayOrder: 1 }
})
moveSpeed: number = 200;

// 方式7：计算属性（不序列化）
@property({ visible: false })
get currentSpeed(): number {
    return this.moveSpeed * this.speedMultiplier;
}
```

#### 自定义序列化（进阶）

```typescript
import { _decorator, Component, deserialize } from 'cc';
const { ccclass, property } = _decorator;

// 场景：组件中有一个 Map 数据，默认不会序列化
@ccclass('InventoryComponent')
export class InventoryComponent extends Component {
    // 序列化时写入数组，运行时用 Map
    @property([CCInteger])
    private _itemIds: number[] = [];   // 序列化用

    @property({ visible: false })
    private _itemMap: Map<number, number> = new Map();

    // 反序列化后从数组重建 Map
    protected __preload(): void {
        for (const id of this._itemIds) {
            const count = this._itemMap.get(id) ?? 0;
            this._itemMap.set(id, count + 1);
        }
    }

    // 序列化前把 Map 转回数组
    protected onBeforeSerialize(): void {
        this._itemIds = Array.from(this._itemMap.keys());
    }
}
```

#### 装饰器 vs Unity 对比

| 维度 | Cocos Creator | Unity |
|------|---------------|-------|
| 类标记 | `@ccclass('Name')` | `[AddComponentMenu]`（可选） |
| 属性声明 | `@property(Type)` | `[SerializeField]` / `public` |
| Inspector 面板 | 由 `@property` 元数据驱动 | 由 `[SerializeField]` + 反射驱动 |
| 序列化格式 | JSON（.scene / .prefab） | YAML（.unity / .prefab） |
| 引用关系 | UUID（`__uuid__`） | GUID + FileID |
| 自定义序列化 | `Editor.Serializer` | `ISerializationCallbackReceiver` |

### ⚡ 实战经验

1. **`@property` 不要滥用！** 只标出需要在编辑器面板中配置的属性。内部逻辑用的变量用普通 `private` 声明即可，避免每次保存场景都写入无关数据。一个中型项目里大量不必要的 `@property` 可能让 .scene 文件膨胀 30%+。

2. **数组类型的坑**：`@property([Node])` 和 `@property({ type: Node })` 写法不同效果不同。前者声明数组，后者声明单引用。写成 `@property(Node)` + 类型 `Node[]` 在某些版本编辑器中无法正确识别数组类型，始终用 `[Type]` 语法最安全。

3. **循环引用问题**：A 组件引用 B 组件，B 又引用 A，序列化时引擎会检测并避免死循环，但反序列化时引用赋值的顺序不确定。在 `onLoad` 中不要假设引用已经可用，在 `start` 中做交叉初始化更安全。

4. **热更新脚本版本兼容**：如果通过热更新修改了组件的属性名或类型，旧版本序列化的 .prefab 数据会丢失。建议加 `@property({ formerlySerializedAs: 'oldName' })` 做向后兼容，或者在 `__preload` 里手动迁移旧数据。

### 🔗 相关问题

- Cocos Creator 的组件生命周期回调顺序是怎样的？`onLoad` → `start` → `onEnable` 的区别？
- 如何实现自定义 Inspector 面板（编辑器插件）来可视化编辑复杂组件？
- 热更新场景下，脚本版本变化导致反序列化失败怎么处理？
