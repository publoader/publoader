import json
import logging
import os
import socket
import socketserver
import threading
from pathlib import Path
from typing import Callable, Dict, Optional

from publoader.utils.utils import root_path

logger = logging.getLogger("publoader")

SOCKET_PATH = Path(
    os.environ.get("PUBLOADER_SOCKET", str(root_path.joinpath("resources", "publoader.sock")))
)
PID_FILE = root_path.joinpath("resources", "publoader.pid")

CommandHandler = Callable[[dict], dict]


class _Handler(socketserver.StreamRequestHandler):
    server: "IPCServer"

    def handle(self) -> None:
        try:
            raw = self.rfile.readline()
            if not raw:
                return
            try:
                request = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as e:
                self._reply({"ok": False, "error": f"bad json: {e}"})
                return

            cmd = request.get("cmd")
            handler = self.server.handlers.get(cmd) if cmd else None
            if handler is None:
                self._reply({"ok": False, "error": f"unknown cmd: {cmd!r}"})
                return

            try:
                result = handler(request) or {}
                if "ok" not in result:
                    result["ok"] = True
                self._reply(result)
            except Exception as e:
                logger.exception(f"IPC handler {cmd!r} raised")
                self._reply({"ok": False, "error": str(e)})
        except OSError as e:
            logger.warning(f"IPC client disconnected mid-request: {e}")

    def _reply(self, payload: dict) -> None:
        try:
            self.wfile.write((json.dumps(payload) + "\n").encode("utf-8"))
        except OSError as e:
            logger.warning(f"Couldn't write IPC reply: {e}")


class _UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


class IPCServer:
    """Background unix-socket server that dispatches JSON commands to handlers."""

    def __init__(self, socket_path: Path = SOCKET_PATH):
        self.socket_path = Path(socket_path)
        self.handlers: Dict[str, CommandHandler] = {}
        self._server: Optional[_UnixServer] = None
        self._thread: Optional[threading.Thread] = None
        self.register("ping", lambda _req: {"pong": True})

    def register(self, cmd: str, handler: CommandHandler) -> None:
        self.handlers[cmd] = handler

    def start(self) -> None:
        if self._server is not None:
            return

        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        # Stale socket from a crashed prior run
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass

        self._server = _UnixServer(str(self.socket_path), _Handler)
        self._server.handlers = self.handlers  # type: ignore[attr-defined]
        # Restrict to current user — sockets are world-rw by default
        try:
            os.chmod(self.socket_path, 0o600)
        except OSError:
            pass

        try:
            PID_FILE.parent.mkdir(parents=True, exist_ok=True)
            PID_FILE.write_text(str(os.getpid()))
        except OSError as e:
            logger.warning(f"Couldn't write pid file: {e}")

        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="publoader-ipc",
            daemon=True,
        )
        self._thread.start()
        logger.info(f"IPC server listening on {self.socket_path}")

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        try:
            self.socket_path.unlink()
        except FileNotFoundError:
            pass
        try:
            PID_FILE.unlink()
        except FileNotFoundError:
            pass
