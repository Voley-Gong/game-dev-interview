---
title: "游戏多端适配架构怎么设计？一套代码怎么同时跑在 PC、移动端和主机上？"
category: "architecture"
level: 4
tags: ["多端适配", "跨平台", "架构设计", "输入抽象", "渲染分级", "UI适配"]
related: ["architecture/ui-framework", "architecture/scene-management-architecture", "architecture/config-driven-architecture"]
hint: "不是「用 #if 判断平台写分支」——是「把平台差异收敛到抽象层（输入/渲染/UI/资源），上层逻辑只面向接口编程，差异通过配置和能力查询在运行时切换」。"
---

## 参考答案

### ✅ 核心要点

1. **平台差异必须收敛到抽象层**：不要在业务代码里散落 `#if UNITY_ANDROID` 这类平台宏。把差异封装到 InputProvider、RenderBackend、PlatformService 等接口后面，上层逻辑只面向接口编程。一个中型项目后期散落 300+ 处平台宏是头号维护噩梦，改一个功能要全工程搜索。
2. **输入层抽象是第一道关卡**：PC（键鼠）、移动端（触摸/虚拟摇杆）、主机（手柄/按键映射）的输入模型完全不同。统一抽象成 InputAction（语义动作如「攻击」「移动」）+ InputDevice（物理设备），用「动作映射表」解耦「玩家按了什么物理键」和「游戏响应什么逻辑」，新增手柄只需加映射不改业务代码。
3. **渲染分级（Render Tier）按设备性能降级**：高端 PC 跑 4K + 全后效，移动端跑 720p + 简化 shader，低端机进一步关阴影、降 draw distance。用能力查询（GPU 等级/内存/带宽）在运行时自动选 tier，而不是按平台硬编码——同一平台的不同机型性能差异可能达 10 倍。
4. **UI 适配要做「锚点 + 安全区 + 缩放策略」三件套**：不同设备分辨率和宽高比差异巨大（手机 19.5:9，iPad 4:3，超宽屏 21:9）。用锚点对齐 + SafeArea 避让刘海/手柄安全区 + 动态缩放策略（Match Width Or Height），绝不能用绝对像素坐标布局 UI。
5. **资源按平台分包，加载策略分级**：主机用原生高精度纹理，移动端用压缩格式（ASTC/ETC2），PC 用 DXT/BC7。同一资产准备多份变体，按平台加载对应变体，配合 Addressables 分平台打包。纹理格式选错会让包体膨胀 4-5 倍。
6. **构建管线要分平台配置而非手动切换**：每个平台有自己的签名、图标、权限、编译宏配置。用 CI/CD 矩阵（GitHub Actions/GitLab matrix build）自动出多端包，而不是开发者在本地手动切 Build Settings——手动切换漏配权限/签名是发版事故的常见来源。

### 📖 深度展开

#### 1. 输入抽象层设计

输入系统的核心是把「玩家按了什么物理键」和「游戏要响应什么逻辑」彻底解耦。统一用 `InputAction`（语义动作）+ `InputDevice`（物理设备）+ `InputActionMap`（映射表）三层建模，业务代码只查询 `InputAction` 的状态，永远不直接读物理键码。

```typescript
// 语义动作枚举——与设备无关，业务层只认这些
enum InputAction {
  Move = "Move",         // 移动（带方向轴）
  Attack = "Attack",     // 攻击
  Jump = "Jump",         // 跳跃
  Interact = "Interact", // 交互
  Cancel = "Cancel",     // 取消
}

// 物理设备抽象接口——每个平台一个实现
interface InputDevice {
  pollAxis(axis: string): number;          // 读取轴向输入（摇杆/WASD）
  getButtonDown(action: InputAction): boolean;
  getAxis(action: InputAction): number;
}

// 设备绑定描述：把物理输入映射到语义动作
interface DeviceBinding {
  axisSource?: string;   // 物理轴名，如 "LeftStickX"
  buttonSource?: string; // 物理键名，如 "FaceBtnDown/A"
  scale?: number;        // 灵敏度缩放
}

// 动作映射表：Record<语义动作, 设备绑定>
type InputActionMap = Record<InputAction, DeviceBinding>;
// 移动端虚拟摇杆映射到 Move
const mobileJoystickMap: InputActionMap = {
  [InputAction.Move]:     { axisSource: "VirtualJoystick" },
  [InputAction.Attack]:   { buttonSource: "ScreenBtnA" },
  [InputAction.Jump]:     { buttonSource: "ScreenBtnB" },
  [InputAction.Interact]: { buttonSource: "ScreenBtnX" },
  [InputAction.Cancel]:   { buttonSource: "ScreenBtnY" },
};

// 主机手柄同样映射到 Move——业务层完全无感
const consoleGamepadMap: InputActionMap = {
  [InputAction.Move]:     { axisSource: "LeftStick", scale: 1.0 },
  [InputAction.Attack]:   { buttonSource: "FaceBtnDown" },
  [InputAction.Jump]:     { buttonSource: "FaceBtnRight" },
  [InputAction.Interact]: { buttonSource: "FaceBtnLeft" },
  [InputAction.Cancel]:   { buttonSource: "FaceBtnUp" },
};
```

