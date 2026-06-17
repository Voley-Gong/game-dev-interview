---
title: "Unity 移动端性能优化要做哪些关键工作？从内存到发热的全链路方案"
category: "unity"
level: 3
tags: ["移动端优化", "性能优化", "内存管理", "Android", "iOS"]
related: ["unity/drawcall-batching", "unity/gc-performance", "unity/gpu-instancing"]
hint: "移动端的瓶颈不是算力，而是内存带宽和散热——降功耗比降帧数更重要。"
---

## 参考答案

### ✅ 核心要点

1. **内存是移动端第一杀手**——OOM Crash 远比帧率问题致命，必须建立全链路的内存预算和监控
2. **DrawCall 和 Shader 复杂度直接决定 GPU 功耗**——移动 GPU 的带宽是 PC 的 1/10
3. **GC 是帧率波动的元凶**——避免运行时堆分配，用对象池预分配一切热路径对象
4. **发热控制 = 功率控制**——目标不是「跑满 60fps」，而是「在 30fps 合适时降频保续航」
5. **构建配置和纹理压缩是「免费的优化」**——正确配置可以零成本省 30%+ 内存

### 📖 深度展开

#### 移动端性能优化的四大维度

```
                    移动端优化金字塔
                          ┌─────────┐
                          │ 发热/功耗 │  ← 最终体验：手机不烫、电池不崩
                       /─────────────\
                      │   帧率稳定性   │  ← 目标：稳帧而非高帧
                   /─────────────────\
                  │    GPU 渲染压力    │  ← 带宽、Overdraw、Shader 指令数
               /─────────────────────\
              │      CPU 逻辑与 GC     │  ← 主线程卡顿、GC Spike
           /─────────────────────────\
          │        内存占用与泄漏        │  ← OOM 是底线
       ────────────────────────────────
```

#### 1. 内存管理

```csharp
// ❌ 典型的内存问题代码
void Update()
{
    // 每帧分配 string → GC 噩梦
    string status = $"HP: {hp}/{maxHp}";

    // 每帧 new 数组 → 堆分配
    var colliders = Physics.OverlapSphere(transform.position, 5f);

    // LINQ 产生大量临时分配
    var nearby = enemies.Where(e => Vector3.Distance(e.position, transform.position) < 5f)
                        .OrderBy(e => e.hp)
                        .ToList();
}

// ✅ 优化后
private StringBuilder _statusBuilder = new(32);
private Collider[] _overlapBuffer = new Collider[32]; // 预分配
private List<Enemy> _nearbyBuffer = new(16);

void Update()
{
    // 复用 StringBuilder
    _statusBuilder.Clear();
    _statusBuilder.Append("HP: ").Append(hp).Append('/').Append(maxHp);
    string status = _statusBuilder.ToString();

    // 使用 NonAlloc 版本
    int count = Physics.OverlapSphereNonAlloc(transform.position, 5f, _overlapBuffer);

    // 手动遍历，无 LINQ
    _nearbyBuffer.Clear();
    for (int i = 0; i < count; i++)
    {
        var enemy = _overlapBuffer[i].GetComponent<Enemy>();
        if (enemy != null && (enemy.position - transform.position).sqrMagnitude < 25f)
            _nearbyBuffer.Add(enemy);
    }
    _nearbyBuffer.Sort((a, b) => a.hp.CompareTo(b.hp));
}
```

**内存预算参考（中端 Android 机型）：**

| 类别 | 预算上限 | 说明 |
|------|---------|------|
| 纹理 | 150-200 MB | 单张不超过 2048×2048 |
| 网格 | 30-50 MB | LOD0 顶点数 < 50k |
| 音频 | 30-50 MB | BGM 用 Streaming，SFX 用 Decompress On Load |
| 动画 | 20-40 MB | 使用 Keyframe Reduction |
| 脚本/托管堆 | 80-120 MB | GC 后托管堆应 < 80MB |
| **总计** | **300-400 MB** | 超过 400MB 在低端机上极易 OOM |

#### 2. 纹理与材质优化

```csharp
// 构建时自动检测超大纹理的编辑器脚本
public class TextureAuditor : AssetPostprocessor
{
    static void OnPostprocessAllTextures(string[] importedAssets)
    {
        foreach (var path in importedAssets)
        {
            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer == null) continue;

            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(path);

            // 检测：超过 2048 的纹理发出警告
            if (Mathf.Max(tex.width, tex.height) > 2048)
            {
                Debug.LogWarning($"[TextureAudit] 纹理过大: {path} " +
                    $"({tex.width}x{tex.height})，建议降至 2048 或以下");
            }

            // 检测：未使用 Mipmap 的 UI 纹理
            if (importer.textureType == TextureImporterType.Sprite && importer.mipmapEnabled)
            {
                Debug.LogWarning($"[TextureAudit] Sprite 启用了 Mipmap: {path}，UI 纹理通常不需要");
            }
        }
    }
}
```

**纹理压缩格式选择矩阵：**

| 平台 | 推荐格式 | 压缩比 | 质量 | 备注 |
|------|---------|--------|------|------|
| Android (主流) | ASTC 6×6 | ~8:1 | 好 | 2018+ 设备全支持 |
| Android (低端) | ETC2 | ~6:1 | 中 | 无 Alpha 时用 RGB |
| iOS | ASTC 6×6 | ~8:1 | 好 | A8+ 全支持 |
| iOS (旧) | PVRTC 4bpp | ~8:1 | 较差 | 仅旧设备 |

#### 3. GPU 渲染与功耗

**移动端 Shader 要点：**

