---
title: "网络质量恶化时如何实现优雅降级（Graceful Degradation）？断线边缘的自适应策略"
category: "network"
level: 3
tags: ["优雅降级", "自适应", "弱网", "网络同步", "容错设计"]
related: ["network/adaptive-update-rate.md", "network/rtt-jitter-packetloss.md", "network/reconnect-state-recovery.md"]
hint: "当 RTT 飙升到 500ms、丢包率 30% 时，玩家体验如何保底？"
---

## 参考答案

### ✅ 核心要点

1. **分级降级策略**：根据网络指标（RTT、丢包率、抖动）划分多级降级档位，而非简单的"正常/断线"二选一
2. **降级维度组合**：降低同步频率 → 增大插值缓冲 → 切换为外推模式 → 关闭非关键功能 → 最终才断线
3. **客户端体验保底**：即使服务端数据迟到，客户端也要用外推+缓存撑住基本操作手感
4. **分级恢复机制**：网络好转后平滑恢复，避免"降级→恢复→又降级"的振荡
5. **可观测性**：每次降级/恢复都记录埋点，用于后续分析和阈值调优

### 📖 深度展开

#### 降级等级体系

一个成熟的网络游戏应该定义 3-5 级网络质量状态，每级触发不同的降级策略：

```
┌─────────────────────────────────────────────────────────┐
│              Network Quality State Machine               │
├──────────┬──────────────┬──────────────────────────────┤
│  Level   │  Conditions  │  Actions                     │
├──────────┼──────────────┼──────────────────────────────┤
│ OPTIMAL  │ RTT<80ms     │ 全速同步(20Hz)               │
│          │ Loss<1%      │ 插值缓冲 100ms               │
│          │ Jitter<20ms  │ 所有功能正常                 │
├──────────┼──────────────┼──────────────────────────────┤
│ GOOD     │ RTT<150ms    │ 同步保持 20Hz                │
│          │ Loss<5%      │ 插值缓冲 150ms               │
│          │              │ 关闭精细物理（改为简化碰撞） │
├──────────┼──────────────┼──────────────────────────────┤
│ DEGRADED │ RTT<300ms    │ 同步降至 10Hz                │
│          │ Loss<15%     │ 插值缓冲 250ms               │
│          │              │ 外推启用，非关键实体停更     │
│          │              │ 关闭语音/表情/道具特效       │
├──────────┼──────────────┼──────────────────────────────┤
│ CRITICAL │ RTT<600ms    │ 同步降至 5Hz                 │
│          │ Loss<40%     │ 最大外推距离限制             │
│          │              │ 仅同步玩家+关键交互对象     │
│          │              │ UI 显示"网络不稳定"警告      │
├──────────┼──────────────┼──────────────────────────────┤
│ DISCONNECT│ RTT>600ms   │ 进入断线重连流程             │
│           │ Loss>40%    │ 客户端继续本地模拟           │
│           │ Timeout>5s  │ 显示重连界面                 │
└──────────┴──────────────┴──────────────────────────────┘
```

#### 实现代码：网络质量监控器

```csharp
public enum NetQualityLevel { OPTIMAL, GOOD, DEGRADED, CRITICAL, DISCONNECT }

public class NetworkQualityMonitor
{
    // 滑动窗口统计最近 N 个 RTT 样本
    private readonly float[] _rttWindow = new float[30];
    private int _rttIdx = 0;
    private int _rttCount = 0;

    private float _packetLossRate;     // 由 ACK 统计得出
    private float _jitter;             // RTT 标准差

    private NetQualityLevel _currentLevel = NetQualityLevel.OPTIMAL;
    private float _levelHoldTimer = 0f;   // 防振荡：状态保持时间
    private const float LEVEL_HOLD_TIME = 2f; // 至少保持 2 秒才允许再变

    public void OnRttSample(float rtt)
    {
        _rttWindow[_rttIdx] = rtt;
        _rttIdx = (_rttIdx + 1) % _rttWindow.Length;
        _rttCount = Mathf.Min(_rttCount + 1, _rttWindow.Length);

        float avg = GetAvgRtt();
        _jitter = GetJitter(avg);
        EvaluateLevel(avg);
    }

    private void EvaluateLevel(float avgRtt)
    {
        _levelHoldTimer += Time.deltaTime;
        if (_levelHoldTimer < LEVEL_HOLD_TIME) return;

        NetQualityLevel newLevel = Classify(avgRtt, _packetLossRate, _jitter);
        if (newLevel != _currentLevel)
        {
            OnLevelChanged?.Invoke(_currentLevel, newLevel);
            _currentLevel = newLevel;
            _levelHoldTimer = 0f;
        }
    }

    private NetQualityLevel Classify(float rtt, float loss, float jitter)
    {
        // 取最差维度作为最终等级（木桶效应）
        NetQualityLevel byRtt = rtt switch
        {
            < 80f  => NetQualityLevel.OPTIMAL,
            < 150f => NetQualityLevel.GOOD,
            < 300f => NetQualityLevel.DEGRADED,
            < 600f => NetQualityLevel.CRITICAL,
            _       => NetQualityLevel.DISCONNECT,
        };
        // 同理对 loss、jitter 分类...
        return WorstOf(byRtt, /* byLoss, byJitter */);
    }

    public event Action<NetQualityLevel, NetQualityLevel> OnLevelChanged;
}
```

#### 降级策略应用到各子系统

| 子系统 | OPTIMAL | DEGRADED | CRITICAL |
|--------|---------|----------|----------|
| 同步频率 | 20Hz | 10Hz | 5Hz |
| 插值缓冲 | 100ms | 250ms | 400ms |
| 外推 | 禁用 | 线性外推 | 外推+阻尼回拉 |
| AOI 半径 | 100m | 60m | 30m（仅近处） |
| 语音 | 开启 | 压缩码率 | 静音 |
| 物理 | 完整 | 简化碰撞 | 仅角色胶囊体 |
| 特效 | 全部 | 关闭粒子 | 仅保留核心特效 |

#### 防振荡（Hysteresis）设计

```
         恢复阈值
            ↓
  OPTIMAL ←─── GOOD ←─── DEGRADED ←─── CRITICAL
            ↑                           ↑
         降级阈值(更严格)             降级阈值

  例：RTT > 300 → 进入 DEGRADED
      RTT < 250 → 恢复到 GOOD   （不是 < 300 就恢复，留 50ms 缓冲带）
```

### ⚡ 实战经验

- **降级比断线好**：玩家宁可忍受 300ms 的卡顿感，也不愿看到"网络中断"弹窗。尽量延长 CRITICAL 状态的存活时间
- **外推不是万能药**：外推超过 500ms 会导致玩家位置严重偏移，碰撞判定出错。必须设最大外推时长（如 800ms），超时后"冻结"实体位置
- **AOI 收缩是最有效的降级手段**：减少同步实体数量能立竿见影地降低带宽压力，比单纯降低频率效果更好
- **测试覆盖弱网场景**：用 Clumsy 或 Network Link Conditioner 模拟 3% / 10% / 30% 丢包 + 高抖动，验证各降级等级的表现

### 🔗 相关问题

- 自适应同步频率（Adaptive Update Rate）的具体算法怎么设计？
- 断线重连后如何快速恢复到当前状态？增量快照 vs 全量快照怎么选？
- 抖动缓冲区（Jitter Buffer）的深度和降级等级如何联动？