| 设备类型 | 典型输入 | 映射到 InputAction | 注意事项 |
| --- | --- | --- | --- |
| 键鼠 (PC) | WASD + 左键 | Move / Attack | 鼠标有 2D 坐标，需射线检测转世界坐标 |
| 触摸摇杆 (移动) | 虚拟摇杆 + 屏幕按钮 | Move / Attack | 触摸多点要分指位，避免误触 |
| 手柄 (主机) | 左摇杆 + 面键 | Move / Attack | 死区（deadzone）必须配，摇杆漂移是常态 |
| 键盘+手柄混合 (PC) | 任一设备 | 全部动作 | 同时支持热插拔，最后输入设备决定 UI 提示图标 |

#### 2. 渲染分级架构

不要按平台硬编码画质（Android≠低画质，旗舰机比老 PC 还强）。应运行时查询 GPU 能力（显存、填充率、屏幕分辨率）自动选 tier，同时支持配置文件手动覆盖。

| Tier | 目标设备 | 分辨率 | 后处理 | 阴影 | Draw Distance | 纹理精度 |
| --- | --- | --- | --- | --- | --- | --- |
| Tier0 | 高端 PC | 4K / 原生 | 全开（Bloom/DOF/Motion Blur/TAA） | 软阴影 + 级联 | 2000m+ | 原生（8K） |
| Tier1 | 主流 PC / PS5 | 1440p | 大部分开 | 硬阴影 + 级联 | 1500m | 高（4K） |
| Tier2 | 高端移动 | 1080p | Bloom + 简化 TAA | 单级硬阴影 | 800m | 中（2K） |
| Tier3 | 低端移动 | 720p | 关闭 | 关闭 | 400m | 低（1K） |

```typescript
type RenderTier = 0 | 1 | 2 | 3;

// 能力查询：综合显存、GPU 等级、屏幕分辨率判定 tier
function detectRenderTier(sysInfo: SystemInfo, configOverride?: number): RenderTier {
  if (configOverride !== undefined) return configOverride as RenderTier; // 配置强制覆盖
  const gpuMemMB = sysInfo.gpuMemoryMB;     // GPU 显存
  const fillRate = sysInfo.gpuFillRate;     // 像素填充率评分
  const screenPixels = sysInfo.screenWidth * sysInfo.screenHeight;

  if (gpuMemMB >= 8000 && fillRate > 8000) return 0;   // 高端 PC
  if (gpuMemMB >= 4000 && fillRate > 4000) return 1;   // 主流 PC / PS5
  if (gpuMemMB >= 2048 && screenPixels >= 1920 * 1080) return 2; // 高端移动
  return 3; // 低端移动兜底
}

// 运行时由 RenderBackend 读取 tier 并切换画质参数
const tier = detectRenderTier(SystemInfo, gameConfig.forcedTier);
RenderBackend.applyTier(tier); // 内部根据 tier 设置分辨率缩放、后效开关、阴影距离等
```

#### 3. UI 适配三件套

UI 适配靠三根支柱：**锚点对齐**（Anchor，相对父节点定位）、**安全区**（SafeArea，避让刘海/Home Indicator/手柄安全区）、**缩放策略**（Scale Strategy，决定 Canvas 如何随分辨率缩放）。三者缺一不可。

```
┌─────────────────────────┐
│░░░░░░ Notch ░░░░░░░░░░░░│ ← 刘海区（非安全）
│   ┌─────────────────┐   │
│   │   HUD (顶中)    │   │ ← 锚点 TopCenter + SafeArea 偏移
│   │   HP / 小地图   │   │
│   └─────────────────┘   │
│                         │
│ ┌───┐                   │
│ │摇杆│                  │ ← 锚点 BottomLeft（不在安全区内，但无遮挡）
│ └───┘                   │
│                         │
│░░░░ Home Indicator ░░░░░│ ← 底部手势条（非安全）
└─────────────────────────┘
  安全区 = 屏幕内缩刘海高度 + 底部 34pt
```

```typescript
// SafeAreaFitter：读取设备安全区 insets，调整 RectTransform 的 padding
@Component
class SafeAreaFitter {
  @property(RectTransform) target: RectTransform;

  onEnable() {
    this.applySafeArea();
    // 监听屏幕旋转/分屏变化
    Screen.onResolutionChanged.add(this.applySafeArea, this);
  }

  private applySafeArea() {
    const insets = PlatformService.getSafeAreaInsets(); // {top,bottom,left,right} in px
    this.target.offsetMin = new Vector2(insets.left, insets.bottom);
    this.target.offsetMax = new Vector2(-insets.right, -insets.top);
  }

  onDisable() {
    Screen.onResolutionChanged.remove(this.applySafeArea, this);
  }
}
```

