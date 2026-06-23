---
title: "游戏的天气与昼夜环境系统架构怎么设计？如何驱动光照、天空和全局氛围的动态变化？"
category: "architecture"
level: 4
tags: ["天气系统", "昼夜循环", "动态光照", "环境系统", "架构设计"]
related: ["architecture/game-loop-subsystem", "architecture/event-driven-vs-data-driven", "architecture/scene-management-architecture"]
hint: "不是简单的时钟加减速——是一套驱动光照、天空盒、后处理、粒子(雨/雪)和游戏逻辑联动的状态系统。"
---

## 参考答案

### ✅ 核心要点

1. **时间系统是环境变化的核心驱动引擎**：游戏时间（GameTime）以"逻辑秒"为单位累积，每帧用 `timeScale` 倍率推进（timeScale=1 为真实速度，timeScale=60 则 1 分钟 = 游戏内 1 小时），映射到 [0, 24) 小时制的归一化时间 t∈[0, 1]。所有环境参数——太阳角度、光照颜色、天空颜色、雾密度——都以 t 为输入做曲线插值。关键设计：时间可快进、可暂停、可跳转，且所有环境参数对 t 连续可导，保证昼夜过渡平滑无跳变。

2. **光照参数的曲线插值（Gradient/AnimationCurve）是视觉核心**：太阳方向角用天体物理简化模型计算（纬度 + 时角 → 高度角和方位角），光照颜色/强度/色温在关键时刻（日出 06:00 / 正午 12:00 / 日落 18:00 / 深夜 00:00）设锚点值，用 Gradient 或 AnimationCurve 在锚点间平滑插值。关键是要"连续渐变"而非"分段跳变"——用三阶贝塞尔或 smoothstep 控制过渡斜率，避免日出瞬间画面"闪"一下。

3. **天气状态机与参数渐变过渡避免突兀切换**：天气（晴/阴/雨/雪/雾/暴风）建模为有限状态机，状态切换不是瞬切而是 10-30 秒的 Lerp 渐变——云量、粒子密度、雾浓度、光照强度同时平滑过渡，避免"啪"地一下开始下雨。天气状态机支持权重随机（如晴天 70%、阴天 20%、雨天 10%）、温度/湿度条件触发、以及脚本强制切换（剧情触发暴风雪）。

4. **环境效果的子系统联动是"氛围感"的关键**：天气变化不只是改材质参数——它联动粒子系统（下雨启用雨粒子层）、后处理（雨天降低饱和度 + 加暗角 + 屏幕水滴效果）、音频（切换环境音和 BGM Mix Snapshot）、NPC 行为（雨天行人减少/怪物出现率变化）、甚至物理参数（雨天增加角色滑行降低摩擦力）。用一个 EnvironmentContext 数据对象广播当前环境状态，各子系统订阅响应——这就是数据驱动架构在环境系统中的落地。

5. **性能控制与分帧更新是帧率稳定的保障**：昼夜每帧更新方向光 + 修改数百个材质参数会带来可观 CPU 开销。核心优化：分帧更新（每 N 帧更新一次环境参数，N=3-5 对肉眼无感知差异）、Shader 参数用全局 Uniform (UBO/ShaderData) 一次设置全局生效而非逐材质 SetFloat、天气粒子用 GPU 粒子（Compute/GPU Instancing）而非 CPU 粒子模拟、开放世界按 Chunk 分区加载/卸载环境资源。

### 📖 深度展开

天气与昼夜系统是开放世界游戏的"氛围基石"，它远不是简单的"加个时钟"。下面拆解时间模型、天气状态机和联动广播三层架构。

#### 子章节1：昼夜光照模型与时间系统架构

完整的环境时间系统从 GameTime 推进到 GPU 着色器参数更新的流程：

