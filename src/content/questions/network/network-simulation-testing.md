---
title: "游戏网络同步如何做模拟测试与弱网调试？"
category: "network"
level: 2
tags: ["网络测试", "弱网模拟", "调试工具", "CI/CD"]
related: ["network/rtt-jitter-packetloss", "network/jitter-buffer-design", "network/bandwidth-budget-rate-limiting"]
hint: "局域网测试永远流畅，上线后玩家投诉卡顿——你的网络同步在丢包 30%、RTT 300ms 下还能跑吗？"
---

## 参考答案

### ✅ 核心要点

1. **弱网模拟** 是通过工具人为制造延迟、抖动、丢包、乱序和带宽限制，在开发阶段暴露同步方案的问题
2. **网络条件矩阵** 需要覆盖多种网络环境（WiFi/4G/5G/跨区），每种环境有典型的 RTT 和丢包范围
3. **回放测试（Playback Testing）** 录制真实对局的网络包，在新版本上重放以检测同步逻辑变更的回归问题
4. **自动化 CI 网络测试** 在持续集成中加入弱网场景测试，防止性能回归
5. **客户端可视化调试** 通过网络统计面板（RTT 曲线、丢包率、带宽占用）帮助定位问题

### 📖 深度展开

#### 网络条件矩阵

| 场景 | RTT (ms) | Jitter (ms) | 丢包率 | 带宽 |
|------|----------|-------------|--------|------|
| 理想局域网 | 1-5 | 0-1 | 0% | 无限 |
| 良好 WiFi | 10-30 | 2-5 | 0-1% | 10Mbps+ |
| 拥挤 WiFi | 30-80 | 5-20 | 1-5% | 1-5Mbps |
| 4G 移动网络 | 50-150 | 10-50 | 1-3% | 1-10Mbps |
| 弱 4G/Edge | 150-400 | 20-100 | 3-15% | 100-500Kbps |
| 跨区（美→亚） | 150-300 | 5-30 | 1-5% | 取决于本地 |
| 极端弱网 | 300-800 | 50-200 | 15-40% | <200Kbps |

#### Linux TC (Traffic Control) 弱网模拟

```bash
# 在测试服务器上模拟 100ms 延迟 + 20ms 抖动 + 5% 丢包
sudo tc qdisc add dev eth0 root netem \
  delay 100ms 20ms \
  loss 5% \
  rate 1mbit

# 模拟包乱序（25% 的包会乱序到达）
sudo tc qdisc add dev eth0 root netem \
  delay 50ms 10ms \
  reorder 25% 50%

# 模拟带宽限制 + 延迟组合
sudo tc qdisc add dev eth0 root netem \
  delay 80ms \
  rate 512kbit \
  loss 2%

# 清除所有规则
sudo tc qdisc del dev eth0 root
```

#### Clumsy / Network Link Conditioner（Windows/macOS）

```
┌──────────────────────────────────────┐
│        Windows Clumsy 界面            │
├──────────────────────────────────────┤
│  Lag:     [✔] 100 ms                 │
│  Drop:    [✔] 5%                     │
│  Throttle:[✔] 512 KB/s               │
│  Tamper:  [ ] 1%                     │
│  Duplicate:[ ] 2%                    │
│  Out of order: [✔] 15%              │
├──────────────────────────────────────┤
│  Filter: tcp and (DstPort == 7777)   │
└──────────────────────────────────────┘
```

#### 自动化弱网测试框架

