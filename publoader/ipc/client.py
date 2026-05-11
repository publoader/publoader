import json
import socket
from pathlib import Path
from typing import Optional

from publoader.ipc.server import SOCKET_PATH


class IPCClient:
    """Thin client for the publoader IPC unix socket."""

    def __init__(self, socket_path: Optional[Path] = None, timeout: float = 5.0):
        self.socket_path = Path(socket_path or SOCKET_PATH)
        self.timeout = timeout

    def call(self, cmd: str, **payload) -> dict:
        request = dict(payload)
        request["cmd"] = cmd

        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(str(self.socket_path))
            sock.sendall((json.dumps(request) + "\n").encode("utf-8"))

            buf = bytearray()
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                buf.extend(chunk)
                if b"\n" in chunk:
                    break
        finally:
            sock.close()

        if not buf:
            return {"ok": False, "error": "empty response"}
        try:
            return json.loads(buf.decode("utf-8").splitlines()[0])
        except (json.JSONDecodeError, IndexError) as e:
            return {"ok": False, "error": f"bad response: {e}"}


def ipc_call(cmd: str, **payload) -> dict:
    return IPCClient().call(cmd, **payload)


def is_instance_running(socket_path: Optional[Path] = None) -> bool:
    """Cheap liveness check: try a ping. Returns False on any error."""
    path = Path(socket_path or SOCKET_PATH)
    if not path.exists():
        return False
    try:
        result = IPCClient(path, timeout=1.0).call("ping")
    except (OSError, socket.error):
        return False
    return bool(result.get("ok") and result.get("pong"))
