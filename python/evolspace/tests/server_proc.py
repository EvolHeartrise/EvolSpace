"""Start/stop the real EvolSpace Node server for integration tests (random port, temp data dir)."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from evolspace import Client

REPO = Path(__file__).resolve().parents[3]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


@dataclass
class ServerProc:
    url: str
    proc: subprocess.Popen
    data_dir: str
    log: Path

    def log_tail(self, n: int = 3000) -> str:
        try:
            return self.log.read_text("utf-8", "replace")[-n:]
        except OSError:
            return ""

    def stop(self) -> None:
        kill_tree(self.proc)
        time.sleep(0.2)
        shutil.rmtree(self.data_dir, ignore_errors=True)


def start_server(timeout: float = 90.0, env: dict[str, str] | None = None) -> ServerProc | str:
    """Returns a running ServerProc, or a reason string when it cannot be started."""
    node = shutil.which("node")
    tsx = REPO / "node_modules" / "tsx" / "dist" / "cli.mjs"
    main = REPO / "apps" / "server" / "src" / "main.ts"
    if not node or not tsx.exists() or not main.exists():
        return "node / tsx / apps/server not available"
    port = free_port()
    data = tempfile.mkdtemp(prefix="evol-test-")
    env = {**os.environ, "EVOL_HTTP_PORT": str(port), "EVOL_HTTPS_PORT": "off", "EVOL_CLIENT": "none",
           "EVOL_NO_AUTOSTART": "1", "EVOL_DATA_DIR": data, **(env or {})}
    log = Path(data) / "server.log"
    with open(log, "wb") as lf:
        proc = subprocess.Popen([node, str(tsx), str(main)], cwd=str(REPO), env=env, stdout=lf, stderr=subprocess.STDOUT)
    sp = ServerProc(f"http://127.0.0.1:{port}", proc, data, log)
    c = Client(sp.url)
    try:
        if not c.wait_until_up(timeout=timeout, interval=0.3):
            tail = sp.log_tail()
            sp.stop()
            return f"real server did not start:\n{tail}"
    finally:
        c.close()
    return sp
