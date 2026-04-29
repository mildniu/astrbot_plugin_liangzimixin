import asyncio
import contextlib
import os
import shutil
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

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
from astrbot.core.tools.computer_tools.util import normalize_umo_for_workspace
from astrbot.core.utils.astrbot_path import get_astrbot_workspaces_path

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
        encrypt_reply: bool = False,
    ) -> None:
        reply_to = default_reply_to or ""
        text_parts: list[str] = []
        skip_encrypt = not encrypt_reply

        async def flush_text() -> None:
            nonlocal reply_to
            text = "".join(text_parts).strip()
            if not text:
                text_parts.clear()
                return
            await self._send_text_chunks(
                chat_id,
                text,
                reply_to or None,
                skip_encrypt=skip_encrypt,
            )
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
                await self.bridge.send_media(
                    chat_id,
                    path,
                    os.path.basename(path),
                    skip_encrypt=skip_encrypt,
                )
                continue
            if isinstance(component, Record):
                await flush_text()
                path = await component.convert_to_file_path()
                await self.bridge.send_media(
                    chat_id,
                    path,
                    os.path.basename(path),
                    skip_encrypt=skip_encrypt,
                )
                continue
            if isinstance(component, Video):
                await flush_text()
                path = await component.convert_to_file_path()
                await self.bridge.send_media(
                    chat_id,
                    path,
                    os.path.basename(path),
                    skip_encrypt=skip_encrypt,
                )
                continue
            if isinstance(component, File):
                await flush_text()
                path = await component.get_file()
                name = component.name or os.path.basename(path)
                await self.bridge.send_media(
                    chat_id,
                    path,
                    name,
                    skip_encrypt=skip_encrypt,
                )
                continue

            text_parts.append(f"[{component.type}]")

        await flush_text()

    async def _send_text_chunks(
        self,
        chat_id: str,
        text: str,
        reply_to_message_id: str | None = None,
        skip_encrypt: bool = True,
        chunk_size: int = 1800,
    ) -> None:
        remaining = text
        first_reply = reply_to_message_id
        while remaining:
            chunk = remaining[:chunk_size]
            remaining = remaining[chunk_size:]
            await self.bridge.send_text(
                chat_id,
                chunk,
                first_reply,
                skip_encrypt=skip_encrypt,
            )
            first_reply = None

    async def _consume_bridge_events(self) -> None:
        while not self._shutdown_event.is_set():
            event = await self.bridge.next_event()
            if event.get("type") != "inbound":
                continue
            payload = cast(dict[str, Any], event.get("payload", {}))
            original_local_path = self._stage_inbound_media_to_workspace(payload)
            astr_message = self._build_astr_message(payload)
            message_event = LiangzimixinMessageEvent(
                message_str=astr_message.message_str,
                message_obj=astr_message,
                platform_meta=self.meta(),
                session_id=astr_message.session_id,
                adapter=self,
            )
            if original_local_path:
                message_event.track_temporary_local_file(original_local_path)
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
        resource_type = self._resolve_inbound_resource_type(
            msg_type,
            media,
            local_path,
        )
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

    def _stage_inbound_media_to_workspace(self, payload: dict[str, Any]) -> str:
        media = cast(dict[str, Any], payload.get("media") or {})
        local_path = str(media.get("local_path") or "")
        if not local_path or not os.path.exists(local_path):
            return ""

        session_id = str(payload.get("group_id") or payload.get("chat_id") or "")
        if not session_id:
            return local_path

        group_id = str(payload.get("group_id") or "")
        message_type = (
            MessageType.GROUP_MESSAGE.value
            if group_id
            else MessageType.FRIEND_MESSAGE.value
        )
        file_name = str(
            media.get("file_name") or os.path.basename(local_path) or "attachment"
        )

        try:
            umo = f"{self.meta().id}:{message_type}:{session_id}"
            workspace_dir = (
                Path(get_astrbot_workspaces_path())
                / normalize_umo_for_workspace(umo)
                / "inbound_files"
            )
            workspace_dir.mkdir(parents=True, exist_ok=True)

            safe_name = self._sanitize_workspace_file_name(file_name)
            target = workspace_dir / safe_name
            if target.exists():
                stem = Path(safe_name).stem or "attachment"
                suffix = Path(safe_name).suffix
                target = workspace_dir / f"{stem}_{uuid4().hex[:8]}{suffix}"

            shutil.copy2(local_path, target)
            media["local_path"] = str(target)
            logger.info("staged inbound media to workspace: %s", target)
        except Exception as exc:
            logger.warning("stage inbound media to workspace failed: %s", exc)

        return local_path

    @staticmethod
    def _sanitize_workspace_file_name(file_name: str) -> str:
        safe_name = os.path.basename(file_name.strip()) or "attachment"
        return "".join(
            "_" if char in '<>:"/\\|?*' or ord(char) < 32 else char
            for char in safe_name
        )

    @staticmethod
    def _resolve_inbound_resource_type(
        msg_type: str,
        media: dict[str, Any],
        local_path: str,
    ) -> str:
        resource_type = str(media.get("resource_type") or "").strip().lower()
        mime_type = str(media.get("mime_type") or "").strip().lower()
        file_name = str(media.get("file_name") or os.path.basename(local_path) or "").lower()
        suffix = Path(file_name).suffix.lower()

        if msg_type in {"image", "voice", "video", "file"}:
            # 平台原始消息类型比 download 返回的 octet-stream 更可靠。
            if msg_type == "image":
                return "image"
            if msg_type == "voice":
                return "voice"
            if msg_type == "video":
                return "video"
            if resource_type:
                return resource_type
            return "file"

        if resource_type in {"image", "voice", "video", "file"}:
            return resource_type
        if mime_type.startswith("image/"):
            return "image"
        if mime_type.startswith("audio/"):
            return "voice"
        if mime_type.startswith("video/"):
            return "video"
        if suffix in {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic"}:
            return "image"
        if suffix in {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".amr"}:
            return "voice"
        if suffix in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
            return "video"
        return "file"
