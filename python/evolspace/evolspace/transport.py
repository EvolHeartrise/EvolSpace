"""Small keep-alive HTTP transport over http.client (stdlib only).

A small pool of persistent connections per transport: each request borrows an
idle connection (or opens one), so concurrent threads never wait on each other —
in particular a long-poll (``GET /api/events?wait=...``) on one thread does not
block publishes from another. Node closes idle keep-alive sockets after ~5 s; a
request that fails on a *reused* socket before any response arrives is retried
once on a fresh connection — the classic stale keep-alive race, where the server
never saw the request.
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
from typing import Any
from urllib.parse import quote, urlencode, urlsplit


class EvolError(RuntimeError):
    """An EvolSpace API error (HTTP status >= 400) or transport failure (status 0)."""

    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"[{status}] {message}" if status else message)
        self.status = status
        self.message = message
        self.body = body


class NotFound(EvolError):
    pass


class Response:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status: int, headers: dict[str, str], body: bytes):
        self.status = status
        self.headers = headers
        self.body = body

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "").split(";")[0].strip().lower()

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None


class HttpTransport:
    def __init__(self, base_url: str, timeout: float = 30.0):
        u = urlsplit(base_url)
        if u.scheme not in ("http", "https"):
            raise ValueError(f"EvolSpace URL must be http(s)://host:port, got {base_url!r}")
        self.scheme = u.scheme
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or (443 if u.scheme == "https" else 80)
        self.base_path = u.path.rstrip("/")
        self.timeout = timeout
        #: idle keep-alive connections (most recently used last)
        self._idle: list[http.client.HTTPConnection] = []
        self._lock = threading.Lock()

    def _new_conn(self, timeout: float) -> http.client.HTTPConnection:
        if self.scheme == "https":
            import ssl
            ctx = ssl.create_default_context()
            # The EvolSpace TLS port uses a self-signed cert; this SDK talks to the local machine.
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            return http.client.HTTPSConnection(self.host, self.port, timeout=timeout, context=ctx)
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    #: idle connections kept for reuse; extra ones are closed on release
    MAX_IDLE = 4

    def close(self) -> None:
        """Close idle connections. In-flight requests finish and close their own socket."""
        with self._lock:
            idle, self._idle = self._idle, []
        for c in idle:
            c.close()

    def _acquire(self, timeout: float) -> tuple[http.client.HTTPConnection, bool]:
        """-> (connection, reused). Reused connections may have been dropped by the server."""
        with self._lock:
            if self._idle:
                return self._idle.pop(), True
        return self._new_conn(timeout), False

    def _release(self, conn: http.client.HTTPConnection) -> None:
        with self._lock:
            if len(self._idle) < self.MAX_IDLE:
                self._idle.append(conn)
                return
        conn.close()

    def request(self, method: str, path: str, *, query: dict[str, Any] | None = None,
                body: bytes | None = None, headers: dict[str, str] | None = None,
                timeout: float | None = None) -> Response:
        url = self.base_path + path
        if query:
            q = {k: v for k, v in query.items() if v is not None}
            if q:
                url += "?" + urlencode(q)
        hdrs = {"Accept": "*/*", **(headers or {})}
        if body is not None:
            hdrs.setdefault("Content-Length", str(len(body)))
        t = timeout if timeout is not None else self.timeout
        for attempt in (0, 1):
            conn, reused = self._acquire(t) if attempt == 0 else (self._new_conn(t), False)
            try:
                conn.timeout = t
                if conn.sock is not None:
                    conn.sock.settimeout(t)
                conn.request(method, url, body=body, headers=hdrs)
                r = conn.getresponse()
                data = r.read()
                resp = Response(r.status, {k.lower(): v for k, v in r.getheaders()}, data)
            except (socket.timeout, TimeoutError) as e:
                # never retried: the server may still be working on it
                conn.close()
                raise EvolError(0, f"{method} {url}: no response from {self.host}:{self.port} within {t}s") from e
            except (OSError, http.client.HTTPException) as e:
                conn.close()
                if attempt == 0 and reused:
                    continue  # stale keep-alive socket: the request never reached the server
                raise EvolError(0, f"{method} {url}: {self.host}:{self.port} unreachable ({e}); is the EvolSpace server running?") from e
            if r.getheader("connection", "").lower() == "close" or r.will_close:
                conn.close()
            else:
                self._release(conn)
            break
        if resp.status >= 400:
            msg = resp.body.decode("utf-8", "replace")
            parsed: Any = None
            try:
                parsed = json.loads(msg)
                if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
                    msg = parsed["error"]
            except json.JSONDecodeError:
                pass
            cls = NotFound if resp.status == 404 else EvolError
            raise cls(resp.status, f"{method} {path}: {msg}", parsed)
        return resp

    def json(self, method: str, path: str, payload: Any = None, **kw: Any) -> Any:
        body = None
        headers = kw.pop("headers", {}) or {}
        if payload is not None:
            body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
            headers = {"Content-Type": "application/json", **headers}
        return self.request(method, path, body=body, headers=headers, **kw).json()


def channel_path(name: str) -> str:
    return "/api/channels/" + quote(name, safe="")
