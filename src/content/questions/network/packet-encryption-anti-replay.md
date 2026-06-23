---
title: "游戏网络协议安全：包加密、防重放、防篡改怎么做？"
category: "network"
level: 3
tags: ["网络安全", "加密", "防重放", "防篡改", "DTLS", "反作弊"]
related: ["network/anti-cheat-detection", "network/server-authority-vs-client-trust"]
hint: "加密防窃听、MAC 防篡改、序列号防重放——三层防线缺一不可。"
---

## 参考答案

### ✅ 核心要点

1. **保密性（Confidentiality）**：用对称加密（AES-GCM / ChaCha20-Poly1305）加密 payload，防止中间人窃听
2. **完整性（Integrity）**：用 AEAD 认证标签或 HMAC 校验数据未被篡改
3. **防重放（Anti-Replay）**：用单调递增序列号 + 滑动窗口拒绝旧包重复投递
4. **密钥交换（Key Exchange）**：连接建立时通过 ECDHE 协商会话密钥，实现前向安全
5. **性能取舍**：加密引入 ~1-2% CPU 开销，在游戏中可接受；优先加密协议敏感字段而非全包

### 📖 深度展开

#### 安全层次模型

```
┌─────────────────────────────────┐
│  Application Layer              │
│  (反作弊逻辑、速度校验等)         │
├─────────────────────────────────┤
│  Anti-Tamper (完整性)            │
│  MAC / AEAD Auth Tag             │
├─────────────────────────────────┤
│  Anti-Replay (防重放)            │
│  Sequence Number + Sliding Window│
├─────────────────────────────────┤
│  Encryption (保密性)             │
│  AES-256-GCM / ChaCha20-Poly1305 │
├─────────────────────────────────┤
│  Transport (UDP / TCP / QUIC)    │
└─────────────────────────────────┘
```

#### 密钥协商流程（ECDHE）

```
Client                          Server
  |                               |
  |--- ClientHello + PubKeyC --->|
  |<-- ServerHello + PubKeyS ----|
  |                               |
  |  双方用 ECDHE 算出共享密钥 K   |
  |                               |
  |--- 数据包 [Seq=0, AES-GCM(K)]-->|
  |<-- 数据包 [Seq=0, AES-GCM(K)]---|
```

#### AEAD 加密示例（AES-256-GCM）

```cpp
// 加密：plaintext → ciphertext + auth_tag
void encrypt_packet(
    const uint8_t* key,         // 256-bit session key
    uint64_t seq,               // 序列号（同时作为 nonce 一部分）
    const uint8_t* plaintext,   // 原始游戏数据
    size_t len,
    uint8_t* ciphertext,        // 输出密文
    uint8_t* auth_tag           // 输出 16 字节认证标签
) {
    uint8_t nonce[12];
    build_nonce(nonce, seq);    // seq + client_id 组合成 nonce

    AES256_GCM_CTX ctx;
    aes256_gcm_init(&ctx, key, nonce);
    // 可附加 AAD（Additional Authenticated Data）：协议版本、包类型
    aes256_gcm_update_aad(&ctx, header_bytes, header_len);
    aes256_gcm_encrypt(&ctx, plaintext, len, ciphertext);
    aes256_gcm_final(&ctx, auth_tag);
}

// 解密时先验证 auth_tag，失败则丢弃，不暴露明文
bool decrypt_packet(...) {
    if (!aes256_gcm_verify_tag(&ctx, auth_tag)) {
        return false;  // 篡改或密钥不匹配，直接丢弃
    }
    aes256_gcm_decrypt(&ctx, ciphertext, len, plaintext);
    return true;
}
```

#### 防重放滑动窗口

```cpp
class ReplayFilter {
    static constexpr int WINDOW_SIZE = 64;  // 窗口大小
    uint64_t highest_seq = 0;
    uint64_t bitmap[WINDOW_SIZE] = {0};     // bitmap 记录已收 seq

public:
    bool check_and_mark(uint64_t seq) {
        if (seq == 0) return false;          // seq 0 保留，不允许使用

        if (seq > highest_seq) {
            // 新最高包，滑动窗口
            uint64_t shift = seq - highest_seq;
            if (shift >= WINDOW_SIZE * 64) {
                memset(bitmap, 0, sizeof(bitmap));  // 完全超出窗口，清空
            } else {
                // 右移 bitmap
                slide_right(shift);
            }
            set_bit(seq);
            highest_seq = seq;
            return true;
        }

        // seq 在窗口内或低于窗口
        uint64_t diff = highest_seq - seq;
        if (diff >= WINDOW_SIZE * 64) {
            return false;  // 太旧，拒绝
        }

        if (get_bit(seq)) {
            return false;  // 已收到过，重放攻击
        }

        set_bit(seq);
        return true;
    }
};
```

#### 方案对比

| 方案 | 保密性 | 完整性 | 防重放 | 性能 | 适用场景 |
|------|--------|--------|--------|------|----------|
| 明文 | ❌ | ❌ | ❌ | 最快 | 内网测试 |
| HMAC only | ❌ | ✅ | 需自实现 | 快 | 防篡改要求高但不怕窃听 |
| DTLS | ✅ | ✅ | ✅ | 中等 | UDP 游戏通用方案 |
| AES-GCM 自研 | ✅ | ✅ | 需自实现 | 快 | 需要精细控制的高性能场景 |
| QUIC 内置 TLS 1.3 | ✅ | ✅ | ✅ | 中等 | 现代游戏推荐 |

#### QUIC / TLS 1.3 的优势

QUIC 原生集成 TLS 1.3，天然提供加密 + 完整性 + 防重放：

- **0-RTT 恢复**：重连时首包即可携带数据（但需注意 0-RTT 有重放风险，只用于幂等请求）
- **前向安全**：ECDHE 每次连接生成新密钥，密钥泄露不影响历史数据
- **连接迁移**：IP 变化不断连接（移动网络切换场景）

### ⚡ 实战经验

1. **不要自己设计加密算法**——用 AES-GCM / ChaCha20-Poly1305 等经过审计的 AEAD 方案；自研加密几乎必然出漏洞
2. **Nonce 复用是致命错误**——AES-GCM 中 nonce 重复会导致密钥泄露；用序列号 + client_id 组合生成，且序列号必须单调递增、永不回绕
3. **选择性加密**——对高频但非敏感的数据（如位置同步）可只做 MAC 校验不加密，节省 CPU；但对登录令牌、交易指令必须全加密
4. **密钥轮换**——长连接每隔几小时或达到一定包量后重新协商密钥，降低密钥泄露影响面

### 🔗 相关问题

- 服务器权威架构下，客户端篡改本地内存绕过校验怎么防？
- 如何在不影响首包延迟的前提下完成密钥协商？
- QUIC 0-RTT 的重放攻击风险在游戏中如何规避？
