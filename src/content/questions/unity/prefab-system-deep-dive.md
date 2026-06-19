---
title: "Unity Prefab 系统的原理是什么？Prefab Variant、嵌套 Prefab、Override 机制如何运作？"
category: "unity"
level: 2
tags: ["Prefab", "引擎架构", "资源管理"]
related: ["unity/scene-management-additive", "unity/serialization-system"]
hint: "Prefab 本质上是一种序列化模板，理解它的 override 优先级和实例化机制是关键。"
---

## 参考答案

### ✅ 核心要点

1. **Prefab 是一种序列化模板**，存储 GameObject 及其所有子对象和组件的完整结构快照
2. **Prefab Instance** 是模板在场景中的引用实例，修改会与原始 Prefab 进行差异比对
3. **Prefab Variant** 类似「子类继承」，基于基础 Prefab 派生，只记录差异部分
4. **Nested Prefab** 允许 Prefab 嵌套引用，形成树状依赖结构
5. **Override 系统有明确优先级**：实例级覆盖 > Variant 覆盖 > 基础 Prefab 定义

### 📖 深度展开

#### Prefab 的底层序列化原理

Unity Prefab 的核心是一个 `.prefab` 文件（YAML 格式的序列化文本），它存储了一个完整的 GameObject 子树：

```yaml
%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100000
GameObject:
  m_Name: Player
  m_Component:
    - component: {fileID: 400000}  # Transform
    - component: {fileID: 5000000} # MeshFilter
    - component: {fileID: 2300000} # MeshRenderer
--- !u!4 &400000
Transform:
  m_LocalPosition: {x: 0, y: 0, z: 0}
  ...
```

当你在场景中放置 Prefab Instance 时，场景文件只存储：
- 对源 Prefab 的引用（GUID + fileID）
- **覆盖（Overrides）的差异值**，而非完整结构

#### Prefab Variant 的继承链

```
Base Prefab (Enemy_Base)
  ├── HP: 100
  ├── Speed: 3.0
  └── Color: White
        ↑ 继承
Prefab Variant (Enemy_Fast)
  ├── Speed: 6.0  ← 覆盖
  └── Color: Red  ← 覆盖
        ↑ 继承
Prefab Variant (Enemy_Fast_Boss)
  └── HP: 500     ← 覆盖
  └── Scale: 2.0  ← 新增
```

Variant 的工作方式类似面向对象的继承：
- Variant **不能脱离 Base Prefab 存在**（删除 Base 会断链）
- 修改 Base Prefab 的属性会**自动传播**到所有 Variant
- Variant 中被覆盖的属性不会被传播覆盖

#### Override 的分类与优先级

| Override 类型 | 作用范围 | 典型场景 |
|--------------|---------|---------|
| **Added Component** | 实例新增组件 | 同一 Prefab 的不同敌人挂不同脚本 |
| **Removed Component** | 实例删除组件 | Boss 去掉 AI 脚本换成手动控制 |
| **Modified Property** | 修改属性值 | 调整某个实例的位置、颜色 |
| **Added GameObject** | 新增子物体 | 给某个实例加特效挂点 |
| **Reordered Children** | 调整子物体顺序 | UI 层级调整 |

**优先级规则：**
```
Scene Instance Override  >  Variant Override  >  Base Prefab Definition
```

即：场景中手动修改的属性优先级最高，会阻断 Variant 修改的传播。

#### 运行时实例化机制

```csharp
// Instantiate 实际上执行的是「深拷贝 + 解引用」
GameObject enemy = Instantiate(enemyPrefab, position, rotation);

// 内部流程：
// 1. 读取 Prefab 的序列化数据
// 2. 递归创建所有 GameObject 和 Component
// 3. 应用 Prefab 中存储的属性值
// 4. 建立父子层级关系
// 5. 如果是 Nested Prefab，递归实例化
// 6. 调用所有组件的 Awake() → Start()
```

#### Prefab 与内存的关系

```
Prefab Asset (磁盘/内存中的模板)
  ↓ Instantiate()
Prefab Instance (场景中的实例，各自独立)
  ↓ 修改属性
Override 数据存储在场景文件中
```

关键点：**每个 Instance 都有自己完整的内存副本**，Prefab Instance 之间不共享数据。这也是对象池模式存在的核心原因——避免反复 Instantiate 的内存分配开销。

### ⚡ 实战经验

1. **避免深层嵌套 Prefab**：超过 3 层的 Nested Prefab 会导致编辑器操作极慢（编辑器需要递归比对所有层的 Override），拆分或使用变体代替
2. **Variant 链断裂是灾难**：项目中曾有美术删除了基础 Prefab，导致上百个 Variant 断链变为「Missing Prefab」，恢复成本极高——用 Asset Validator 脚本定期检查断链
3. **运行时不要依赖 Prefab 结构**：`Instantiate` 后的实例与原始 Prefab 没有关联，无法通过 API 获取「来源 Prefab」，需要自己维护映射关系
4. **Prefab Mode 是救星**：Unity 2018.3 后的 Isolation Mode（Prefab Mode）让编辑嵌套结构不再痛苦，善用它可以避免场景被意外污染

### 🔗 相关问题

- Prefab Instance 与原始 Prefab 的属性同步机制是什么？运行时还能同步吗？
- 如何用代码动态创建和修改 Prefab Asset（而非 Instance）？
- Addressables + Prefab 的组合下，异步加载和实例化有哪些注意事项？