```
 GameTime 推进
   · 每帧: gameTime += deltaTime * timeScale
   · 归一化: t = (gameTime % dayLength) / dayLength   // t ∈ [0, 1)
        │
        ▼
 天体计算 (Celestial Model)
   · 太阳高度角 elevation = f(t, latitude)    // 天球简化模型
   · 太阳方位角 azimuth = g(t, latitude)
   · 月亮位置 (相位/角度)
        │
        ▼
 光照参数采样 (Gradient/Curve)
   · 太阳颜色 = sunColorGradient.sample(t)    // 日出橙红→正午白→日落金→深夜蓝
   · 太阳强度 = sunIntensityCurve.sample(t)   // 0.0(深夜)→1.2(正午)
   · 环境光颜色 = ambientGradient.sample(t)
   · 天空颜色 = skyGradient.sample(t)
   · 雾色/密度 = fogCurve.sample(t)
        │
        ▼
 全局 Shader Uniform (一次设置, 全场景生效)
   · _SunDirection = vec3(sin(elevation)*cos(azimuth), sin(elevation), ...)
   · _SunColor = sunColor
   · _AmbientColor = ambient
   · _FogDensity = fogDensity
        │
        ▼
 GPU 着色器 (所有材质统一采样全局 Uniform)
```

时间归一化与太阳角度计算的核心实现：

```typescript
// 天体物理简化模型：根据归一化时间 t 和纬度计算太阳高度角/方位角
// 这是游戏中最常用的"假天文学"——不完全精确但视觉足够

interface CelestialState {
  sunElevation: number;  // 太阳高度角(弧度)，0=地平线，π/2=正头顶
  sunAzimuth: number;    // 太阳方位角(弧度)，0=正东，顺时针
  sunDirection: Vec3;    // 计算好的方向向量(直接传给 Shader)
  moonElevation: number;
  moonDirection: Vec3;
  isDaytime: boolean;
}

function computeCelestial(t: number, latitudeDeg: number): CelestialState {
  // t ∈ [0,1): 0=午夜, 0.25=日出, 0.5=正午, 0.75=日落
  const hourAngle = (t - 0.5) * Math.PI * 2;    // 时角：[-π, π]
  const lat = latitudeDeg * Math.PI / 180;

  // 太阳赤纬(简化为固定值，真实应按季节变化)
  const declination = 23.5 * Math.PI / 180 * Math.sin(t * Math.PI * 2);

  // 太阳高度角：asin(sin(lat)*sin(δ) + cos(lat)*cos(δ)*cos(H))
  const sinElev = Math.sin(lat) * Math.sin(declination)
                + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElev)));

  // 太阳方位角
  const cosAz = (Math.sin(declination) - sinElev * Math.sin(lat))
              / (Math.cos(elevation) * Math.cos(lat));
  const azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz)));

  const sunDir: Vec3 = {
    x: Math.cos(elevation) * Math.cos(azimuth),
    y: Math.max(0, Math.sin(elevation)),   // 太阳在地下时 y=0
    z: Math.cos(elevation) * Math.sin(azimuth),
  };

  // 月亮：与太阳相差 12 小时(t + 0.5)
  const moonT = (t + 0.5) % 1.0;
  // ...(同理计算，略)

  return {
    sunElevation: elevation,
    sunAzimuth: azimuth,
    sunDirection: sunDir,
    moonElevation: 0,  // 简化
    moonDirection: { x: -sunDir.x, y: Math.max(0, -sunDir.y + 0.3), z: -sunDir.z },
    isDaytime: elevation > 0,
  };
}
```

#### 子章节2：天气状态机与参数过渡

天气不是简单的"切换布尔标志"，而是一个带渐变过渡的状态机。关键是状态切换时用 10-30 秒的 Lerp 让所有环境参数同时平滑变化：

