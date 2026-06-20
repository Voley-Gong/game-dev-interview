---
title: "Unity WebGL 平台导出的特殊限制与性能优化策略"
category: "unity"
level: 2
tags: ["WebGL", "平台适配", "性能优化", "构建", "浏览器"]
related: ["unity/mobile-optimization", "unity/il2cpp-build-optimization", "unity/texture-compression-platform"]
hint: "把 Unity 游戏导出到 WebGL 需要注意什么？浏览器环境和原生 App 有哪些本质差异？"
---

## 参考答案

### ✅ 核心要点

1. **IL2CPP + WASM 编译**：WebGL 后端强制使用 IL2CPP 编译为 WebAssembly，不支持 Mono 运行时
2. **多线程限制**：浏览器中 WebAssembly 默认不支持真正的多线程（需 SharedArrayBuffer + COOP/COOP 头），Job System 和 Thread 在 WebGL 中受限
3. **内存上限严格**：浏览器对 WASM 的内存有硬限制（通常 2GB-4GB），需在 Player Settings 中设置合理的 `WebGLMemorySize`
4. **文件系统是虚拟的**：浏览器没有真实文件系统，`Application.streamingAssetsPath` 映射到虚拟 FS，`File.ReadAllText` 等同步 IO 不可用
5. **资源加载策略不同**：WebGL 必须使用 AssetBundle 或 Addressables 的远程加载模式，`Resources.Load` 内嵌资源会增加初始包体

### 📖 深度展开

#### WebGL 构建产物结构

```
Build/ 文件夹
├── Build.framework.js        ← 框架引导脚本
├── Build.framework.js.unityweb ← IL2CPP 编译的 WASM 模块（gz 压缩）
├── Build.loader.js           ← Unity 加载器
├── Build.data.unityweb       ← 序列化资源数据
├── Build.wasm                ← WebAssembly 二进制
└── TemplateData/             ← 页面模板（Logo/进度条等）
```

**加载流程：**
```
浏览器加载 loader.js
     ↓
加载 .framework.js（引导脚本）
     ↓
实例化 WASM 模块（AOT 编译的 C# → IL → C++ → WASM）
     ↓
加载 .data（资源数据 → IndexedDB 或内存）
     ↓
Unity 引擎初始化 → 进入首个场景
```

#### 多线程与异步限制

```csharp
// ❌ WebGL 中不可用
Thread t = new Thread(Work);       // System.Threading.Thread 不支持
ThreadPool.QueueUserWorkItem(Work); // 不支持

// ⚠ Job System 在 WebGL 中串行执行
// （即使写了 IJobParallelFor，也不会真正并行）
var job = new MyJob();
job.Schedule(arrayLength, 64).Complete(); // WebGL: 串行执行在主线程

// ✅ WebGL 中正确的异步方式：协程 / UniTask / async-await
async UniTaskVoid LoadDataAsync()
{
    var req = UnityWebRequest.Get(url);
    await req.SendWebRequest();
    // 处理结果
}

// ✅ WebGL Worker（Unity 2022.2+ 实验性支持）
// 需在 Player Settings 启用，且服务器必须配置：
// Cross-Origin-Opener-Policy: same-origin
// Cross-Origin-Embedder-Policy: require-corp
```

#### 各平台能力对比

| 能力 | Standalone (Windows/Mac) | Android/iOS | WebGL |
|------|------------------------|-------------|-------|
| 运行时 | Mono 或 IL2CPP | IL2CPP | IL2CPP→WASM |
| 多线程 | ✅ 完整支持 | ✅ 完整支持 | ⚠ 需 COOP/COEP 或串行 |
| 内存上限 | 系统内存 | 2-4GB | 2-4GB（浏览器限制） |
| 文件 IO | ✅ 自由读写 | ✅ 沙箱内 | ❌ 虚拟 FS，仅异步 |
| GPU | 完整支持 | 完整支持 | WebGL2（部分限制） |
| Shader | 全部 | 部分限制 | 不支持 Geometry/Compute Shader |
| 网络协议 | TCP/UDP/HTTP | TCP/UDP/HTTP | 仅 HTTP/WebSocket |
| 反射 | ✅ | ✅（AOT 有限） | ✅（IL2CPP，需 managed code stripping 配置） |

