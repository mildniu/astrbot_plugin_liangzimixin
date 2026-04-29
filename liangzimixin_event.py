import asyncio
import re
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.message_components import Plain
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
        if not message.chain:
            return
        await self.adapter.send_message_chain(
            self.get_session_id(),
            message,
            default_reply_to=str(getattr(self.message_obj, "message_id", "") or ""),
        )
        await super().send(message)

    async def send_streaming(
        self,
        generator: AsyncGenerator,
        use_fallback: bool = False,
    ):
        if not use_fallback:
            buffer = None
            async for chain in generator:
                if not buffer:
                    buffer = chain
                else:
                    buffer.chain.extend(chain.chain)
            if not buffer:
                return None
            buffer.squash_plain()
            await self.send(buffer)
            return await super().send_streaming(generator, use_fallback)

        text_buffer = ""
        sentence_pattern = re.compile(r"[^。？！~…]+[。？！~…]+")

        async for chain in generator:
            if not isinstance(chain, MessageChain):
                continue
            for component in chain.chain:
                if isinstance(component, Plain):
                    text_buffer += component.text
                    if any(mark in text_buffer for mark in "。？！~…"):
                        text_buffer = await self.process_buffer(
                            text_buffer,
                            sentence_pattern,
                        )
                    continue

                if text_buffer.strip():
                    await self.send(MessageChain([Plain(text_buffer)]))
                    text_buffer = ""

                await self.send(MessageChain(chain=[component]))
                await asyncio.sleep(1.5)

        if text_buffer.strip():
            await self.send(MessageChain([Plain(text_buffer)]))
        return await super().send_streaming(generator, use_fallback)
