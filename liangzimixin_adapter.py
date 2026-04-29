import asyncio
import os
from pathlib import Path
from typing import Any, cast

from astrbot.api import logger
from astrbot.api.event import MessageChain
from astrbot.api.message_components import At, File, Image, Plain, Record, Reply, Video
from astrbot.api.platform import (
    AstrBotMessage,
    Group,
    MessageMember,
    MessageType,
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)
from astrbot.core.platform.astr_message_event import MessageSesion

from .bridge_client import LiangzimixinBridgeClient
from .liangzimixin_event import LiangzimixinMessageEvent

DEFAULT_CONFIG = {
    "app_id": "",
    "app_secret": "",
    "quantum_account": "",
    "bot_user_id": "",
    "env": "production",
    "encryption_mode": "quantum_and_plain",
    "node_command": "node",
    "ws_url": "",
    "auth_url": "",
    "message_url": "",
    "file_url": "",
    "allow_private_network": False,
}

CONFIG_METADATA = {
    "app_id": {
        "description": "应用 ID",
        "type": "string",
        "hint": "量子密信开放平台分配的 appId。",
    },
    "app_secret": {
        "description": "应用密钥",
        "type": "string",
        "hint": "量子密信开放平台分配的 appSecret。",
    },
    "quantum_account": {
        "description": "量子账户标识",
        "type": "string",
        "hint": "填写后启用量子加密解密流程，不填则走明文透传模式。",
    },
    "bot_user_id": {
        "description": "Bot 用户 ID",
        "type": "string",
        "hint": "用于防止机器人处理自己发出的消息。",
    },
    "env": {
        "description": "部署环境",
        "type": "string",
        "hint": "可选值：test、staging、production。",
    },
    "encryption_mode": {
        "description": "消息加密模式",
        "type": "string",
        "hint": "可选值：quantum_only、quantum_and_plain。",
    },
    "node_command": {
        "description": "Node 命令",
        "type": "string",
        "hint": "默认填 node。若 AstrBot 运行环境里 Node 不在 PATH，可以填绝对路径。",
    },
    "ws_url": {
        "description": "自定义 WebSocket 地址",
        "type": "string",
        "hint": "留空时按 env 使用原插件内置预设。",
    },
    "auth_url": {
        "description": "自定义鉴权地址",
        "type": "string",
        "hint": "留空时按 env 使用原插件内置预设。",
    },
    "message_url": {
        "description": "自定义消息服务地址",
        "type": "string",
        "hint": "留空时按 env 使用原插件内置预设。",
    },
    "file_url": {
        "description": "自定义文件服务地址",
        "type": "string",
        "hint": "留空时按 env 使用原插件内置预设。",
    },
    "allow_private_network": {
        "description": "允许访问内网文件地址",
        "type": "bool",
        "hint": "只有文件服务或下载地址在内网时才打开。",
    },
}


