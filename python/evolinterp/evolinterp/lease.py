"""One live interp process per channel prefix: a lease kept on ``P.status``.

``interp-bsrl`` and ``interp-toy`` both publish under ``interp.*``; two processes on
one prefix would overwrite each other's tensors and fight over ``P.ctl.sample``
while playing. Every ``P.status`` a live process publishes therefore carries

    owner: {id, pid, host, source, model, prefix, since}     ts: <last publish, unix s>

and the process re-publishes its status every ``HEARTBEAT_S`` seconds (heartbeat).
A starting process reads ``P.status`` first and **refuses** (stderr message, exit
code 3, and — when it knows its source id — asks the supervisor to stop it so it is
not restarted in a loop) if another owner is *active*:

* a different ``owner.id``,
* ``state`` is not ``"stopped"`` (published on a clean exit),
* the heartbeat is fresh (``now - ts <= STALE_S``), and
* on the same host, the owner pid is still alive (a killed process — supervisor
  restart/stop uses ``taskkill /F`` — leaves a fresh-looking status behind; the pid
  check lets its successor take over immediately).

Races (both start within milliseconds) are settled by the heartbeat: if a process
finds another active owner on ``P.status`` that claimed the prefix earlier (``since``,
ties by id) it yields; the earlier owner republishes everything.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import uuid
from typing import Any, Callable

from evolspace import Client, EvolError

HEARTBEAT_S = 5.0
STALE_S = 20.0
EXIT_CONFLICT = 3


def pid_alive(pid: int) -> bool:
    """Best-effort liveness of a local pid (unknown -> True)."""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: exists, not ours
        try:
            code = wintypes.DWORD()
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def describe_owner(o: dict[str, Any]) -> str:
    who = f"source {o['source']}" if o.get("source") else "a live interp process"
    since = time.strftime("%H:%M:%S", time.localtime(o["since"])) if isinstance(o.get("since"), (int, float)) else "?"
    return f"{who} ({o.get('model') or '?'}, pid {o.get('pid')}, since {since})"


class PrefixLease:
    def __init__(self, client: Client, prefix: str, *, source: str | None = None, model: str = "",
                 heartbeat: float = HEARTBEAT_S, stale: float = STALE_S,
                 log: Callable[[str], None] | None = None):
        self.c = client
        self.prefix = prefix
        self.channel = f"{prefix}.status"
        self.heartbeat_s = heartbeat
        self.stale_s = stale
        self.log = log
        self.host = socket.gethostname()
        self.owner: dict[str, Any] = {"id": uuid.uuid4().hex[:12], "pid": os.getpid(), "host": self.host,
                                      "source": source, "model": model, "prefix": prefix, "since": time.time()}
        self._lock = threading.Lock()
        self._last: dict[str, Any] = {"state": "loading", "message": ""}
        self._last_pub = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.lost: dict[str, Any] | None = None   # set when we yielded to another owner
        self.released = False

    # ------------------------------------------------------------------ ownership

    def set_model(self, model: str) -> None:
        with self._lock:
            self.owner["model"] = model

    def active_owner(self, status: Any, now: float | None = None) -> dict[str, Any] | None:
        """The owner recorded in a P.status value if it is someone else and still active."""
        if not isinstance(status, dict):
            return None
        o = status.get("owner")
        if not isinstance(o, dict) or not o.get("id") or o.get("id") == self.owner["id"]:
            return None
        if status.get("state") == "stopped":
            return None
        ts = status.get("ts")
        now = time.time() if now is None else now
        if not isinstance(ts, (int, float)) or now - float(ts) > self.stale_s:
            return None
        if o.get("host") == self.host and isinstance(o.get("pid"), int) and not pid_alive(int(o["pid"])):
            return None
        return o

    def beats_us(self, other: dict[str, Any]) -> bool:
        """Earlier claim wins (ties: smaller id)."""
        mine = (float(self.owner["since"]), str(self.owner["id"]))
        theirs = (float(other.get("since") or 0.0), str(other.get("id")))
        return theirs < mine

    def read_status(self) -> Any:
        try:
            return self.c.get(self.channel, default=None)
        except EvolError:
            return None

    def conflict(self) -> dict[str, Any] | None:
        """Another active owner on the prefix (checked before claiming)."""
        return self.active_owner(self.read_status())

    def refusal_message(self, other: dict[str, Any]) -> str:
        me = f"source {self.owner['source']}" if self.owner.get("source") else "this process"
        hint = (f"stop it first (POST /api/sources/{other['source']}/stop)" if other.get("source")
                else f"stop it first (pid {other.get('pid')})")
        return (f"refusing to start {me}: channel prefix '{self.prefix}.*' is already served by "
                f"{describe_owner(other)}; {hint} or use another --prefix")

    # ------------------------------------------------------------------ status

    def stamp(self, status: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            return {**status, "owner": dict(self.owner), "ts": time.time()}

    def publish(self, status: dict[str, Any]) -> None:
        """Publish P.status (stamped with owner + ts); remembered for the heartbeat."""
        if self.released or self.lost is not None:
            return
        with self._lock:
            self._last = {k: v for k, v in status.items() if k not in ("owner", "ts")}
        self._send(self.stamp(self._last))

    def _send(self, st: dict[str, Any]) -> None:
        try:
            self.c.publish(self.channel, st)
            self._last_pub = time.monotonic()
        except EvolError as e:
            if self.log:
                self.log(f"[lease] status publish failed: {e.message}")

    def beat(self, on_contest: Callable[[], None] | None = None, on_lost: Callable[[dict[str, Any]], None] | None = None) -> None:
        """One heartbeat: yield to an earlier active owner, else re-publish our status."""
        if self.released or self.lost is not None:
            return
        other = self.conflict()
        if other is not None:
            # an earlier claim wins — unless our own heartbeat went stale (we hung) and the
            # other process legitimately took the prefix over in the meantime
            hung = self._last_pub > 0 and time.monotonic() - self._last_pub > self.stale_s
            if hung or self.beats_us(other):
                self.lost = other
                if on_lost:
                    on_lost(other)
                return
            if self.log:
                self.log(f"[lease] {describe_owner(other)} also claimed '{self.prefix}.*'; keeping it (earlier claim)")
            if on_contest:
                on_contest()
        with self._lock:
            last = dict(self._last)
        self._send(self.stamp(last))

    def start_heartbeat(self, on_contest: Callable[[], None] | None = None,
                        on_lost: Callable[[dict[str, Any]], None] | None = None) -> None:
        def loop() -> None:
            while not self._stop.wait(self.heartbeat_s):
                try:
                    self.beat(on_contest, on_lost)
                except Exception as e:  # noqa: BLE001 - the heartbeat must never die
                    if self.log:
                        self.log(f"[lease] heartbeat error: {type(e).__name__}: {e}")
                if self.lost is not None:
                    return

        self._thread = threading.Thread(target=loop, name="interp-lease", daemon=True)
        self._thread.start()

    def release(self, publish: bool = True) -> None:
        """Clean exit: stop the heartbeat and mark the prefix free (state "stopped") unless
        someone else owns it now. ``publish=False`` only stops the heartbeat (keeps e.g. an
        error status visible; the dead pid frees the prefix)."""
        self._stop.set()
        if self.released:
            return
        self.released = True
        if self.lost is not None or not publish:
            return
        cur = self.read_status()
        if isinstance(cur, dict) and isinstance(cur.get("owner"), dict) and cur["owner"].get("id") not in (None, self.owner["id"]):
            return  # another process took over: leave its status alone
        self._send(self.stamp({"state": "stopped", "message": "interp process exited"}))


def request_self_stop(client: Client, source: str | None, log: Callable[[str], None] | None = None) -> None:
    """Ask the supervisor to stop our own source (so `restart: true` does not loop on a refusal).
    The server kills this process while handling the request; returning means it did not."""
    if not source:
        return
    try:
        client.source(source, "stop")
    except Exception as e:  # noqa: BLE001 - not supervised / server gone: just exit
        if log:
            log(f"[lease] could not stop source {source}: {e}")