```typescript
// 天气状态枚举 + 每种状态的完整环境参数集
type WeatherType = "clear" | "cloudy" | "rain" | "storm" | "snow" | "fog";

interface WeatherProfile {
  cloudCoverage: number;    // 云层覆盖 0-1
  precipitationDensity: number; // 降水粒子密度 0-1
  fogDensity: number;       // 雾浓度 0-1
  lightIntensityMul: number; // 光照强度乘数 0-1(阴天降低)
  saturationMul: number;    // 后处理饱和度乘数
  windStrength: number;     // 风力强度
}

// 天气状态机：带渐变过渡的环境参数管理器
class WeatherStateMachine {
  private current: WeatherType = "clear";
  private currentProfile: WeatherProfile;
  private targetProfile: WeatherProfile;
  private transitionProgress = 1.0;     // 1.0 = 过渡完成
  private transitionDuration = 20000;   // 20 秒过渡

  // 天气权重表（用于随机切换）
  private weightTable: Record<WeatherType, number> = {
    clear: 0.5, cloudy: 0.25, rain: 0.15, storm: 0.03, snow: 0.05, fog: 0.02,
  };

  // 天气参数预设
  private profiles: Record<WeatherType, WeatherProfile> = {
    clear: { cloudCoverage: 0.1, precipitationDensity: 0, fogDensity: 0.02, lightIntensityMul: 1.0, saturationMul: 1.0, windStrength: 0.2 },
    cloudy:{ cloudCoverage: 0.7, precipitationDensity: 0, fogDensity: 0.08, lightIntensityMul: 0.7, saturationMul: 0.85, windStrength: 0.4 },
    rain:  { cloudCoverage: 0.9, precipitationDensity: 0.6, fogDensity: 0.15, lightIntensityMul: 0.5, saturationMul: 0.7, windStrength: 0.6 },
    storm: { cloudCoverage: 1.0, precipitationDensity: 1.0, fogDensity: 0.25, lightIntensityMul: 0.3, saturationMul: 0.5, windStrength: 1.0 },
    snow:  { cloudCoverage: 0.8, precipitationDensity: 0.4, fogDensity: 0.12, lightIntensityMul: 0.6, saturationMul: 0.9, windStrength: 0.3 },
    fog:   { cloudCoverage: 0.5, precipitationDensity: 0, fogDensity: 0.6, lightIntensityMul: 0.6, saturationMul: 0.6, windStrength: 0.1 },
  };

  constructor() {
    this.currentProfile = { ...this.profiles.clear };
    this.targetProfile = { ...this.profiles.clear };
  }

  // 切换天气（启动渐变过渡）
  setWeather(type: WeatherType, durationMs = 20000): void {
    this.current = type;
    this.currentProfile = this.getCurrentBlended();  // 从当前混合状态开始
    this.targetProfile = this.profiles[type];
    this.transitionProgress = 0.0;
    this.transitionDuration = durationMs;
    // 广播天气变化事件，通知各子系统
    eventBus.emit("weather_changed", { type, profile: this.targetProfile });
  }

  // 按权重随机切换天气
  randomTransition(): void {
    const r = Math.random();
    let acc = 0;
    for (const [type, weight] of Object.entries(this.weightTable)) {
      acc += weight;
      if (r <= acc) { this.setWeather(type as WeatherType); return; }
    }
  }

  // 每帧调用：推进过渡进度并混合参数
  update(dtMs: number): WeatherProfile {
    if (this.transitionProgress < 1.0) {
      this.transitionProgress = Math.min(1.0, this.transitionProgress + dtMs / this.transitionDuration);
      // smoothstep 缓动：开始慢→中间快→结束慢
      const t = this.transitionProgress;
      const eased = t * t * (3 - 2 * t);
      this.lerpProfiles(this.currentProfile, this.targetProfile, eased);
    }
    return this.getCurrentBlended();
  }

  private getCurrentBlended(): WeatherProfile {
    if (this.transitionProgress >= 1.0) return { ...this.targetProfile };
    const t = this.transitionProgress * this.transitionProgress * (3 - 2 * this.transitionProgress);
    return this.lerpProfiles(this.currentProfile, this.targetProfile, t);
  }

  private lerpProfiles(a: WeatherProfile, b: WeatherProfile, t: number): WeatherProfile {
    return {
      cloudCoverage: a.cloudCoverage + (b.cloudCoverage - a.cloudCoverage) * t,
      precipitationDensity: a.precipitationDensity + (b.precipitationDensity - a.precipitationDensity) * t,
      fogDensity: a.fogDensity + (b.fogDensity - a.fogDensity) * t,
      lightIntensityMul: a.lightIntensityMul + (b.lightIntensityMul - a.lightIntensityMul) * t,
      saturationMul: a.saturationMul + (b.saturationMul - a.saturationMul) * t,
      windStrength: a.windStrength + (b.windStrength - a.windStrength) * t,
    };
  }
}
```