| 缩放策略 | 适用场景 | 行为 |
| --- | --- | --- |
| Match Width | 竖屏手游（保持宽度铺满） | 宽度固定，高度按比例裁剪，宽高比变化时上下留白/裁剪 |
| Match Height | 横屏固定高度（视觉小说） | 高度固定，宽度按比例，宽屏时左右留白 |
| Match Width Or Height | 通用混合（推荐） | 取宽高匹配的加权平均，UI 既不裁剪也不严重变形 |
| Expand | 16:9 视频/过场 | Canvas 扩展到最大边，两侧黑边，保证内容比例 |

#### 4. 资源变体与分平台打包

同一份资产为不同平台准备变体（纹理压缩格式、模型 LOD、音频码率），运行时按平台 + 质量 tier 选择加载。配合 Addressables 的 Label 分组，可实现同一逻辑地址 `textures/hero_diffuse` 在不同平台加载不同物理文件。

```typescript
type Platform = "mobile" | "pc" | "console";
type QualityTier = "low" | "medium" | "high";

// 平台→纹理格式映射
const TEXTURE_FORMAT_BY_PLATFORM: Record<Platform, string> = {
  mobile: "ASTC_6x6",   // 移动端 GPU 通用压缩
  pc: "BC7",            // PC 高质量压缩
  console: "Uncompressed", // 主机内存大，用未压缩保画质
};

// 解析正确变体：地址 + 平台 + 质量
class PlatformAssetLoader {
  resolveTexture(address: string, platform: Platform, tier: QualityTier): string {
    const format = TEXTURE_FORMAT_BY_PLATFORM[platform];
    // 低质量 tier 再降一档分辨率（half-res）
    const suffix = tier === "low" ? "_half" : "";
    return `${address}_${format}${suffix}`; // e.g. "hero_diffuse_ASTC_6x6_half"
  }
  load(address: string): Promise<Texture> {
    const platform = PlatformService.getRuntimePlatform();
    const tier = RenderBackend.getQualityTier();
    const variant = this.resolveTexture(address, platform, tier);
    return Addressables.load<Texture>(variant);
  }
}
```

| 纹理格式 | 平台 | 压缩率 | 质量 | 备注 |
| --- | --- | --- | --- | --- |
| ASTC 6x6 | 移动 | 高（约 0.56 bpp） | 良好 | 现代移动端首选，iOS/Android 通用 |
| ETC2 | 移动（旧） | 高 | 中等 | 老安卓/iOS 兜底，不支持 alpha 高质量 |
| DXT5 / BC3 | PC | 中 | 良好 | 桌面 GPU 通用，支持 alpha |
| BC7 | PC（高质量） | 中（0.5 bpp 高质量） | 优秀 | 现代 PC 首选，质量最接近未压缩 |
| 未压缩 RGBA32 | 主机 / 开发 | 无 | 完美 | 包体大，仅内存充裕设备或调试用 |

### ⚡ 实战经验

1. **平台宏散落是技术债的起点**：某项目上线后统计了 300+ 处 `#if UNITY_ANDROID / UNITY_IOS`，散落在 40+ 个脚本里。每次适配新平台要全工程搜索重测，重构收敛到抽象层花了 2 周，但之后新增平台（Switch）只改了 3 个接口实现。
2. **移动端输入延迟是体感生死线**：触摸事件到游戏响应超过 100ms 玩家会明显感知卡顿，手柄输入需控制在 50ms 以内（16ms 一帧，最多 3 帧延迟）。关键是在主线程轮询而非等事件回调——输入回调延迟实测比轮询高 30-50ms。
3. **SafeArea 遗漏是刘海屏事故的元凶**：没做 SafeArea 适配，iPhone X 上顶部 HUD 被刘海遮挡约 30% 可见区域，底部手柄被 Home Indicator 重叠。上线第一天 App Store 差评里 1/4 在吐槽「按钮点不到」。
4. **纹理格式选错让包体膨胀 4 倍**：移动端误用了未压缩 RGBA32 纹理，包体从 200MB 飙到 800MB，超过 Google Play 150MB 限制需要拆 APK+OBB。改用 ASTC 6x6 后包体回到 180MB，质量损失肉眼不可见。
5. **移动端内存 1GB 是 iOS 杀进程的临界线**：iPhone 在 App 内存超过约 1.2GB（取决于机型）时系统直接杀进程，没有 OOM 警告。必须设内存预算红线（移动端建议 <900MB），用 Profiler 持续监控，超限自动降级渲染 tier 卸载资源。

### 🔗 相关问题

- 手柄热插拔（玩家中途插入/拔出手柄）时，输入系统怎么无缝切换而不丢按键？关键在于输入设备用列表管理 + 最后输入设备追踪，切换时保留 1-2 帧的输入缓冲（input buffer）避免丢帧，UI 提示图标也要跟随切换。
- 主机平台的认证要求（TRC/TCR）对架构有什么约束？比如存档位置、网络断线处理、手柄震动权限。这类合规要求应沉淀到 PlatformService 接口，由各平台实现各自遵守，避免业务代码硬编码违反 TRC。
- 超宽屏（21:9 / 32:9）和折叠屏的 UI 适配怎么做？传统的 Match Width Or Height 策略够用吗？超宽屏需引入「内容最大宽度」限制 + 两侧装饰填充，折叠屏要监听折叠状态动态重布局，纯缩放策略已不够。