@register_platform_adapter(
    "liangzimixin",
    "量子密信 AstrBot 适配器",
    default_config_tmpl=DEFAULT_CONFIG,
    support_streaming_message=False,
    config_metadata=CONFIG_METADATA,
)
class LiangzimixinPlatformAdapter(Platform):
    def __init__(
        self,
        platform_config: dict[str, Any],
        platform_settings: dict[str, Any],
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(platform_config, event_queue)
        self.settings = platform_settings
        self._shutdown_event = asyncio.Event()
        self._consumer_task: asyncio.Task[None] | None = None
        plugin_root = Path(__file__).resolve().parent
        node_command = str(platform_config.get("node_command") or "node")
        self.bridge = LiangzimixinBridgeClient(plugin_root=plugin_root, node_command=node_command)

    def meta(self) -> PlatformMetadata:
        return PlatformMetadata(
            name="liangzimixin",
            description="量子密信 AstrBot 适配器",
            id=cast(str, self.config.get("id", "liangzimixin")),
            support_streaming_message=False,
        )

    async def run(self) -> None:
        config = self._build_bridge_config()
        await self.bridge.start(config)
        self._consumer_task = asyncio.create_task(self._consume_bridge_events())
        await self._shutdown_event.wait()

    async def terminate(self) -> None:
        self._shutdown_event.set()
        await self.bridge.close()
        if self._consumer_task:
            self._consumer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._consumer_task

    async def send_by_session(
        self,
        session: MessageSesion,
        message_chain: MessageChain,
    ) -> None:
        await self.send_message_chain(session.session_id, message_chain)
        await super().send_by_session(session, message_chain)

    async def send_message_chain(
        self,
        chat_id: str,
        message_chain: MessageChain,
        default_reply_to: str | None = None,
    ) -> None:
        reply_to = default_reply_to or ""
        text_parts: list[str] = []

        async def flush_text() -> None:
            nonlocal reply_to
            text = "".join(text_parts).strip()
            if not text:
                text_parts.clear()
                return
            await self._send_text_chunks(chat_id, text, reply_to or None)
            text_parts.clear()
            reply_to = ""

        for component in message_chain.chain:
            if isinstance(component, Reply):
                reply_to = str(component.id)
                continue
            if isinstance(component, Plain):
                text_parts.append(component.text)
                continue
            if isinstance(component, At):
                target = getattr(component, "qq", "")
                if target:
                    text_parts.append(f"@{target} ")
                continue
            if isinstance(component, Image):
                await flush_text()
                path = await component.convert_to_file_path()
                await self.bridge.send_media(chat_id, path, os.path.basename(path))
                continue
            if isinstance(component, Record):
                await flush_text()
                path = await component.convert_to_file_path()
                await self.bridge.send_media(chat_id, path, os.path.basename(path))
                continue
            if isinstance(component, Video):
                await flush_text()
                path = await component.convert_to_file_path()
                await self.bridge.send_media(chat_id, path, os.path.basename(path))
                continue
            if isinstance(component, File):
                await flush_text()
                path = await component.get_file()
                name = component.name or os.path.basename(path)
                await self.bridge.send_media(chat_id, path, name)
                continue

            text_parts.append(f"[{component.type}]")

        await flush_text()

    async def _send_text_chunks(
        self,
        chat_id: str,
        text: str,
        reply_to_message_id: str | None = None,
        chunk_size: int = 1800,
    ) -> None:
        remaining = text
        first_reply = reply_to_message_id
        while remaining:
            chunk = remaining[:chunk_size]
            remaining = remaining[chunk_size:]
            await self.bridge.send_text(chat_id, chunk, first_reply)
            first_reply = None

    async def _consume_bridge_events(self) -> None:
        while not self._shutdown_event.is_set():
            event = await self.bridge.next_event()
            if event.get("type") != "inbound":
                continue
            payload = cast(dict[str, Any], event.get("payload", {}))
            astr_message = self._build_astr_message(payload)
            message_event = LiangzimixinMessageEvent(
                message_str=astr_message.message_str,
                message_obj=astr_message,
                platform_meta=self.meta(),
                session_id=astr_message.session_id,
                adapter=self,
            )
            media = payload.get("media") or {}
            local_path = media.get("local_path")
            if local_path:
                message_event.track_temporary_local_file(local_path)
            self.commit_event(message_event)

    def _build_astr_message(self, payload: dict[str, Any]) -> AstrBotMessage:
        message = AstrBotMessage()
        group_id = str(payload.get("group_id") or "")
        sender_id = str(payload.get("sender_id") or "")
        sender_name = str(payload.get("sender_name") or sender_id)
        chat_id = str(payload.get("chat_id") or sender_id)
        text = str(payload.get("text") or "")
        msg_type = str(payload.get("msg_type") or "text")
        media = cast(dict[str, Any], payload.get("media") or {})

        components: list[Any] = []
        if text:
            components.append(Plain(text))

        local_path = str(media.get("local_path") or "")
        resource_type = str(media.get("resource_type") or "")
        file_name = str(media.get("file_name") or os.path.basename(local_path) or "attachment")
        if local_path:
            if resource_type == "image":
                components.append(Image.fromFileSystem(local_path))
            elif resource_type == "voice":
                components.append(Record.fromFileSystem(local_path))
            elif resource_type == "video":
                components.append(Video.fromFileSystem(local_path))
            else:
                components.append(File(name=file_name, file=local_path))

        if not components:
            components.append(Plain(text or f"[{msg_type}]"))

        message.type = MessageType.GROUP_MESSAGE if group_id else MessageType.FRIEND_MESSAGE
        message.self_id = str(self.config.get("bot_user_id") or self.config.get("app_id") or self.meta().id)
        message.session_id = group_id or chat_id
        message.message_id = str(payload.get("message_id") or "")
        message.sender = MessageMember(user_id=sender_id, nickname=sender_name)
        message.message = components
        message.message_str = text or f"[{msg_type}]"
        message.raw_message = payload
        message.timestamp = int(payload.get("timestamp") or 0)
        if group_id:
            message.group = Group(group_id=group_id)
        return message

    def _build_bridge_config(self) -> dict[str, Any]:
        return {
            "app_id": str(self.config.get("app_id") or ""),
            "app_secret": str(self.config.get("app_secret") or ""),
            "quantum_account": str(self.config.get("quantum_account") or ""),
            "bot_user_id": str(self.config.get("bot_user_id") or ""),
            "env": str(self.config.get("env") or "production"),
            "encryption_mode": str(self.config.get("encryption_mode") or "quantum_and_plain"),
            "internal_overrides": {
                "transport": {
                    "wsUrl": str(self.config.get("ws_url") or ""),
                },
                "auth": {
                    "serverUrl": str(self.config.get("auth_url") or ""),
                },
                "message": {
                    "messageServiceBaseUrl": str(self.config.get("message_url") or ""),
                },
                "file": {
                    "fileServiceBaseUrl": str(self.config.get("file_url") or ""),
                    "allowPrivateNetwork": bool(self.config.get("allow_private_network", False)),
                },
            },
        }


import contextlib