```
移动端 GPU 特性（Mali / Adreno / PowerVR）:
- Tile-Based Deferred Rendering (TBDR) 架构
- 超低内存带宽 → 极怕 Overdraw
- 半精度浮点（half/fp16）比单精度快 2 倍
- 分支语句（if/else）开销远大于 PC

Shader 优化原则:
1. 使用 URP 的 Simple Lit 或 Unlit Shader
2. 避免复杂数学（pow, sin, noise），用 LUT 纹理替代
3. 尽量使用 half 精度
4. 减少采样器数量（移动端建议 ≤ 4 个贴图）
5. 关闭不需要的 Pass（如 Shadow Caster 对于小物体）
```

**Overdraw 检测：**
- Scene 视图 → Overdraw 模式查看
- 每个像素的理想 Overdraw < 3x
- 透明物体是 Overdraw 重灾区：粒子特效、半透明 UI

#### 4. 发热与功耗控制

```csharp
// 自适应帧率管理：根据设备状态动态降频
public class AdaptivePerformanceManager : MonoBehaviour
{
    [SerializeField] private int targetFrameRate = 60;
    [SerializeField] private float thermalThreshold = 45f; // 温度阈值

    private float _checkTimer = 0f;
    private int[] _fpsSteps = { 60, 45, 30 };

    void Update()
    {
        _checkTimer += Time.deltaTime;
        if (_checkTimer < 5f) return; // 每 5 秒检查一次
        _checkTimer = 0f;

        // 检测平均帧时间
        float avgFrameTime = Time.unscaledDeltaTime;
        float avgFps = 1f / avgFrameTime;

        // 如果实际帧率远低于目标，主动降目标帧率减少功耗
        if (avgFps < targetFrameRate * 0.7f)
        {
            int newIndex = Mathf.Max(0, System.Array.IndexOf(_fpsSteps, targetFrameRate) - 1);
            if (newIndex >= 0 && newIndex < _fpsSteps.Length)
            {
                targetFrameRate = _fpsSteps[newIndex];
                Application.targetFrameRate = targetFrameRate;
                QualitySettings.vSyncCount = 0;
                Debug.Log($"[AdaptivePerf] 降频至 {targetFrameRate} FPS");
            }
        }

#if UNITY_ANDROID
        // Android: 通过 BatteryStatus 检查温度
        CheckBatteryStatus();
#endif
    }

    [System.Diagnostics.Conditional("UNITY_ANDROID")]
    private void CheckBatteryStatus()
    {
        // 使用 Android Java 获取电池温度
        using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
        using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
        using (var intentFilter = new AndroidJavaObject("android.content.IntentFilter",
                   "android.intent.action.BATTERY_CHANGED"))
        using (var batteryIntent = activity.Call<AndroidJavaObject>("registerReceiver",
                   null, intentFilter))
        {
            if (batteryIntent != null)
            {
                int temp = batteryIntent.Call<int>("getIntExtra", "temperature", 0);
                float celsius = temp / 10f;
                if (celsius > thermalThreshold)
                {
                    Application.targetFrameRate = 30;
                    QualitySettings.SetQualityLevel(0); // 切到最低画质
                    Debug.LogWarning($"[AdaptivePerf] 设备过热 {celsius}°C，已降频");
                }
            }
        }
    }
}
```

#### 5. 构建优化清单

```
Player Settings:
├── Scripting Backend → IL2CPP（C# → C++ 编译，性能 + 安全）
├── API Compatibility Level → 仅 .NET Standard 2.1（减小包体）
├── Managed Stripping Level → High 或 Very High（裁剪未使用代码）
├── Shader Stripping → 开启（自动裁剪未引用的 Shader Variant）
└── Texture Compression → ASTC

Quality Settings (Per Platform):
├── Pixel Light Count → 1-2（移动端不需要多光源逐像素）
├── Anti Aliasing → Disabled 或 2x（MSAA 开销大）
├── Shadow → 关闭或 Hard Shadows Only
├── Shadow Distance → 20-30m
└── VSync → 关闭（用 Application.targetFrameRate 替代）

Build:
├── Development Build → 仅调试时用
├── Compression Method → LZ4 或 LZ4HC
└── Strip Engine Code → ✅ 开启
```

### ⚡ 实战经验

1. **先 Profile 再优化，永远不要盲目优化**：Unity Profiler 的 Device Connection（无线/有线真机调试）是定位瓶颈的金标准。90% 的性能问题不是你想的那个。在真机上跑一遍 Deep Profile，看实际耗时分布
2. **托管堆增长（Managed Heap Growth）是最隐蔽的敌人**：即使总内存没超限，GC 触发时的卡顿可能长达 50-200ms。在真机 Profile 时关注 `GC.Alloc` 列，目标是 Update 中每帧 0B 分配。用 `Profiler.GetTotalAllocatedMemoryLong()` 做运行时监控
3. **不要在低端机上追求 60fps**：骁龙 6 系/天玑 800 以下机型主动降到 30fps，配合降画质，反而体验更好——卡顿的 45fps 远不如稳定的 30fps
4. **AssetBundle / Addressables 的内存要双重检查**：加载的资源卸载遗漏是移动端内存泄漏的头号原因。确保每个 `Addressables.LoadAssetAsync` 都有对应的 `Addressables.Release`，用 `Addressables.LoadedAssetCount` 监控

### 🔗 相关问题

- 如何使用 Unity Profiler 进行真机远程性能分析？
- IL2CPP 和 Mono 后端在性能和包体上的具体差异？
- 移动端如何做内存泄漏的自动化检测？
