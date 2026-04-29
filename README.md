# astrbot_plugin_liangzimixin

这是一个 `AstrBot` 插件式平台适配器，用来复用现成的 `liangzimixin` 量子密信 `OpenClaw` 通道能力。

目录上保留了 `main.py`、`README.md`、`requirements.txt`，方便按 AstrBot Wiki 的插件约定直接放进 `data/plugins` 里使用。

## 这版做了什么

- 用 `AstrBot` 插件注册了一个新的平台适配器：`liangzimixin`
- 用本地 `Node` 桥接复用了原包里的登录、收发消息、文件上传下载、量子加密逻辑
- 保留了原 `quantum-sdk` 和 `wasm` 运行时，不额外重写协议

## 安装

1. 把整个目录放到 `AstrBot/data/plugins/astrbot_plugin_liangzimixin`
2. 确保运行 AstrBot 的环境里有 `node`，版本建议 `20+`
3. 在 AstrBot WebUI 里加载插件
4. 在平台适配器里新增 `liangzimixin`

## 最小配置

- `app_id`
- `app_secret`
- `quantum_account`：可选，不填时走明文透传
- `bot_user_id`：建议填写，避免自回环
- `env`：`test`、`staging`、`production`

如果你的服务地址不是原包预设，再补：

- `ws_url`
- `auth_url`
- `message_url`
- `file_url`

## 当前说明

- 文本、图片、文件、语音、视频的基本收发都走原包能力
- 这版优先保证私聊直连场景
- 如果 AstrBot 运行环境里 `node` 不在 PATH，可以把 `node_command` 改成绝对路径
