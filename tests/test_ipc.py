import logging
import os
import tempfile
import uuid
from pathlib import Path

import pytest

from publoader.ipc.client import IPCClient
from publoader.ipc.server import IPCServer


@pytest.fixture
def ipc():
    # AF_UNIX paths are capped around ~104 bytes on macOS — pytest's tmp_path
    # often exceeds that, so we use a short /tmp path and clean up by hand.
    sock = Path(tempfile.gettempdir()) / f"pl-{uuid.uuid4().hex[:8]}.sock"
    server = IPCServer(socket_path=sock)
    server.start()
    try:
        yield server, sock
    finally:
        server.stop()
        try:
            sock.unlink()
        except FileNotFoundError:
            pass


def test_ping_roundtrip(ipc):
    server, sock = ipc
    client = IPCClient(sock)
    result = client.call("ping")
    assert result.get("ok") is True
    assert result.get("pong") is True


def test_unknown_command_returns_error(ipc):
    server, sock = ipc
    result = IPCClient(sock).call("not_a_real_command")
    assert result.get("ok") is False
    assert "unknown" in result.get("error", "")


def test_handler_can_return_data(ipc):
    server, sock = ipc

    def echo(req):
        return {"echoed": req.get("value")}

    server.register("echo", echo)
    result = IPCClient(sock).call("echo", value="hello")
    assert result == {"ok": True, "echoed": "hello"}


def test_handler_exception_returned_as_error(ipc, caplog):
    server, sock = ipc

    def boom(_req):
        raise RuntimeError("intentional")

    server.register("boom", boom)
    # Server logs the exception via logger.exception — capture instead of letting
    # it print to stderr and pollute the test output.
    with caplog.at_level(logging.CRITICAL, logger="publoader.ipc.server"):
        result = IPCClient(sock).call("boom")
    assert result.get("ok") is False
    assert "intentional" in result.get("error", "")


def test_is_instance_running_false_when_no_socket():
    from publoader.ipc.client import is_instance_running
    missing = Path(tempfile.gettempdir()) / f"pl-missing-{uuid.uuid4().hex[:6]}.sock"
    assert is_instance_running(missing) is False


def test_is_instance_running_true_when_server_up(ipc):
    server, sock = ipc
    from publoader.ipc.client import is_instance_running
    assert is_instance_running(sock) is True
