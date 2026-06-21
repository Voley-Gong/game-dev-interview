---
title: "WebSocket、TCP、UDP 在游戏中如何选型？各自适用场景是什么？"
category: "network"
level: 2
tags: ["网络协议", "WebSocket", "TCP", "UDP", "选型"]
related: ["network/protocol-selection", "network/nat-traversal"]
hint: "从可靠性、延迟、浏览器兼容性、连接建立成本四个维度对比"
---

## 参考答案

### ✅ 核心要点

1. **UDP**：无连接、低延迟、可丢包，适合实时对战（FPS、MOBA、格斗）
2. **TCP**：可靠传输、有序到达，适合回合制、卡牌、策略类游戏
3. **WebSocket**：基于 TCP 的全双工通道，适合 H5 游戏、WebGL 项目、需要 HTTP 兼容的场景
4. **混合架构**：控制信令走 TCP/WebSocket，战斗数据走 UDP（如 KCP over UDP）
5. **选型决策树**：先看平台约束（是否浏览器），再看实时性要求，最后评估可靠性需求

### 📖 深度展开

#### 三种协议对比

| 维度 | UDP | TCP | WebSocket |
|------|-----|-----|-----------|
| 可靠性 | 不可靠，可能丢包/乱序 | 可靠，保证到达且有序 | 可靠（基于 TCP） |
| 延迟 | 最低，无重传等待 | 较高，丢包重传阻塞 | 较高（TCP 固有） |
| 连接建立 | 无连接 | 3 次握手 | HTTP 升级 + TCP 握手 |
| 头部开销 | 8 字节 | 20+ 字节 | 2-14 字节（帧头） |
| 浏览器支持 | ❌ 原生不支持 | ❌ 原生不支持 | ✅ 原生支持 |
| NAT 穿透 | 较容易（可打洞） | 困难（需中转） | 不适用（走 HTTP 端口） |
| 防火墙友好 | 差（常被封） | 好 | 极好（80/443 端口） |

#### 选型决策流程

```
游戏需要联网？
  ├── 运行在浏览器/H5？
  │     ├── 是 → WebSocket（唯一选择）
  │     │     └── 实时性极高？→ WebRTC Data Channel（UDP-based）
  │     └── 否 → 继续
  ├── 实时性要求？
  │     ├── 极高（<50ms，FPS/格斗）→ UDP + 自研可靠性层（KCP/ENet）
  │     ├── 中等（50-200ms，MOBA/MMO）→ UDP 或 TCP（视项目而定）
  │     └── 低（回合制/卡牌）→ TCP 或 WebSocket
  └── 需要穿透防火墙/CDN？
        └── 是 → WebSocket（443 端口最友好）
```

#### 混合协议架构（业界主流）

大多数现代游戏采用**双通道架构**：

```
客户端
  ├── TCP/WebSocket 通道（控制面）
  │     ├── 登录认证
  │     ├── 匹配/房间管理
  │     ├── 聊天系统
  │     └── 商店/支付
  └── UDP 通道（数据面）
        ├── 位置同步
        ├── 技能释放
        ├── 伤害判定
        └── 战斗状态
```

**代码示例（C# 双通道客户端）：**

```csharp
public class NetworkManager : MonoBehaviour
{
    private TcpClient _controlChannel;  // TCP 控制通道
    private UdpClient _dataChannel;     // UDP 数据通道

    async void Connect(string host, int tcpPort, int udpPort)
    {
        // TCP 连接（控制信令）
        _controlChannel = new TcpClient();
        await _controlChannel.ConnectAsync(host, tcpPort);
        StartControlLoop();

        // UDP 连接（战斗数据）
        _dataChannel = new UdpClient();
        _dataChannel.Connect(host, udpPort);
        StartDataLoop();
    }

    // TCP：可靠消息（登录、匹配结果）
    async void SendControlMessage(NetMessage msg)
    {
        var stream = _controlChannel.GetStream();
        var data = ProtoSerialize(msg);
        await stream.WriteAsync(data, 0, data.Length);
    }

    // UDP：高频数据（位置、动作）
    void SendGameData(Snapshot snap)
    {
        var data = BitPack(snap);  // 位打包，极小包体
        _dataChannel.Send(data, data.Length);
    }
}
```

#### WebSocket 在 H5 游戏中的实践

```javascript
// H5 游戏的 WebSocket 封装
class GameSocket {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';  // 二进制模式
        this.ws.onopen = () => this.onConnected();
        this.ws.onmessage = (e) => this.onMessage(e.data);
    }

    // 发送二进制数据（比 JSON 省带宽）
    send(msg) {
        const buf = new ArrayBuffer(16);
        const view = new DataView(buf);
        view.setUint8(0, msg.type);
        view.setFloat32(4, msg.x);
        view.setFloat32(8, msg.y);
        this.ws.send(buf);  // 16 字节 vs JSON 的 60+ 字节
    }
}
```

#### WebRTC Data Channel：浏览器的"UDP"

当 H5 游戏需要超低延迟时，可以用 WebRTC 的 Data Channel：

- 底层基于 SCTP over DTLS，支持 ** unreliable 模式**（类似 UDP）
- 浏览器原生支持，无需插件
- 适合 H5 实时对战游戏

```javascript
const pc = new RTCPeerConnection();
const dc = pc.createDataChannel("game", {
    ordered: false,       // 不保证顺序
    maxRetransmits: 0     // 不重传 = UDP 语义
});
```

### ⚡ 实战经验

- **H5 游戏别犹豫**：浏览器环境只有 WebSocket（或 WebRTC），不存在"用 UDP 还是 TCP"的选择题
- **WebSocket 并不慢**：延迟瓶颈通常在应用层序列化，而非 TCP 本身。用 Protobuf + 二进制帧可以把 WebSocket 延迟压到可接受范围
- **注意 WebSocket 连接保活**：NAT/负载均衡器会在 30-60s 空闲后断连，必须实现心跳机制（通常 10-15s 间隔）
- **移动网络下 UDP 可能被运营商封杀**：国内部分运营商对非标端口的 UDP 包有限制，必须做好 TCP 回退方案

### 🔗 相关问题

- KCP 协议相比原生 UDP 有什么优势？如何实现可靠性层？
- WebSocket 如何实现二进制协议的序列化与反序列化？
- WebRTC Data Channel 在实际 H5 对战游戏中有哪些坑？