```python
import pytest
import subprocess
import time

class TestWeakNetwork:
    """弱网场景下的同步逻辑回归测试"""

    NETWORK_PROFILES = {
        "ideal":   {"delay": "1ms",   "loss": "0%",  "rate": "100mbit"},
        "wifi":    {"delay": "30ms",  "loss": "1%",  "rate": "10mbit"},
        "mobile":  {"delay": "100ms", "loss": "3%",  "rate": "2mbit"},
        "weak":    {"delay": "300ms", "loss": "15%", "rate": "500kbit"},
        "extreme": {"delay": "600ms", "loss": "30%", "rate": "100kbit"},
    }

    def setup_network(self, profile_name):
        p = self.NETWORK_PROFILES[profile_name]
        subprocess.run([
            "sudo", "tc", "qdisc", "add", "dev", "lo", "root", "netem",
            "delay", p["delay"],
            "loss", p["loss"],
            "rate", p["rate"]
        ])

    def teardown_network(self):
        subprocess.run(["sudo", "tc", "qdisc", "del", "dev", "lo", "root"])

    @pytest.mark.parametrize("profile", NETWORK_PROFILES.keys())
    def test_player_movement_sync(self, profile):
        """测试在指定网络条件下玩家移动同步的正确性"""
        self.setup_network(profile)
        try:
            client = GameClient.connect("127.0.0.1:7777")
            client.move_to(Vector3(100, 0, 50))
            time.sleep(2)  # 等待同步

            server_pos = client.get_server_position()
            client_pos = client.get_local_position()

            # 弱网下允许更大的误差范围
            tolerance = self.get_tolerance(profile)
            assert (server_pos - client_pos).magnitude < tolerance
        finally:
            self.teardown_network()

    def test_reconnect_after_packet_storm(self):
        """测试在丢包 40% 场景下不断连"""
        self.setup_network("extreme")
        try:
            client = GameClient.connect("127.0.0.1:7777")
            time.sleep(30)  # 持续 30 秒极端弱网
            assert client.is_connected()
            # 网络恢复后应快速追上
            self.teardown_network()
            self.setup_network("ideal")
            time.sleep(3)
            assert client.is_synced()
        finally:
            self.teardown_network()
```

#### 客户端调试面板

```cpp
// 运行时网络统计面板（Debug Overlay）
struct NetworkDebugOverlay {
    // 实时指标
    float currentRTT;           // 当前 RTT（ms）
    float smoothedRTT;          // 平滑 RTT（EMA）
    float jitterMs;             // 抖动
    float packetLossRate;       // 丢包率（最近 10 秒）
    float uplinkBps;            // 上行带宽（bytes/s）
    float downlinkBps;          // 下行带宽

    // 历史曲线（用于绘制 RTT 图）
    RingBuffer<float, 120> rttHistory;  // 最近 120 帧

    // 同步质量评分
    enum class SyncQuality {
        Good,       // RTT < 80ms, loss < 2%
        Acceptable, // RTT < 200ms, loss < 8%
        Poor,       // RTT < 400ms, loss < 20%
        Critical,   // 其他
    };

    SyncQuality EvaluateQuality() const {
        if (smoothedRTT < 80 && packetLossRate < 0.02) return SyncQuality::Good;
        if (smoothedRTT < 200 && packetLossRate < 0.08) return SyncQuality::Acceptable;
        if (smoothedRTT < 400 && packetLossRate < 0.20) return SyncQuality::Poor;
        return SyncQuality::Critical;
    }
};
```

#### 录包回放（Record & Playback）

```
┌──────────────┐     录制      ┌──────────────┐
│  真实对局     │ ───────────→  │  网络包日志   │
│  (Production) │               │  (.pkt 文件)  │
└──────────────┘               └──────┬───────┘
                                      │ 回放
                               ┌──────▼───────┐
                               │  新版本客户端  │
                               │  + 同步逻辑    │
                               └──────┬───────┘
                                      │ 对比
                               ┌──────▼───────┐
                               │  期望状态      │
                               │  vs 实际状态   │
                               └──────────────┘
```

### ⚡ 实战经验

- **弱网测试要从 Day 1 开始做**：很多团队到 Beta 阶段才引入弱网模拟，此时同步架构已经固化，发现的深层问题往往无法修复。建议在原型阶段就用 `tc netem` 模拟 150ms 延迟进行开发
- **CI 中加入网络回归测试**：每次合入主干时自动跑一遍 wifi/mobile/weak 三个档位的同步测试，用 RTT 曲线对比上次的结果，及时发现性能退化
- **不要只测平均 RTT**：真实网络的 RTT 分布是长尾的，测试时要用 jitter 参数模拟。一个平均 50ms 但偶尔跳到 300ms 的连接比平均 150ms 稳定的连接更容易出问题
- **移动端要测网络切换**：WiFi→4G 切换时连接会短暂中断（通常 1-3 秒），这是玩家流失的高发场景。测试时要覆盖这一过渡态

### 🔗 相关问题

- 如何设计一个可回放的录像系统（Replay System）同时用于赛事观战和网络回归测试？
- Unity 的 Network Simulator 和真实弱网之间有多大差距？如何弥补？
- 大规模压测时如何模拟上千个客户端连接来测试服务端带宽瓶颈？
