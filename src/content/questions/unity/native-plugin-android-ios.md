---
title: "Unity 如何与 Android/iOS 原生层交互？原生插件开发的完整链路是怎样的？"
category: "unity"
level: 3
tags: ["移动端适配", "原生插件", "Android", "iOS", "JNI", "跨平台"]
related: ["unity/mobile-optimization", "unity/build-pipeline-player-settings", "unity/il2cpp-build-optimization"]
hint: "当你需要在 Unity 中调用系统级 API（如震动、通知、支付）时，C# 与 Java/Swift 之间是怎么通信的？"
---

## 参考答案

### ✅ 核心要点

1. **Android 交互**：通过 `AndroidJavaClass` / `AndroidJavaObject` 调用 Java（基于 JNI），或通过 `.aar`/`.jar` 插件 + C# P/Invoke 调用 Native 层
2. **iOS 交互**：通过 C/C++ `.a` / `.framework` 插件 + `DllImport` P/Invoke 直接调用 Objective-C/Swift 函数
3. **回调方向**：原生 → Unity 通常用 `UnitySendMessage`（通过 GameObject 名 + 方法名反射调用），或通过 C# delegate + 函数指针实现高效回调
4. **IL2CPP 的影响**：IL2CPP 不影响 JNI 调用，但会影响 `UnitySendMessage` 的性能（内部走字符串查找），高频回调建议用 `Function Pointer`（C# 9 函数指针）
5. **跨平台封装的最佳实践**：用 `#if UNITY_ANDROID && !UNITY_EDITOR` 条件编译 + 接口抽象，在 Unity 侧统一调用入口

### 📖 深度展开

#### Android 原生交互

```csharp
// 方式1：AndroidJavaObject（JNI 封装，简单但开销大）
using UnityEngine;

public class AndroidVibration
{
    public static void Vibrate(long milliseconds)
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        using (AndroidJavaClass unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
        using (AndroidJavaObject activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
        using (AndroidJavaClass vibrationClass = new AndroidJavaClass("android.os.Vibrator"))
        using (AndroidJavaObject vibrator = activity.Call<AndroidJavaObject>("getSystemService", "vibrator"))
        {
            long[] pattern = { 0, milliseconds };
            vibrator.Call("vibrate", pattern, -1);
        }
#endif
    }
}
```

```csharp
// 方式2：直接 P/Invoke C/C++ 插件（性能最高）
// C# 侧
[DllImport("native-plugin")]
private static extern void native_vibrate(int milliseconds);

// C++ 侧 (Android NDK)
#include <jni.h>
extern "C" void native_vibrate(int ms) {
    // 直接调 Android NDK API 或 JNI 反调 Java
}
```

#### iOS 原生交互

```csharp
// C# 侧 — 直接 P/Invoke Objective-C 编译的 .a / .framework
[DllImport("__Internal")]
private static extern void _iOSVibrate(int style);

// Objective-C 侧 (Plugin/IOSNative/VibrationPlugin.m)
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <CoreHaptics/CoreHaptics.h>

void _iOSVibrate(int style) {
    if (style == 0) {
        UIImpactFeedbackGenerator *generator = [[UIImpactFeedbackGenerator alloc]
            initWithStyle:UIImpactFeedbackStyleLight];
        [generator impactOccurred];
    } else {
        // CHHapticEngine 细粒度震动
    }
}
```

#### 原生回调 Unity 的方式

```csharp
// 方式1：UnitySendMessage（简单，但性能差 — 字符串反射）
// 原生侧调用：
// UnitySendMessage("GameManager", "OnNativeCallback", "{\"result\":\"success\"}");
// → 会调用 GameObject("GameManager") 上的 OnNativeCallback(string) 方法

// 方式2：函数指针回调（IL2CPP 推荐，高性能）
// C# 侧
public static unsafe delegate* unmanaged[Cdecl]<int, void> GetCallbackPtr()
{
    return &OnNativeEvent;
}

[AOT.MonoPInvokeCallback]
private static void OnNativeEvent(int code)
{
    Debug.Log($"Native callback: {code}");
}

// C++ 侧
typedef void (*CallbackFunc)(int);
static CallbackFunc g_callback = nullptr;

extern "C" void register_callback(CallbackFunc cb) {
    g_callback = cb;
}

extern "C" void on_some_event(int code) {
    if (g_callback) g_callback(code);
}
```

