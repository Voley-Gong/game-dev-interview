---
title: "Cocos Creator 游戏网络通信方案如何设计与选型？"
category: "cocos"
level: 2
tags: ["网络通信", "架构设计", "WebSocket", "protobuf", "小游戏"]
related: ["cocos/hot-update-design", "cocos/dynamic-loading"]
hint: "从短连接 HTTP 到长连接 WebSocket，从 JSON 到 Protobuf，不同游戏类型如何选型？"
---

## 参考答案

### ✅ 核心要点

1. **通信协议选型** → HTTP 适合弱状态请求，WebSocket 适合实时交互，UDP/QUIC 适合高时效竞技
2. **序列化方案** → JSON 易调试但体积大，Protobuf 紧凑高效，FlatBuffers 零拷贝但生态弱
3. **重连与心跳** → 长连接必须实现心跳保活 + 断线重连 + 消息重发队列
4. **小游戏限制** → 微信等平台不支持裸 TCP/UDP，只能用 WebSocket 或 HTTP
5. **网络安全** → 协议加密（AES + 防重放）、SSL/TLS、服务端权威校验

### 📖 深度展开

#### 网络方案对比

| 方案 | 适用场景 | 延迟 | 复杂度 | 小游戏兼容 |
|------|---------|------|--------|-----------|
| HTTP 轮询 | 回合制、排行榜 | 高 | 低 | ✅ |
| HTTP 长轮询 | 聊天室、简单通知 | 中 | 中 | ✅ |
| WebSocket | 实时对战、MMO | 低 | 中 | ✅ |
| TCP Socket | 大型 MMO | 低 | 高 | ❌ |
| UDP | FPS/MOBA | 极低 | 极高 | ❌ |
| WSS + Protobuf | 竞技小游戏 | 低 | 中高 | ✅ |

#### WebSocket + Protobuf 完整实现

```typescript
// network/SocketManager.ts
import { _decorator, Component, sys } from 'cc';
const { ccclass } = _decorator;

interface MessageHandler {
  (data: any): void;
}

@ccclass('SocketManager')
export class SocketManager extends Component {
  private ws: WebSocket | null = null;
  private url: string = '';
  private heartbeatInterval: number = 15000; // 15秒
  private heartbeatTimer: any = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 2000;
  private isManualClose: boolean = false;

  // 消息队列：断线期间的消息缓存
  private pendingMessages: ArrayBuffer[] = [];
  private maxPendingSize: number = 50;

  // 消息处理器注册表
  private handlers: Map<number, MessageHandler> = new Map();

  // 事件回调
  public onConnected: (() => void) | null = null;
  public onDisconnected: (() => void) | null = null;
  public onError: ((error: Event) => void) | null = null;

  connect(url: string) {
    this.url = url;
    this.isManualClose = false;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  private doConnect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`[Net] 连接中... (attempt ${this.reconnectAttempts + 1})`);
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[Net] 连接成功');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.flushPendingMessages();
      this.onConnected?.();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = (event) => {
      console.log(`[Net] 连接关闭 code=${event.code}`);
      this.stopHeartbeat();
      if (!this.isManualClose) {
        this.scheduleReconnect();
      }
      this.onDisconnected?.();
    };

    this.ws.onerror = (error) => {
      console.error('[Net] 连接错误', error);
      this.onError?.(error);
    };
  }

  private handleMessage(data: ArrayBuffer) {
    // Protobuf 解码
    // 假设前 2 字节为消息 ID，后面为 protobuf payload
    const view = new DataView(data);
    const msgId = view.getUint16(0, false); // big-endian
    const payload = new Uint8Array(data, 2);

    const handler = this.handlers.get(msgId);
    if (handler) {
      handler(payload);
    } else {
      console.warn(`[Net] 未注册消息 ID: ${msgId}`);
    }
  }

  // 发送消息（Protobuf 编码）
  send(msgId: number, encodedData: Uint8Array) {
    // 拼接 msgId (2 bytes) + payload
    const buffer = new ArrayBuffer(2 + encodedData.length);
    const view = new DataView(buffer);
    view.setUint16(0, msgId, false);
    new Uint8Array(buffer, 2).set(encodedData);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    } else {
      // 断线期间加入待发送队列
      if (this.pendingMessages.length < this.maxPendingSize) {
        this.pendingMessages.push(buffer);
      }
    }
  }

  // 注册消息处理器
  registerHandler(msgId: number, handler: MessageHandler) {
    this.handlers.set(msgId, handler);
  }

  unregisterHandler(msgId: number) {
    this.handlers.delete(msgId);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send(0xFFFF, new Uint8Array(0)); // 心跳包
    }, this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Net] 超过最大重连次数，放弃重连');
      return;
    }

    this.reconnectAttempts++;
    // 指数退避：每次延迟加倍
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[Net] ${delay}ms 后第 ${this.reconnectAttempts} 次重连...`);

    setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  private flushPendingMessages() {
    while (this.pendingMessages.length > 0) {
      const msg = this.pendingMessages.shift()!;
      this.ws?.send(msg);
    }
  }

  disconnect() {
    this.isManualClose = true;
    this.stopHeartbeat();
    this.pendingMessages = [];
    if (this.ws) {
      this.ws.close(1000, 'normal closure');
      this.ws = null;
    }
  }

  onDestroy() {
    this.disconnect();
    this.handlers.clear();
  }
}
```

#### Protobuf 集成方案

```typescript
// proto/message.proto
/*
syntax = "proto3";

message PlayerMoveReq {
  float x = 1;
  float y = 2;
  int32 frame = 3;
}

message PlayerMoveAck {
  bool success = 1;
  float corrected_x = 2;
  float corrected_y = 3;
}
*/

