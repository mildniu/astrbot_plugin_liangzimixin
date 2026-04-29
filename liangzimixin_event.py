from typing import TYPE_CHECKING

from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.platform import AstrBotMessage, PlatformMetadata

if TYPE_CHECKING:
    from .liangzimixin_adapter import LiangzimixinPlatformAdapter


class LiangzimixinMessageEvent(AstrMessageEvent):
    def __init__(
        self,
        message_str: str,
        message_obj: AstrBotMessage,
        platform_meta: PlatformMetadata,
        session_id: str,
        adapter: "LiangzimixinPlatformAdapter",
    ) -> None:
        super().__init__(message_str, message_obj, platform_meta, session_id)
        self.adapter = adapter

    async def send(self, message: MessageChain):
        await self.adapter.send_message_chain(
            self.get_session_id(),
            message,
            default_reply_to=str(getattr(self.message_obj, "message_id", "") or ""),
        )
        await super().send(message)
