import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from astrbot.api import logger


class BridgeClosedError(RuntimeError):
    pass


class LiangzimixinBridgeClient:
    def __init__(self, plugin_root: Path, node_command: str = "node") -> None:
        self.plugin_root = plugin_root
        self.node_command = node_command
        self.process: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    @property
    def started(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def start(self, config: dict[str, Any]) -> dict[str, Any]:
        if self.started:
            return {"already_started": True}

        script = self.plugin_root / "bridge" / "bridge.cjs"
        self.process = await asyncio.create_subprocess_exec(
            self.node_command,
            str(script),
            cwd=str(self.plugin_root),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._stdout_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        return await self.request("start", {"config": config}, timeout=120)

    async def close(self) -> None:
        process = self.process
        if not process:
            return

        try:
            if process.returncode is None:
                await self.request("shutdown", {}, timeout=20)
        except Exception as exc:
            logger.warning("liangzimixin bridge shutdown failed: %s", exc)

        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=10)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

        for task in (self._stdout_task, self._stderr_task):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

        self._reject_all_pending("bridge closed")
        self.process = None
        self._stdout_task = None
        self._stderr_task = None

    async def request(
        self,
        action: str,
        payload: dict[str, Any],
        timeout: float = 60,
    ) -> Any:
        process = self.process
        if not process or process.returncode is not None or not process.stdin:
            raise BridgeClosedError("bridge process is not running")

        request_id = uuid4().hex
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        message = {"id": request_id, "action": action, "payload": payload}
        process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        await process.stdin.drain()

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(request_id, None)

    async def next_event(self) -> dict[str, Any]:
        return await self._events.get()

    async def send_text(
        self,
        chat_id: str,
        text: str,
        reply_to_message_id: str | None = None,
    ) -> Any:
        return await self.request(
            "send_text",
            {
                "chat_id": chat_id,
                "text": text,
                "reply_to_message_id": reply_to_message_id or "",
            },
        )

    async def send_media(
        self,
        chat_id: str,
        local_path: str,
        file_name: str | None = None,
    ) -> Any:
        return await self.request(
            "send_media",
            {
                "chat_id": chat_id,
                "local_path": local_path,
                "file_name": file_name or "",
            },
            timeout=180,
        )

    async def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        while True:
            raw = await self.process.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if not line.startswith("{"):
                logger.info("[liangzimixin-bridge/stdout] %s", line)
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("liangzimixin bridge stdout is not valid JSON: %s", line)
                continue

            request_id = message.get("id")
            if request_id and request_id in self._pending:
                future = self._pending[request_id]
                if future.done():
                    continue
                if message.get("ok", False):
                    future.set_result(message.get("result"))
                else:
                    future.set_exception(RuntimeError(message.get("error", "unknown bridge error")))
                continue

            await self._events.put(message)

        self._reject_all_pending("bridge stdout closed")

    async def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        while True:
            raw = await self.process.stderr.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                logger.info("[liangzimixin-bridge] %s", line)

    def _reject_all_pending(self, message: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(BridgeClosedError(message))