// 加载 .proto 文件（使用 protobufjs）
import protobuf from 'protobufjs';

// 方式一：运行时加载 proto（适合开发期，有反射开销）
const root = await protobuf.load('proto/message.proto');
const PlayerMoveReq = root.lookupType('PlayerMoveReq');

// 方式二：预生成 JS（推荐，省体积）
// pbjs -t static-module -w es6 -o proto.js proto/*.proto
// import { PlayerMoveReq } from './proto.js';

// 编码
const reqBuffer = PlayerMoveReq.encode({
  x: 100.5, y: 200.0, frame: 1234
}).finish();

// socketManager.send(MSG_ID.PLAYER_MOVE, reqBuffer);

// 注册解码处理器
socketManager.registerHandler(MSG_ID.PLAYER_MOVE_ACK, (payload) => {
  const ack = PlayerMoveAck.decode(payload);
  if (!ack.success) {
    // 服务端纠正了位置，执行回退
    this.node.setPosition(ack.correctedX, ack.correctedY);
  }
});
```

#### 网络架构分层

```
┌─────────────────────────────────┐
│     Game Logic Layer            │  ← 业务逻辑
│     (战斗、聊天、交易)           │
├─────────────────────────────────┤
│     Protocol Layer              │  ← 协议层
│     (Protobuf 编解码 + MsgId路由)│
├─────────────────────────────────┤
│     Transport Layer             │  ← 传输层
│     (WebSocket / HTTP)          │
├─────────────────────────────────┤
│     Network Manager             │  ← 管理层
│     (心跳、重连、消息队列)        │
└─────────────────────────────────┘
```

### ⚡ 实战经验

- **心跳间隔要谨慎设置**：移动网络下 NAT 超时通常为 30-60 秒（运营商差异），心跳间隔必须短于 NAT 超时；推荐 15-20 秒发一次心跳；心跳包应尽量小（仅 MsgId 无 payload），且服务端必须回复 Ack 以双向保活
- **断线重连后的状态同步是最大痛点**：重连后不能简单继续之前的逻辑，必须向服务端请求一次全量状态同步（Reconnect + State Sync）；设计协议时预留 `reconnectToken`，重连时带上该 Token 让服务端恢复 session 而非创建新连接
- **Protobuf 在小游戏中的体积优化**：微信小游戏对包体敏感，`protobufjs` 完整版有 200KB+；务必使用 `pbjs` 预生成静态代码（`-t static-module`），而非运行时反射；进一步可用 `pbts` 生成 TypeScript 声明，配合 tree-shaking 只打包用到的消息类型
- **永远不要信任客户端数据**：移动游戏面临严重的作弊问题（脱机挂、修改器、中间人攻击）；关键数值（金币、伤害、位置）必须由服务端权威计算，客户端只做表现；网络协议加密防止篡改，但更要依赖服务端逻辑校验（加密只是提高门槛，不是万能盾牌）

### 🔗 相关问题

- 如何在弱网环境下设计帧同步游戏的乐观推进与回滚机制？
- Cocos Creator 小游戏中如何实现 HTTP 短连接的安全鉴权（Token 刷新 + 防重放）？
