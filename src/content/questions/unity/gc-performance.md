---
title: "Unity GC 和性能优化有哪些关键点？"
category: "unity"
level: 2
tags: ["性能优化", "GC", "内存"]
hint: "C# 的 Boehm GC 在游戏中是帧率杀手，如何减少 GC 分配？"
---

## 参考答案

### ✅ 核心要点

1. **避免频繁 new 对象**：在 Update/FixedUpdate 中 new 会触发 GC
2. **使用对象池**：复用 GameObject、List、数组等
3. **避免装箱**：值类型转引用类型产生 GC 分配
4. **缓存引用**：`GetComponent` 等调用缓存结果
5. **字符串拼接**：用 StringBuilder 替代 `+` 拼接

### 📖 深度展开

**Unity 的 GC 特性：**

Unity 使用 Boehm GC（非分代式），特点是：
- Stop-the-World：GC 时暂停所有线程
- 非压缩：不会整理内存碎片
- 每次全堆扫描：不区分新生代老年代

**常见 GC 陷阱与修复：**

```csharp
// ❌ 每帧 GC：闭包 +LINQ + 装箱
void Update() {
    var enemies = FindObjectsOfType<Enemy>()
        .Where(e => e.isActive)  // LINQ 产生 GC
        .OrderBy(e => e.hp);     // 排序产生 GC
    int damage = CalculateDamage();
    object boxed = damage;       // 装箱
    string msg = "HP: " + hp;    // 字符串拼接 GC
}

// ✅ 优化后
private List<Enemy> _cacheEnemies = new List<Enemy>(32);
private StringBuilder _sb = new StringBuilder(64);

void Update() {
    // 缓存集合，手动遍历
    _cacheEnemies.Clear();
    // ... 填充列表
    
    // 避免 boxing
    int damage = CalculateDamage();
    
    // StringBuilder
    _sb.Clear();
    _sb.Append("HP: ").Append(hp);
}
```

**Profiler 使用要点：**

1. **CPU Profiler**：定位耗时函数
2. **Memory Profiler**：查看 GC Alloc 列
3. **Deep Profile**：精确但开销大，只在开发阶段用
4. **Profile Analyzer**：对比两次 Profiler 数据

### ⚡ 实战经验

- **战斗场景 GC 目标**：战斗中 0 GC Alloc 是理想目标
- **协程的 GC**：`yield return new WaitForSeconds()` 每次产生 GC，缓存 WaitForSeconds 对象
- **foreach 警告**：旧版 Unity 的 foreach 在非 List 集合上产生 GC，Unity 2020+ 已修复
- **struct vs class**：频繁创建的小对象用 struct 避免堆分配

### 🔗 相关问题

- 对象池如何设计？
- Unity DOTS/ECS 如何从根本上解决 GC 问题？
