# liangzimixin (量子密信)

[![npm version](https://img.shields.io/npm/v/liangzimixin.svg)](https://www.npmjs.com/package/liangzimixin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

量子加密即时通信 (Quantum-encrypted IM) 渠道插件，用于 [OpenClaw](https://openclaw.ai) 平台。

## 功能特性

- 💬 **即时通信** — 消息收发、撤回
- 🔐 **量子加密** — 端到端量子密钥加密，安全通信
- 📎 **文件传输** — 图片/文件上传下载，支持分片
- 🔄 **自动重连** — WebSocket 心跳保活 + 断线自动重连
- 🔔 **推送通知** — Cockatoo 推送（可选）
- 🔑 **OAuth 认证** — Seal OAuth 自动注册/Token 管理

## 安装

```bash
openclaw plugins install liangzimixin
```

## 要求

- **Node.js**: `v20` 或更高
- **OpenClaw**: `2026.2.26` 或更高（`openclaw -v` 检查版本）

## 配置

安装后在 OpenClaw 配置文件中添加插件配置：

```yaml
plugins:
  entries:
    liangzimixin:
      config:
        credentials:
          appId: "你的应用 ID"
          appSecret: "你的应用密钥"
          account: "账户标识"
          quantumId: "量子服务 ID"
          quantumSecret: "量子服务密钥"
        transport:
          wsUrl: "wss://im.example.com/ws"
        auth:
          serverUrl: "http://seal.example.com:8080"
          clientName: "my-liangzimixin"
        message:
          messageServiceBaseUrl: "https://msg.example.com/api/v1"
        file:
          fileServiceBaseUrl: "https://fs.example.com/api/v1"
```

## 使用

配置完成后重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

插件将自动连接到密信 IM 服务器，开始接收和发送消息。

## License

[MIT](./LICENSE)
