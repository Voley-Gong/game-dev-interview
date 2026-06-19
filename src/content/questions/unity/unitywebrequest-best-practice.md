---
title: "UnityWebRequest 的原理与最佳实践是什么？如何正确处理 HTTP 请求、文件上传下载和缓存？"
category: "unity"
level: 2
tags: ["网络通信", "资源加载", "移动端"]
related: ["unity/resources-load-vs-assetbundle", "unity/addressables-system"]
hint: "UnityWebRequest 是 Unity 官方的 HTTP 客户端，理解其异步模式、 disposed 时机和 UploadHandler/DownloadHandler 机制是关键。"
---

## 参考答案

### ✅ 核心要点

1. **UnityWebRequest 取代了旧版 WWW**：更灵活的 Handler 架构，支持流式上传下载，内存效率更高
2. **核心架构**：UnityWebRequest + UploadHandler + DownloadHandler，三者各司其职
3. **异步模式**：协程 `SendWebRequest()` + `yield return` 或 C# `async/await` + `task.GetAwaiter()`
4. **必须手动 Dispose**：UnityWebRequest 实现了 IDisposable，忘记释放会导致 native 内存泄漏
5. **移动端特殊考量**：需处理弱网重试、证书校验、后台下载中断、流量控制

### 📖 深度展开

#### 架构总览

```
UnityWebRequest（请求控制器）
├── url, method, headers, timeout
├── UploadHandler          ← 负责请求数据编码
│   ├── UploadHandlerRaw        (byte[] 原始数据)
│   ├── UploadHandlerFile       (文件路径)
│   └── UploadHandlerForm       (multipart/form-data)
├── DownloadHandler        ← 负责响应数据处理
│   ├── DownloadHandlerBuffer   (完整缓存到内存)
│   ├── DownloadHandlerFile     (直接写入文件)
│   ├── DownloadHandlerTexture  (直接生成 Texture2D)
│   ├── DownloadHandlerAudioClip (直接生成 AudioClip)
│   └── DownloadHandlerScript   (自定义派生类)
├── certificateHandler     ← HTTPS 证书校验
└── disposeCertificateHandlerOnDispose
```

#### 基础用法：GET / POST / JSON

```csharp
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using System.Runtime.CompilerServices;

// ─── 协程模式（传统）───
public class NetworkCoroutineExample : MonoBehaviour
{
    // GET 请求
    public void GetUserInfo(string userId)
    {
        StartCoroutine(GetUserInfoCoroutine(userId));
    }

    private IEnumerator GetUserInfoCoroutine(string userId)
    {
        string url = $"https://api.example.com/users/{userId}";
        using (var req = UnityWebRequest.Get(url))
        {
            req.SetRequestHeader("Authorization", $"Bearer {TokenManager.Token}");
            req.timeout = 10;

            yield return req.SendWebRequest();

            if (req.result == UnityWebRequest.Result.Success)
            {
                Debug.Log($"Response: {req.downloadHandler.text}");
            }
            else
            {
                Debug.LogError($"Error {req.responseCode}: {req.error}");
            }
        } // using 块结束时自动 Dispose
    }
}

// ─── async/await 模式（推荐）───
public static class NetworkAsyncHelper
{
    public static async System.Threading.Tasks.Task<string> GetAsync(string url)
    {
        using (var req = UnityWebRequest.Get(url))
        {
            req.timeout = 10;
            var task = req.SendWebRequest();
            while (!task.isDone)
            {
                await System.Threading.Tasks.Task.Yield();
            }

            if (req.result != UnityWebRequest.Result.Success)
            {
                throw new Exception($"Request failed: {req.error}");
            }
            return req.downloadHandler.text;
        }
    }

    // POST JSON
    public static async System.Threading.Tasks.Task<string> PostJsonAsync(
        string url, object payload)
    {
        string json = JsonUtility.ToJson(payload);
        byte[] bodyRaw = Encoding.UTF8.GetBytes(json);

        using (var req = new UnityWebRequest(url, "POST"))
        {
            req.uploadHandler = new UploadHandlerRaw(bodyRaw);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("Accept", "application/json");

            var task = req.SendWebRequest();
            while (!task.isDone)
                await System.Threading.Tasks.Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
                throw new Exception($"POST failed: {req.error}");

            return req.downloadHandler.text;
        }
    }
}
```