#### 子章节3：环境广播架构与性能优化

天气变化需要联动多个子系统。不同联动架构各有优劣：

| 联动架构 | 实现方式 | 优点 | 缺点 | 适用场景 |
|---|---|---|---|---|
| 事件广播 | EnvironmentContext 变化时 emit 事件 | 解耦，子系统按需订阅 | 事件风暴风险（高频 emit） | 通用方案 |
| 数据驱动 | 各子系统每帧读取 EnvironmentContext | 无事件开销，always in sync | 每帧轮询开销 | 高频联动（光照/材质） |
| 脚本回调 | 注册回调函数，天气切换时统一调用 | 精确控制执行顺序 | 注册/注销管理复杂 | 低频联动（NPC/剧情） |
| 共享黑板 | 写入全局黑板，子系统按 key 读取 | 极度解耦，支持运行时扩展 | 类型不安全，调试困难 | 快速原型 |

推荐组合：光照/材质/后处理用数据驱动（每帧读 EnvironmentContext，O(1) 采样），NPC/音频/物理用事件广播（只在天气切换时触发一次）。

### ⚡ 实战经验

- **光照曲线锚点间距太近导致画面闪烁**：关键时刻锚点设得太近（日出 05:30 和 05:45 光照强度差 3 倍），导致日出时画面"闪"一下。改为用 AnimationCurve 平滑过渡（控制切线斜率）并保证锚点间隔 ≥ 1 小时后，闪烁消除。经验值：相邻锚点的参数差异不应超过 50%，否则过渡斜率过陡产生闪烁。

- **天气切换突兀引发玩家投诉**：晴天直接切雨天时，雨粒子凭空出现 + 光照骤暗，大量玩家反馈"穿越感"。加入 15 秒渐变过渡（云层 alpha 0→1、雨粒子密度 0→满、光照强度渐降、环境音渐入）后，切换如真实天气般自然，投诉清零。

- **每帧更新 800+ 材质参数导致 CPU 帧时间翻倍**：开放世界场景有 800+ 个材质，昼夜系统每帧逐个 `material.SetFloat("_FogDensity", value)`，CPU 开销从 2ms 飙到 7ms。改为全局 Shader Uniform（`Shader.SetGlobalVector`）一次设置 + Shader 中统一采样后，CPU 开销降到 0.3ms，帧率回升。

- **雨天 GPU 粒子数量爆炸**：屏幕空间雨粒子覆盖全屏，粒子数达 50000+，GPU 帧时间从 6ms 飙到 22ms。改为视锥体裁剪（只在摄像机前方锥体内生成雨粒子）+ 粒子数降到 ~5000 + GPU Instancing 合批后，帧时间回到 8ms，雨幕效果视觉无差异。

### 🔗 相关问题

- 昼夜系统怎么和存档联动？玩家退出再进来天气是否恢复？提示方向：环境状态序列化（当前时间 t + 天气类型 + 过渡进度）+ 离线时间推算（退出 2 小时回来自动推进游戏时间）。
- 如何实现"真实天文"太阳轨迹（考虑季节和纬度变化）？提示方向：天球坐标系、太阳赤纬角随季节正弦变化、时差方程修正。
- 多人游戏中天气怎么同步？每帧同步还是种子同步？提示方向：确定性天气随机种子 + 服务器权威状态快照 + 周期性校正（防止客户端漂移）。
