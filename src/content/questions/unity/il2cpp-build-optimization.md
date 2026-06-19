---
title: "Unity IL2CPP 构建原理是什么？移动端如何优化？"
category: "unity"
level: 3
tags: ["IL2CPP", "构建", "移动端", "AOT"]
related: ["unity/hybridclr-hotfix", "unity/mobile-optimization"]
hint: "IL2CPP 不是简单的翻译，想想 AOT 编译、泛型实例化、GC 桥接各有何影响？"
---

## 参考答案

### ✅ 核心要点

1. **IL2CPP 本质**：将 C# IL 代码转译为 C++ 代码，再由各平台 C++ 编译器编译为原生机器码
2. **AOT 编译**：打包时全部代码已编译为原生代码，运行时无 JIT，启动快但包体大
3. **泛型实例化**：每个泛型组合在编译期展开，可能导致代码膨胀
4. **GC 桥接开销**：C# 对象与 C++ 对象之间通过 GC Bridge 同步生命周期，大量跨域引用会造成性能问题
5. **managed code stripping**：IL2CPP 会做死代码消除，但反射/动态类型可能被误删，需要 preserve 标注

### 📖 深度展开

#### IL2CPP 编译流水线

```
C# 源码 (.cs)
  ↓ C# 编译器 (Roslyn)
IL 中间语言 (.dll)
  ↓ IL2CPP.exe (Unity 内置工具)
C++ 源码 (.cpp/.h)
  ↓ 平台 C++ 编译器 (GCC/Clang/MSVC)
原生机器码 (.so/.a/.dylib)
  ↓ 打包进 APK/IPA
最终应用
```

#### 与 Mono 后端的对比

| 维度 | Mono (JIT) | IL2CPP (AOT) |
|------|-----------|--------------|
| 编译方式 | 运行时 JIT | 打包时 AOT |
| 运行性能 | 中等 | 高（原生代码，CPU 密集型提升 30-50%） |
| 包体大小 | 小 | 大（C++ 代码膨胀） |
| 启动速度 | 慢（JIT 预热） | 快 |
| 代码安全 | 易反编译 | 较难（C++ 符号） |
| 平台支持 | 部分平台 | iOS/Android/Console 全平台 |
| 热更新 | 支持 | 不直接支持（需 HybridCLR 等方案） |

#### 泛型实例化与代码膨胀

IL2CPP 在编译期为每个泛型类型组合生成独立的 C++ 代码：

```csharp
// 这三行会产生三份独立的代码实现
List<int> intList = new List<int>();
List<string> strList = new List<string>();
List<Vector3> vecList = new List<Vector3>();

// 值类型泛型尤其严重——每个值类型组合都会展开
Dictionary<int, Vector3> dict1;
Dictionary<string, float> dict2;
Dictionary<Guid, Matrix4x4> dict3; // 代码膨胀！
```

**膨胀控制策略**（`IL2CPPSetOptions` 或 `link.xml`）：

```xml
<!-- link.xml: 防止关键类型被 stripping 删除 -->
<linker>
  <assembly fullname="System">
    <type fullname="System.Collections.Generic.Dictionary`2" preserve="all"/>
  </assembly>
</linker>
```

#### managed code stripping（代码裁剪）

Unity 的 Managed Stripping 分为四个等级：

| 等级 | 行为 | 适用场景 |
|------|------|---------|
| Minimal | 几乎不删 | 开发期调试 |
| Low | 保守删除 | Release 预览 |
| Medium | 中等删除 | 生产环境默认 |
| High | 激进删除 | 包体敏感项目 |

**反射类代码的高危场景**：

```csharp
// ⚠️ High Stripping 下会被删除的类型
[Serializable]
public class DynamicData
{
    // 通过反射赋值，IL2CPP 可能找不到这个属性
    public int Score { get; set; }
}

// ✅ 解决方案 1：显式标注
[Preserve]
public class DynamicData { ... }

// ✅ 解决方案 2：link.xml 统一管理
// ✅ 解决方案 3：RuntimeInitializeOnLoadMethod 保证入口
```

#### GC Bridge 性能陷阱

IL2CPP 的 Boehm GC 在管理 C# → C++ 引用链时，需要遍历所有包装器对象：

```
触发 GC.Collect()
  ↓
Phase 1: 扫描 C# 堆
  ↓
Phase 2: 扫描 C++ 包装器（GC Bridge）
  ↓        ↑ 这一步是性能杀手
Phase 3: 标记存活对象
  ↓
Phase 4: 清理
```

**典型陷阱代码**：

```csharp
// ❌ 每帧创建大量 Unity 对象引用，导致 GC Bridge 爆炸
void Update()
{
    // 每帧 new 数组 → C# 对象 → 桥接到 C++
    var vertices = new Vector3[mesh.vertexCount];
    mesh.vertices = vertices;
}

// ✅ 缓存复用
private Vector3[] _vertexCache;

void Awake()
{
    _vertexCache = new Vector3[maxVertexCount];
}

void Update()
{
    // 复用已分配数组
    mesh.GetVertices(_vertexCache);
}
```

### ⚡ 实战经验

- **包体优化**：IL2CPP 产生的 C++ 代码约占包体 20-40%，`Stripping Level` 设为 High 可显著减小，但必须做反射回归测试
- **iOS 特别注意**：Apple 强制要求 IL2CPP（不支持 JIT），且 64 位架构下必须开启 IL2CPP
- **构建时间**：IL2CPP 的 C++ 编译阶段非常慢（大型项目 10-30 分钟），建议开发期用 Mono 后端，发布构建用 IL2CPP
- **崩溃排查**：IL2CPP 崩溃栈是 C++ 符号，需要 Unity 提供的符号文件（.sym）才能还原到 C# 代码，记得每次构建保留符号包

### 🔗 相关问题

- HybridCLR 是如何在不修改 IL2CPP 的前提下实现热更新的？
- 为什么 iOS 不允许 JIT，而 Android 可以？
- Unity 的 GC 为什么用 Boehm 而不是 SGen？对性能有什么影响？