#### 三种交互方式对比

| 方式 | 方向 | 性能 | 适用场景 |
|------|------|------|----------|
| `AndroidJavaObject` (JNI) | C# → Java | 中等（每次调用有 JNI 开销） | 简单调用系统 API、第三方 SDK |
| `DllImport` (P/Invoke) | C# → C/C++ | 高 | 高频调用、图形/音频处理 |
| `UnitySendMessage` | Native → C# | 低（字符串 + 反射） | 低频回调（支付结果、推送） |
| Function Pointer | Native → C# | 高 | 高频数据流（传感器、相机帧） |
| `UnityWebRequest` + Local Server | C# ↔ Native | 低 | 复杂数据交换、非实时通信 |

#### 完整的跨平台封装架构

```csharp
// 接口层（平台无关）
public interface INativeService
{
    void Vibrate(int milliseconds);
    void ShowToast(string message);
    event Action<string> OnNotificationReceived;
}

// Android 实现
public class AndroidNativeService : INativeService
{
    private AndroidJavaObject _bridge;

    public AndroidNativeService()
    {
        _bridge = new AndroidJavaObject("com.company.game.NativeBridge");
    }

    public void Vibrate(int ms) => _bridge.Call("vibrate", ms);
    public void ShowToast(string msg) => _bridge.Call("showToast", msg);
    public event Action<string> OnNotificationReceived;
}

// iOS 实现
public class iOSNativeService : INativeService
{
    [DllImport("__Internal")] private static extern void _vibrate(int ms);
    [DllImport("__Internal")] private static extern void _showToast(string msg);

    public void Vibrate(int ms) => _vibrate(ms);
    public void ShowToast(string msg) => _showToast(msg);
    public event Action<string> OnNotificationReceived;
}

// 统一入口
public static class NativeServiceFactory
{
    public static INativeService Create()
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        return new AndroidNativeService();
#elif UNITY_IOS && !UNITY_EDITOR
        return new iOSNativeService();
#else
        return new EditorMockNativeService();
#endif
    }
}
```

### ⚡ 实战经验

- **AndroidJavaObject 必须 `using` 或手动 `Dispose()`**：JNI 对象持有的是 Java 层的 GlobalRef，不释放会导致 Java 堆内存泄漏，在低配 Android 设备上尤其明显
- **`UnitySendMessage` 只能在主线程调用**：原生侧的异步回调如果在线程中触发，必须用队列缓冲、在 Unity 主线程的 `Update` 中取出执行
- **iOS 插件的 Linker Flag**：用了第三方 framework（如微信 SDK），必须在 `Player Settings → iOS → Framework Dependencies` 或 `il2cpp_config` 中声明，否则 Link 时报 symbol not found
- **IL2CPP + strip 级别**：iOS 默认 Strip Engine Code 可能裁剪掉只被 P/Invoke 间接引用的 C# 方法，用 `[Preserve]` 特性或 `link.xml` 保护
- **安卓插件选择 `.aar` 而非 `.jar`**：`.aar` 能携带 `AndroidManifest.xml` 和资源文件，接入 SDK 时少踩很多坑

### 🔗 相关问题

- IL2CPP 编译模式下，JNI 调用的性能有什么变化？如何优化？
- 如何在 Unity Editor 中 Mock 原生插件行为，实现"无需真机即可调试"？
- Android Gradle 构建中，多个 `.aar` 插件冲突时如何解决依赖版本矛盾？
