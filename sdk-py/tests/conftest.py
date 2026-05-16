"""Pytest fixtures for AgentMailbox Python SDK tests.

The fixtures spawn the Node.js AgentMailbox server as a subprocess so the
SDK can hit a real HTTP endpoint. Each fixture isolates the database
to a tmpfile and kills the process group on teardown.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterator, Optional

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_BOOT_TIMEOUT = 15.0


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_for_health(url: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last_err: Optional[Exception] = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=1.0) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError) as exc:
            last_err = exc
        time.sleep(0.1)
    raise RuntimeError(
        f"AgentMailbox server at {url} did not become healthy "
        f"within {timeout}s (last error: {last_err})"
    )


class _Server:
    def __init__(self, url: str, proc: subprocess.Popen[bytes], db: Path) -> None:
        self.url = url
        self.proc = proc
        self.db = db


def _spawn_server(env_extra: Optional[dict[str, str]] = None) -> _Server:
    port = _free_port()
    db_handle, db_path = tempfile.mkstemp(prefix="agentmailbox-pytest-", suffix=".db")
    os.close(db_handle)

    env = os.environ.copy()
    env["PORT"] = str(port)
    env["AGENTSMCP_DB"] = db_path
    if env_extra:
        env.update(env_extra)

    proc = subprocess.Popen(
        ["npx", "--yes", "ts-node", "src/server.ts"],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        preexec_fn=os.setsid,
    )

    url = f"http://127.0.0.1:{port}"
    try:
        _wait_for_health(url, SERVER_BOOT_TIMEOUT)
    except Exception:
        _terminate(proc)
        try:
            os.unlink(db_path)
        except OSError:
            pass
        raise

    return _Server(url=url, proc=proc, db=Path(db_path))


def _terminate(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=5.0)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5.0)


@pytest.fixture(scope="session")
def agentmailbox_server() -> Iterator[str]:
    """Boot a Node AgentMailbox server with no auth. Session-scoped."""
    server = _spawn_server()
    try:
        yield server.url
    finally:
        _terminate(server.proc)
        try:
            os.unlink(server.db)
        except OSError:
            pass


@pytest.fixture(scope="session")
def agentmailbox_server_with_auth() -> Iterator[tuple[str, str]]:
    """Boot a second AgentMailbox server with AGENTSMCP_API_KEY set.

    Yields (url, api_key).
    """
    api_key = "pytest-secret-XYZ"
    server = _spawn_server({"AGENTSMCP_API_KEY": api_key})
    try:
        yield server.url, api_key
    finally:
        _terminate(server.proc)
        try:
            os.unlink(server.db)
        except OSError:
            pass
