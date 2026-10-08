"""A minimal in-process fake of the EvolSpace server for SDK unit tests.

HTTP (stdlib ThreadingHTTPServer) and WS (websockets sync server) run on two
ports; tests pass ``ws_url`` to the Client. Implements the subset of api.ts /
messages.ts the SDK uses: channels (JSON + tensor frames + raw X-Dtype bodies),
WS hello/subscribe/publish with no-echo-to-origin, scene ops, agent say/status,
events, commands and a fake screenshot.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import numpy as np

from evolspace.codec import DTYPES, TENSOR_MIME, decode_tensor_frame, encode_tensor_frame, tensor_to_json

PNG = b"\x89PNG\r\n\x1a\n" + b"fake"


def _match(p: str, n: str) -> bool:
    return p == "*" or (p.endswith(".*") and n.startswith(p[:-1])) or p == n


class FakeEvol:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.channels: dict[str, dict[str, Any]] = {}  # name -> {value | tensor, seq}
        self.entities: dict[str, dict[str, Any]] = {}
        self.links: dict[str, dict[str, Any]] = {}
        self.version = 0
        self.events: list[dict[str, Any]] = []
        self.said: list[dict[str, Any]] = []
        self.commands: list[dict[str, Any]] = []
        self.requests: list[tuple[str, str]] = []
        self.ws_clients: dict[str, dict[str, Any]] = {}
        self._ids = 0
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.http.daemon_threads = True
        from websockets.sync.server import serve
        self.ws = serve(self._ws_handler, "127.0.0.1", 0, max_size=None, compression=None)
        self.http_port = self.http.server_address[1]
        self.ws_port = self.ws.socket.getsockname()[1]
        self._threads = [threading.Thread(target=self.http.serve_forever, daemon=True),
                         threading.Thread(target=self.ws.serve_forever, daemon=True)]
        for t in self._threads:
            t.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.http_port}"

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self.ws_port}/ws"

    def close(self) -> None:
        self.http.shutdown()
        self.http.server_close()
        self.ws.shutdown()

    def new_id(self, prefix: str) -> str:
        self._ids += 1
        return f"{prefix}{self._ids}"

    def event(self, type_: str, data: dict[str, Any]) -> None:
        with self.lock:
            self.events.append({"seq": len(self.events) + 1, "ts": time.time() * 1000, "type": type_, "data": data})

    # ------------------------------------------------------------------ bus

    def publish(self, name: str, value: Any = None, tensor: tuple[str, np.ndarray] | None = None, origin: str | None = None) -> dict[str, Any]:
        with self.lock:
            prev = self.channels.get(name)
            seq = (prev["seq"] if prev else 0) + 1
            ch = {"name": name, "seq": seq, "value": value, "tensor": tensor}
            self.channels[name] = ch
            clients = list(self.ws_clients.items())
        for cid, c in clients:
            if cid == origin or not any(_match(p, name) for p in c["subs"]):
                continue
            self._send_channel(c, ch)
        info = {"name": name, "kind": "tensor" if tensor else "json", "seq": seq, "size": 0, "updatedAt": 0}
        if tensor:
            info.update(dtype=tensor[0], shape=list(tensor[1].shape))
        return info

    def _send_channel(self, c: dict[str, Any], ch: dict[str, Any]) -> None:
        try:
            if ch["tensor"]:
                dt, arr = ch["tensor"]
                c["ws"].send(encode_tensor_frame(ch["name"], arr, dtype=dt, seq=ch["seq"]))
            else:
                c["ws"].send(json.dumps({"type": "channel.value", "channel": ch["name"], "value": ch["value"], "seq": ch["seq"]}))
        except Exception:  # noqa: BLE001 - closed socket
            pass

    # ------------------------------------------------------------------ ws

    def _ws_handler(self, ws: Any) -> None:
        cid = self.new_id("c")
        c = {"ws": ws, "subs": set(), "role": None}
        with self.lock:
            self.ws_clients[cid] = c
        try:
            for raw in ws:
                if isinstance(raw, bytes):
                    header, arr = decode_tensor_frame(raw)
                    self.publish(header["channel"], tensor=(header["dtype"], arr), origin=cid)
                    continue
                m = json.loads(raw)
                t = m.get("type")
                if t == "hello":
                    c["role"] = m.get("role")
                    ws.send(json.dumps({"type": "hello", "clientId": cid, "serverVersion": "fake", "primary": False}))
                elif t == "channel.subscribe":
                    c["subs"].update(m["channels"])
                    with self.lock:
                        chans = list(self.channels.values())
                    for ch in chans:
                        if any(_match(p, ch["name"]) for p in m["channels"]):
                            self._send_channel(c, ch)
                elif t == "channel.unsubscribe":
                    c["subs"].difference_update(m["channels"])
                elif t == "channel.publish":
                    self.publish(m["channel"], m["value"], origin=cid)
                elif t == "command":
                    self.commands.append(m)
        finally:
            with self.lock:
                self.ws_clients.pop(cid, None)

    def drop_ws_clients(self) -> None:
        """Simulate a server restart for WS clients."""
        with self.lock:
            clients = list(self.ws_clients.values())
        for c in clients:
            c["ws"].close()

    # ------------------------------------------------------------------ http

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        fake = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a: Any) -> None:  # silence
                pass

            def _body(self) -> bytes:
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n) if n else b""

            def _send(self, status: int, body: bytes, ctype: str = "application/json; charset=utf-8", extra: dict[str, str] | None = None) -> None:
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def _json(self, obj: Any, status: int = 200) -> None:
                self._send(status, json.dumps(obj).encode())

            def _err(self, status: int, msg: str) -> None:
                self._json({"error": msg}, status)

            def _route(self, method: str) -> None:
                u = urlsplit(self.path)
                path, q = u.path, {k: v[-1] for k, v in parse_qs(u.query).items()}
                fake.requests.append((method, path))
                body = self._body() if method in ("PUT", "POST") else b""
                try:
                    self._dispatch(method, path, q, body)
                except Exception as e:  # noqa: BLE001
                    self._err(500, f"fake server error: {e}")

            def _dispatch(self, method: str, path: str, q: dict[str, str], body: bytes) -> None:
                if path == "/api/health":
                    return self._json({"ok": True, "version": "fake", "clients": []})
                if path.startswith("/api/channels/"):
                    name = unquote(path[len("/api/channels/"):])
                    if method == "PUT":
                        ctype = (self.headers.get("Content-Type") or "").split(";")[0]
                        if ctype == TENSOR_MIME:
                            header, arr = decode_tensor_frame(body)
                            return self._json(fake.publish(name, tensor=(header["dtype"], arr)))
                        if self.headers.get("X-Dtype"):
                            dt = self.headers["X-Dtype"]
                            shape = [int(x) for x in self.headers["X-Shape"].split(",") if x]
                            arr = np.frombuffer(body, dtype=DTYPES[dt]).reshape(shape)
                            return self._json(fake.publish(name, tensor=(dt, arr)))
                        return self._json(fake.publish(name, json.loads(body)))
                    if method == "DELETE":
                        with fake.lock:
                            if fake.channels.pop(name, None) is None:
                                return self._err(404, f"no channel '{name}'")
                        return self._json({"ok": True})
                    ch = fake.channels.get(name)
                    if ch is None:
                        return self._err(404, f"no value on channel '{name}' yet")
                    if ch["tensor"]:
                        dt, arr = ch["tensor"]
                        if q.get("format") == "json":
                            return self._json(tensor_to_json(arr, dt))
                        return self._send(200, encode_tensor_frame(name, arr, dtype=dt, seq=ch["seq"]), TENSOR_MIME)
                    return self._json(ch["value"])
                if path == "/api/channels":
                    return self._json([{"name": n, "seq": c["seq"]} for n, c in sorted(fake.channels.items())])
                if path == "/api/scene/ops":
                    b = json.loads(body)
                    ids = []
                    with fake.lock:
                        for op in b["ops"]:
                            k = op["op"]
                            if k == "add":
                                e = dict(op["entity"])
                                e.setdefault("id", fake.new_id("e"))
                                e.setdefault("props", {})
                                fake.entities[e["id"]] = e
                                ids.append(e["id"])
                            elif k == "update":
                                if op["id"] not in fake.entities:
                                    return self._err(400, f"entity '{op['id']}' does not exist")
                                e = fake.entities[op["id"]]
                                patch = dict(op["patch"])
                                e["props"] = {**e.get("props", {}), **patch.pop("props", {})}
                                e.update(patch)
                            elif k == "remove":
                                fake.entities.pop(op["id"], None)
                            elif k == "link.add":
                                lk = dict(op["link"])
                                lk.setdefault("id", fake.new_id("l"))
                                fake.links[lk["id"]] = lk
                                ids.append(lk["id"])
                            elif k == "link.remove":
                                fake.links.pop(op["id"], None)
                            elif k == "clear":
                                fake.entities.clear()
                                fake.links.clear()
                        fake.version += 1
                    return self._json({"version": fake.version, "ids": ids})
                if path == "/api/scene":
                    return self._json({"version": fake.version, "entities": fake.entities, "links": fake.links, "workspace": "test"})
                if path == "/api/scene/summary":
                    return self._json({"version": fake.version, "workspace": "test", "roots": [{"id": i, "widget": e["widget"]} for i, e in fake.entities.items()], "links": []})
                if path == "/api/agent/say":
                    b = json.loads(body)
                    fake.said.append(b)
                    return self._json({"id": f"m{len(fake.said)}"})
                if path == "/api/agent/status":
                    if method == "POST":
                        fake.status = json.loads(body)
                        return self._json({})
                    return self._json({"status": getattr(fake, "status", {"state": "idle"}), "messages": fake.said})
                if path == "/api/command":
                    b = json.loads(body)
                    fake.commands.append(b)
                    return self._json({"ok": True, "result": {"ran": b["name"]}})
                if path == "/api/screenshot":
                    b = json.loads(body)
                    fake.last_screenshot = b
                    return self._send(200, PNG, "image/png")
                if path == "/api/events":
                    since = int(q["since"]) if "since" in q else None
                    types = [t for t in q.get("types", "").split(",") if t]
                    with fake.lock:
                        evs = [e for e in fake.events if (not types or e["type"] in types)]
                        nxt = len(fake.events)
                    if since is None:
                        return self._json({"events": evs[-int(q.get("limit", 200)):], "next": nxt})
                    return self._json({"events": [e for e in evs if e["seq"] > since], "next": max(since, nxt)})
                return self._err(404, f"no route {method} {path}")

            def do_GET(self) -> None:
                self._route("GET")

            def do_PUT(self) -> None:
                self._route("PUT")

            def do_POST(self) -> None:
                self._route("POST")

            def do_DELETE(self) -> None:
                self._route("DELETE")

        return H