#### 文件下载：大文件流式写入

```csharp
// 大文件下载（避免 OOM：不要用 DownloadHandlerBuffer）
public IEnumerator DownloadLargeFile(string url, string savePath, 
    Action<float> onProgress = null)
{
    using (var req = UnityWebRequest.Get(url))
    {
        // DownloadHandlerFile 直接写入磁盘，不占内存
        req.downloadHandler = new DownloadHandlerFile(savePath);
        req.timeout = 0; // 大文件设为不限时

        var op = req.SendWebRequest();
        while (!op.isDone)
        {
            onProgress?.Invoke(op.progress);
            yield return null;
        }

        if (req.result != UnityWebRequest.Result.Success)
        {
            Debug.LogError($"Download failed: {req.error}");
        }
    }
}
```

#### 三种请求方式对比

| 方式 | 优点 | 缺点 | 适用场景 |
|------|------|------|------|
| WWW（已弃用） | 简单 | 无 Handler 灵活性、内存浪费多 | ❌ 不推荐 |
| UnityWebRequest + 协程 | 兼容性好、写法直观 | 不便取消、嵌套回调地狱 | 简单请求 |
| UnityWebRequest + async/await | 可链式调用、便于取消 | 需要额外封装 | 复杂业务逻辑 |

#### 移动端弱网处理策略

```csharp
// 带重试和超时的请求封装
public static async System.Threading.Tasks.Task<string> RequestWithRetry(
    string url, int maxRetries = 3, int timeoutSec = 10)
{
    for (int attempt = 0; attempt < maxRetries; attempt++)
    {
        try
        {
            using (var req = UnityWebRequest.Get(url))
            {
                req.timeout = timeoutSec;

                // 移动端：设置合理的超时
                var task = req.SendWebRequest();
                while (!task.isDone)
                    await System.Threading.Tasks.Task.Yield();

                if (req.result == UnityWebRequest.Result.Success)
                    return req.downloadHandler.text;

                // 网络错误才重试，HTTP 错误码（4xx/5xx）不重试
                if (req.result == UnityWebRequest.Result.ProtocolError)
                    throw new Exception($"HTTP {req.responseCode}: {req.error}");
                // ConnectionError → 继续重试
            }
        }
        catch (Exception e) when (attempt < maxRetries - 1)
        {
            Debug.LogWarning($"Attempt {attempt + 1} failed: {e.Message}");
            // 指数退避
            await System.Threading.Tasks.Task.Delay(1000 * (attempt + 1));
        }
    }
    throw new Exception($"Request failed after {maxRetries} attempts");
}
```

### ⚡ 实战经验

1. **务必用 `using` 包裹 UnityWebRequest**：即使 `SendWebRequest()` 失败了，底层的 native 资源（socket、buffer）也需要手动释放。不用 using 的话，在频繁请求场景下 native 内存会持续增长直到崩溃
2. **DownloadHandlerBuffer 有 OOM 风险**：下载 100MB 文件时，DownloadHandlerBuffer 会把整个文件加载到内存。大文件必须用 DownloadHandlerFile 流式写入磁盘，或自定义 DownloadHandlerScript 分块处理
3. **UnityWebRequest 在 GameObject 销毁后仍会完成请求**：如果在协程中发出请求但 GameObject 被销毁了，协程会被终止，但底层的 native 请求仍在继续。需要用 `CancellationToken` 或在 `OnDestroy` 中手动 `Abort()` 
4. **iOS ATS 限制**：iOS 默认禁止 HTTP 明文通信（App Transport Security）。如果后端没有 HTTPS，需要在 `Info.plist` 中配置 `NSAppTransportSecurity`，但上架审核可能会被拒。提前规划 HTTPS

### 🔗 相关问题

- UnityWebRequest 和 C# 的 HttpClient 有什么区别？Unity 中该用哪个？
- 如何实现断点续传（Range Request）下载 AssetBundle？
- Unity 中如何实现全局请求拦截器，统一处理 Token 刷新和错误码？
