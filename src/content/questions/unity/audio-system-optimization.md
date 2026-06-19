---
title: "Unity 音频系统如何工作？AudioSource、AudioMixer、音频压缩的性能优化策略是什么？"
category: "unity"
level: 2
tags: ["音频", "性能优化", "移动端"]
related: ["unity/mobile-optimization", "unity/memory-management-leak"]
hint: "移动端音频优化的核心：格式选择、实例复用、混音器分组控制。"
---

## 参考答案

### ✅ 核心要点

1. **AudioClip 是音频数据容器**，AudioSource 是播放控制器，AudioListener 是「耳朵」（每个场景只有一个）
2. **移动端音频格式选择至关重要**：Decompress on Load 适合短音效，Streaming 适合 BGM，Compressed in Memory 适合中等长度音频
3. **AudioMixer 提供分组混音、快照、效果器**，是实现音量控制和音频路由的核心工具
4. **AudioSource 对象池是必备优化**：频繁 Play/Stop 引发 GC 和实例化开销，池化可彻底消除
5. **3D 空间音频**通过距离衰减、混响、声像实现，但 Doppler Level 和 Spread 在移动端需谨慎使用

### 📖 深度展开

#### 音频三要素与数据流

```
AudioClip (音频数据)
  ↓ 加载到内存
AudioSource (播放器)
  ↓ DSP 处理（音量、空间化、效果）
AudioListener (接收器)
  ↓ 最终混音
AudioMixer (可选，混音路由)
  ↓
音频驱动 → 扬声器
```

| 组件 | 数量限制 | 职责 |
|------|---------|------|
| AudioListener | **每场景仅 1 个** | 接收所有声音的「麦克风」 |
| AudioSource | 无硬限制（建议 < 32） | 播放控制（音量、音高、空间化） |
| AudioClip | 无限制 | 存储音频采样数据 |
| AudioMixer | 无限制 | 分组混音、效果链、快照 |

#### 三种加载模式的内存与 CPU 对比

| 加载模式 | 内存占用 | CPU 开销 | 适用场景 |
|---------|---------|---------|---------|
| **Decompress on Load** | 最大（PCM 解码后驻留） | 加载时高，播放时低 | 短音效（< 1秒），频繁播放 |
| **Compressed in Memory** | 中等（压缩格式驻留） | 播放时解码开销 | 中等音频（1-10秒），偶尔播放 |
| **Streaming** | 最小（仅缓冲区） | 持续磁盘读取 | BGM、语音、长音频 |

```csharp
// 在代码中设置加载模式
AudioClip clip = audioSource.clip;
// 导入设置中配置（无法运行时修改）：
// importAudioData: Decompress / Compressed / Streaming

// 运行时可以通过 clip.preloadAudioData 控制
clip.preloadAudioData = true;  // 提前解码
clip.LoadAudioData();           // 手动触发加载
```

#### AudioMixer 架构与实战

```
Master Mixer (总输出)
├── BGM Group     → 低通滤波器 + 音量控制
├── SFX Group     → 动态压缩 + 音量控制
├── Voice Group   → 降噪 + 音量控制
└── UI Group      → 音量控制
```

**用 AudioMixer Snapshot 实现场景切换：**

```csharp
public class AudioSceneManager : MonoBehaviour {
    [SerializeField] AudioMixerSnapshot normalSnapshot;
    [SerializeField] AudioMixerSnapshot pausedSnapshot;
    [SerializeField] AudioMixerSnapshot combatSnapshot;

    public void TransitionToCombat() {
        // 1秒过渡到战斗混音快照（降低BGM，提升SFX）
        combatSnapshot.TransitionTo(1.0f);
    }

    public void TransitionToNormal() {
        normalSnapshot.TransitionTo(0.5f);
    }

    // 暴露参数给代码控制
    public void SetBGMVolume(float volume) {
        // AudioMixer 中需要将 Volume 参数暴露为 "BGMVolume"
        audioMixer.SetFloat("BGMVolume", Mathf.Log10(volume) * 20); // dB 转换
    }
}
```