#### 内存优化关键配置

```
Player Settings → Player → WebGL：

1. WebGLMemorySize（堆内存大小）
   - 默认 350MB，可能不够
   - 建议根据项目实际峰值 ×1.2 设置
   - ⚠ 超过 2GB 可能在 32 位浏览器上崩溃

2. Code Optimization Level
   - "Size" → 更小的 WASM 体积，构建慢
   - "Speed" → 更大的 WASM 体积，运行更快
   - WebGL 推荐优先 "Size"（首屏加载时间关键）

3. Managed Stripping Level
   - High 或 Very High → 大幅减小包体
   - ⚠ 需要用 link.xml 保留反射需要的类型
```

#### 首屏加载优化策略

```
首屏加载优化链路：

1. 压缩格式选择
   Brotli（优先） > Gzip > 无压缩
   ↓
   服务器需配置 Content-Encoding: br

2. 资源分包（Initial Scene 精简）
   首场景 < 10MB（仅 UI + Logo）
   ↓
   后续场景通过 Addressables 按需加载

3. WASM 体积优化
   - Enable Managed Stripping: High
   - 移除未使用的引擎模块（Physics 2D、Video 等）
   - 使用 Code Optimization: Size
   ↓
   典型 WASM 体积：15-30MB（压缩后）

4. 加载体验
   - 自定义 Loader 模板（显示进度条 + 品牌）
   - 使用 InstantiateTemplate 自定义 HTML
```

#### WebGL 特有的代码适配

```csharp
// 检测 WebGL 平台
#if UNITY_WEBGL && !UNITY_EDITOR
    // WebGL 专属逻辑
    WebGLInput.captureAllKeyboardInput = true;
#endif

// 运行时判断
if (Application.platform == RuntimePlatform.WebGLPlayer)
{
    // 浏览器环境特殊处理
}

// ❌ WebGL 中不可用的 API
// - System.IO.File（同步文件操作）
// - System.Net.Sockets（TCP/UDP）
// - System.Drawing
// - 部分反射 Emit API

// ✅ 替代方案
// - 文件操作 → 使用 UnityWebRequest 或 Addressables
// - 网络通信 → WebSocket（NativeWebSocket 插件）
// - 本地存储 → PlayerPrefs 或 IndexedDB（JS 插件）
```

### ⚡ 实战经验

1. **WebGL 的 WASM 首次加载很慢**：典型中大型游戏 WASM 压缩后 20-40MB，移动端浏览器加载可能需 10-30 秒。务必用 Brotli 压缩 + 自定义加载进度条 + 首场景极致精简（< 5MB），后续资源按需远程加载
2. **Shader 兼容性是最大坑点**：WebGL2 不支持 Compute Shader、Geometry Shader，部分 Shader Model 5.0 特性也不可用。项目初期就需在 WebGL 平台验证 Shader 效果，避免后期返工。URP 基本兼容但部分高级 Feature（如 Deferred Rendering）不支持
3. **内存溢出（OOM）崩溃没有明确报错**：浏览器 WASM 内存超限会直接崩溃到黑屏或报 `Out of memory`。需在 Player Settings 合理设置 `WebGLMemorySize`，并在开发期用 Memory Profiler 监控峰值，预留 20% 余量
4. **服务器 MIME 类型和压缩头必须配对**：`.wasm` 文件需返回 `Content-Type: application/wasm`，`.br` 压缩文件需返回 `Content-Encoding: br`。配置错误会导致浏览器拒绝加载 WASM，表现为白屏。使用 Unity 官方的 `ServerTiming` 或 Nginx 模板配置

### 🔗 相关问题

- WebGL 项目中如何实现存档和读档？（IndexedDB / PlayerPrefs 的区别）
- Unity WebGL 如何与浏览器 JavaScript 互相调用？（jslib 机制）
- WebGL 平台如何做网络联机？（WebSocket 方案 vs HTTP 轮询）
