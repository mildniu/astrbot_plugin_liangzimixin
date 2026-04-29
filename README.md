# astrbot_plugin_liangzimixin

这是一个给 `AstrBot` 用的量子密信平台适配插件。

它没有重写量子密信协议，而是通过 `Python + Node bridge` 的方式，直接复用原来的 `liangzimixin` 通道能力，包括登录、收发消息、文件上传下载和量子加密相关逻辑。

## 适用场景

- 已经有可用的量子密信开放平台应用
- 想把 `liangzimixin` 接到 `AstrBot`
- 希望尽量沿用原包能力，而不是从零重写协议

## 当前能力

- 支持在 `AstrBot` 里注册一个新的平台适配器：`liangzimixin`
- 支持私聊消息接入
- 支持文本回复
- 支持图片、文件、语音、视频的基础发送
- 支持按入站消息状态决定回复是否加密
- 支持把成功下载的入站媒体文件落到当前会话工作目录

## 当前限制

- 这版优先保证私聊场景
- 入站媒体下载已经补了多轮兼容，但部分文件下载链接仍可能失败
- 加密消息解密依赖原量子运行环境，环境没初始化好时会降级
- `AstrBot` 对文件内容理解，仍取决于文件是否真的成功下载、以及你当前的模型或文件提取配置

## 目录结构

- `main.py`：插件入口
- `liangzimixin_adapter.py`：AstrBot 平台适配器
- `liangzimixin_event.py`：消息事件发送逻辑
- `bridge_client.py`：Python 到 Node 的桥接客户端
- `bridge/bridge.cjs`：Node 侧桥接脚本
- `bridge/vendor/liangzimixin`：复用的原始通道包

## 安装

1. 把整个目录放到 `AstrBot/data/plugins/astrbot_plugin_liangzimixin`
2. 确保运行 `AstrBot` 的环境里可以调用 `node`
3. `Node` 版本建议用 `20+`
4. 在 `AstrBot` WebUI 里加载插件
5. 在平台适配器里新增 `liangzimixin`

## 配置项

最少需要这些：

- `app_id`：开放平台分配的应用 ID
- `app_secret`：开放平台分配的应用密钥
- `env`：可选 `test`、`staging`、`production`

建议一起配上：

- `bot_user_id`：避免机器人处理自己发出的消息
- `quantum_account`：需要量子加密能力时填写
- `node_command`：如果 `node` 不在系统 PATH，可以填绝对路径

如果你不是走原包默认地址，再补这些：

- `ws_url`
- `auth_url`
- `message_url`
- `file_url`
- `allow_private_network`

## 配置建议

- 只想先跑通明文消息时，可以先不填 `quantum_account`
- 如果回复不该默认加密，保持 `encryption_mode` 为 `quantum_and_plain`
- 如果入站图片或文件已经成功下载，文件会放到当前会话工作目录下的 `inbound_files`

## 排查顺序

出现“消息收到了，但文件没法用”时，先看这几类日志：

- `download:getUrl`：说明已经拿到文件下载地址
- `fetchRemoteMedia succeeded`：说明文件内容真正下载成功
- `download:done`：说明文件已经落到临时目录
- `staged inbound media to workspace`：说明文件已经复制到会话工作目录

如果只看到 `[file]`，通常表示文件消息到了，但文件本体还没成功落地。

## 版本说明

当前版本：`0.1.0`