**dB 与线性音量的转换公式：**
```
dB = 20 × log₁₀(linearVolume)
linearVolume = 10^(dB / 20)
```

#### AudioSource 对象池实现

```csharp
public class AudioSourcePool : MonoBehaviour {
    [SerializeField] int poolSize = 16;
    private readonly Queue<AudioSource> pool = new();
    private readonly List<AudioSource> active = new();

    void Awake() {
        for (int i = 0; i < poolSize; i++) {
            var source = gameObject.AddComponent<AudioSource>();
            source.playOnAwake = false;
            source.enabled = false;
            pool.Enqueue(source);
        }
    }

    public AudioSource Play(AudioClip clip, float volume = 1f, float pitch = 1f) {
        if (pool.Count == 0) {
            // 池耗尽：复用最早播放的（或直接忽略）
            var oldest = active[0];
            oldest.Stop();
            pool.Enqueue(oldest);
            active.RemoveAt(0);
        }

        var source = pool.Dequeue();
        source.enabled = true;
        source.clip = clip;
        source.volume = volume;
        source.pitch = pitch;
        source.Play();
        active.Add(source);

        // 自动回收
        StartCoroutine(ReturnAfterPlay(source, clip.length / pitch));
        return source;
    }

    private System.Collections.IEnumerator ReturnAfterPlay(AudioSource source, float delay) {
        yield return new WaitForSeconds(delay + 0.1f);
        source.enabled = false;
        source.clip = null;
        active.Remove(source);
        pool.Enqueue(source);
    }
}
```

#### 移动端音频性能清单

| 优化项 | 影响 | 做法 |
|-------|------|------|
| **Force To Mono** | 减半内存 | 移动端部分音效无需立体声，导入时勾选 |
| **Bitrate 降低** | 减少内存 | 语音 → 64-96kbps，BGM → 128-160kbps |
| **Sample Rate 匹配** | 避免重采样开销 | 移动端输出 44100Hz，源文件不需更高 |
| **Doppler 禁用** | 减少 CPU | UI 音效、2D 音效设 Doppler Level = 0 |
| **Voice Limit** | 避免叠音 | 同一 AudioSource 限制同时播放数 |
| **DSP Buffer Size** | 延迟 vs 卡顿 | Best Latency（64-256 samples）在移动端测试 |

```
移动端推荐配置：
┌─────────────────────────────────────────┐
│  BGM:   Streaming + Vorbis 128kbps     │
│  SFX:   Decompress on Load + Vorbis    │
│         Force To Mono + < 5秒           │
│  Voice: Compressed in Memory + Opus    │
│         64kbps Mono                    │
│  DSP Buffer: Best Performance (512)    │
│  Max Voices: 24-32                      │
└─────────────────────────────────────────┘
```

### ⚡ 实战经验

1. **BGM 永远用 Streaming**：项目早期将 BGM 设为 Decompress on Load，一首 3 分钟的曲子直接占用 30MB PCM 内存；改为 Streaming 后降至约 200KB 缓冲区
2. **音效叠播要有 Voice Limit**：连续播放同一音效（如机枪射击）如果不限制 Voice，会导致瞬间大量混音 → CPU 尖峰 → 掉帧；设置 AudioSource Voice Limit 为 3-4 即可
3. **注意 Android 的音频焦点**：Android 系统会在电话/其他 App 抢占音频时暂停游戏音频，需要在 `OnAudioFocusChange` 中处理（Unity 2020+ 自动处理，但旧版本需手动实现）
4. **iOS 内存警告时优先释放音频**：iOS 内存警告（MemoryWarning）时，卸载非活跃 AudioClip 比卸载纹理更安全——音频可以快速重新加载（特别是 Streaming 模式），纹理重载代价更大

### 🔗 相关问题

- Unity 的音频系统底层使用什么引擎（FMOD / Wwise 集成怎么做）？
- 如何实现实时语音聊天（网络音频流 + Unity Microphone）？
- 程序化生成音频（Procedural Audio）在 Unity 中如何实现？
