"""EvolSpace Python client: the HTTP API (packages/protocol/src/api.ts) plus WS subscriptions.

    from evolspace import Client
    evol = Client()                                   # $EVOL_URL or http://127.0.0.1:8787
    evol.publish("demo.wave", np.sin(np.linspace(0, 6.28, 64)).astype(np.float32))
    evol.publish("demo.label", {"text": "hello"})
    box = evol.scene.spawn("box", name="demo box", position=[0, 1.4, -1])
    evol.say("Spawned a box")
    with evol.subscribe(["demo.*"], lambda ch, v, seq: print(ch, v)) as sub: ...
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping

from .codec import TENSOR_MIME, decode_json_value, decode_tensor_frame, encode_tensor_frame, is_tensor_like, jsonable
from .transport import EvolError, HttpTransport, NotFound, channel_path
from .ws import ChannelCallback, MessageCallback, Subscription

DEFAULT_URL = "http://127.0.0.1:8787"
_MISSING: Any = object()


def default_url() -> str:
    """$EVOL_URL (set by the server for supervised sources) or the local HTTP port."""
    return os.environ.get("EVOL_URL") or DEFAULT_URL


class Client:
    """Synchronous client. Thread-safe: HTTP calls share one keep-alive connection under a lock."""

    def __init__(self, url: str | None = None, *, producer: str | None = None, timeout: float = 30.0,
                 ws_url: str | None = None):
        self.url = (url or default_url()).rstrip("/")
        self.producer = producer
        self._ws_url = ws_url
        self.http = HttpTransport(self.url, timeout=timeout)
        self.scene = Scene(self)

    # ------------------------------------------------------------------ basics

    @property
    def ws_url(self) -> str:
        """``ws(s)://host:port/ws`` derived from the HTTP URL (or the explicit ``ws_url``)."""
        if self._ws_url:
            return self._ws_url
        return ("wss://" if self.url.startswith("https://") else "ws://") + self.url.split("://", 1)[1] + "/ws"

    def health(self) -> dict[str, Any]:
        return self.http.json("GET", "/api/health")

    def is_up(self, timeout: float = 2.0) -> bool:
        try:
            self.http.request("GET", "/api/health", timeout=timeout)
            return True
        except EvolError:
            return False

    def wait_until_up(self, timeout: float | None = None, interval: float = 1.0) -> bool:
        """Poll /api/health until the server answers (None = forever)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            if self.is_up():
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(interval)

    def close(self) -> None:
        self.http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ------------------------------------------------------------------ channels

    def publish(self, channel: str, value: Any, *, dtype: str | None = None, description: str | None = None) -> dict[str, Any]:
        """Publish a channel value. numpy arrays / torch tensors go as binary tensor frames
        (float64 is sent as f32 unless ``dtype`` says otherwise); anything else as JSON.
        Returns the server's ChannelInfo."""
        headers: dict[str, str] = {}
        # producer/description go in the query (URL-encoded): HTTP headers are latin-1 only, and a
        # description like "attn — head 3" would fail to encode. The server accepts both forms.
        query = {"producer": self.producer, "description": description or None}
        if is_tensor_like(value) or dtype is not None:
            body = encode_tensor_frame(channel, value, dtype=dtype, producer=self.producer)
            headers["Content-Type"] = TENSOR_MIME
            return self.http.request("PUT", channel_path(channel), query=query, body=body, headers=headers).json()
        return self.http.json("PUT", channel_path(channel), _jsonable(value), headers=headers, query=query)

    def publish_many(self, values: Mapping[str, Any]) -> None:
        for name, value in values.items():
            self.publish(name, value)

    def get(self, channel: str, default: Any = _MISSING) -> Any:
        """Latest value of a channel (ndarray for tensors). Raises NotFound unless ``default`` is given."""
        try:
            r = self.http.request("GET", channel_path(channel), headers={"Accept": f"{TENSOR_MIME}, application/json"})
        except NotFound:
            if default is _MISSING:
                raise
            return default
        if r.content_type == TENSOR_MIME:
            return decode_tensor_frame(r.body)[1]
        return decode_json_value(r.json())

    def channels(self) -> list[dict[str, Any]]:
        return self.http.json("GET", "/api/channels")

    def delete_channel(self, channel: str) -> bool:
        try:
            self.http.request("DELETE", channel_path(channel))
            return True
        except NotFound:
            return False

    def subscribe(self, channels: str | Iterable[str], callback: ChannelCallback | None = None, *,
                  on_connect: Callable[[Subscription], None] | None = None,
                  on_message: MessageCallback | None = None, reconnect: bool = True) -> Subscription:
        """Open a WS subscription (exact names or ``prefix.*``); ``callback(channel, value, seq)``
        runs on the subscription's thread. Current values are delivered right after subscribing."""
        chans = [channels] if isinstance(channels, str) else list(channels)
        return Subscription(self.ws_url, chans, callback, on_connect=on_connect, on_message=on_message,
                            producer=self.producer, reconnect=reconnect)

    # ------------------------------------------------------------------ agent I/O & system

    def say(self, text: str, kind: str = "reply") -> str:
        """Show a message in XR (agent panel). kind: reply | info | error | heard."""
        return self.http.json("POST", "/api/agent/say", {"text": text, "kind": kind})["id"]

    def status(self) -> dict[str, Any]:
        """Agent status + recent messages: {status: {state, detail?, since}, messages}."""
        return self.http.json("GET", "/api/agent/status")

    def set_status(self, state: str, detail: str | None = None) -> None:
        """state: idle | listening | transcribing | thinking | working | error."""
        payload: dict[str, Any] = {"state": state}
        if detail:
            payload["detail"] = detail
        self.http.json("POST", "/api/agent/status", payload)

    def command(self, name: str, args: Mapping[str, Any] | None = None) -> Any:
        """Run a server command (undo, redo, delete, screenshot, broadcast, ...). Returns its result."""
        payload: dict[str, Any] = {"name": name}
        if args:
            payload["args"] = dict(args)
        return self.http.json("POST", "/api/command", payload).get("result")

    def user(self, raw: bool = False) -> dict[str, Any] | None:
        """Latest primary-headset UserPose (hands summarized unless raw)."""
        return self.http.json("GET", "/api/user", query={"raw": "1" if raw else None})

    def screenshot(self, view: str | Mapping[str, Any] = "user", path: str | os.PathLike[str] | None = None, *,
                   width: int | None = None, height: int | None = None, hands: bool | None = None,
                   labels: bool | None = None, background: str | None = None, timeout: float = 120.0) -> bytes:
        """Render a PNG via the server's mirror. ``view``: 'user', an entity id, or a ScreenshotView
        dict ({kind:'camera'|'entity'|'widget', ...}). Writes ``path`` when given; returns the PNG bytes."""
        if isinstance(view, str):
            v: dict[str, Any] = {"kind": "user"} if view == "user" else {"kind": "entity", "entity": view}
        else:
            v = dict(view)
        req: dict[str, Any] = {"view": v}
        for k, val in (("width", width), ("height", height), ("hands", hands), ("labels", labels), ("background", background)):
            if val is not None:
                req[k] = val
        body = _json_bytes(req)
        r = self.http.request("POST", "/api/screenshot", body=body, headers={"Content-Type": "application/json"}, timeout=timeout)
        if path is not None:
            p = Path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(r.body)
        return r.body

    def events(self, since: int | None = None, *, wait: float = 0.0, types: Iterable[str] | None = None,
               limit: int | None = None) -> dict[str, Any]:
        """One long-poll page: {events: ServerEvent[], next}. ``wait`` in seconds (max 120)."""
        q = {"since": since, "wait": int(wait * 1000) if wait else None,
             "types": ",".join(types) if types else None, "limit": limit}
        return self.http.json("GET", "/api/events", query=q, timeout=self.http.timeout + wait)

    def iter_events(self, types: Iterable[str] | None = None, *, since: int | None = None,
                    wait: float = 25.0) -> Iterator[dict[str, Any]]:
        """Yield ServerEvents forever (long-polling). Starts at the newest when ``since`` is None."""
        tlist = list(types) if types else None
        if since is None:
            since = self.events(types=tlist, limit=1).get("next", 0)
        while True:
            page = self.events(since, wait=wait, types=tlist)
            for e in page.get("events", []):
                yield e
            since = page.get("next", since)

    # sources
    def sources(self) -> list[dict[str, Any]]:
        return self.http.json("GET", "/api/sources")

    def source(self, id: str, action: str | None = None) -> dict[str, Any]:
        """GET a source's status, or run action 'start' | 'stop' | 'restart'."""
        if action is None:
            return self.http.json("GET", f"/api/sources/{id}")
        if action not in ("start", "stop", "restart"):
            raise ValueError("action must be start, stop or restart")
        return self.http.json("POST", f"/api/sources/{id}/{action}")

    # widgets / gestures (read-mostly helpers)
    def widgets(self) -> list[dict[str, Any]]:
        return self.http.json("GET", "/api/widgets")

    def build_widget(self, id: str) -> dict[str, Any]:
        return self.http.json("POST", f"/api/widgets/{id}/build")


class Scene:
    """Scene helpers (``client.scene``). Ops follow packages/protocol/src/scene.ts."""

    def __init__(self, client: Client):
        self._c = client

    def get(self) -> dict[str, Any]:
        return self._c.http.json("GET", "/api/scene")

    def summary(self) -> dict[str, Any]:
        return self._c.http.json("GET", "/api/scene/summary")

    def ops(self, ops: list[dict[str, Any]], *, source: str = "agent", group: str | None = None) -> dict[str, Any]:
        """Apply a batch of SceneOps atomically -> {version, ids, warnings?}."""
        payload: dict[str, Any] = {"ops": ops, "source": source}
        if group:
            payload["group"] = group
        return self._c.http.json("POST", "/api/scene/ops", _jsonable(payload))

    def spawn(self, widget: str, *, id: str | None = None, name: str | None = None,
              props: Mapping[str, Any] | None = None, position: Iterable[float] | None = None,
              rotation: Iterable[float] | None = None, scale: float | Iterable[float] | None = None,
              parent: str | None = None, anchor: Mapping[str, Any] | None = None,
              tags: Iterable[str] | None = None, locked: bool | None = None, visible: bool | None = None,
              interactions: list[dict[str, Any]] | None = None) -> str:
        """Add an entity; returns its id. ``rotation`` is a quaternion [x, y, z, w]; ``scale`` a number or Vec3."""
        ent: dict[str, Any] = {"widget": widget, "parent": parent}
        for k, v in (("id", id), ("name", name), ("anchor", anchor), ("locked", locked), ("visible", visible),
                     ("interactions", interactions)):
            if v is not None:
                ent[k] = v
        if props:
            ent["props"] = dict(props)
        if tags is not None:
            ent["tags"] = list(tags)
        tr = _transform(position, rotation, scale)
        if tr:
            ent["transform"] = tr
        return self.ops([{"op": "add", "entity": ent}])["ids"][0]

    def update(self, id: str, *, props: Mapping[str, Any] | None = None, position: Iterable[float] | None = None,
               rotation: Iterable[float] | None = None, scale: float | Iterable[float] | None = None,
               **patch: Any) -> dict[str, Any]:
        """Patch an entity: ``props`` shallow-merge; transform parts replace; other kwargs
        (name, visible, parent, anchor, tags, locked, interactions) go straight into the patch."""
        p: dict[str, Any] = dict(patch)
        if props:
            p["props"] = dict(props)
        tr = _transform(position, rotation, scale)
        if tr:
            p["transform"] = tr
        return self.ops([{"op": "update", "id": id, "patch": p}])

    def remove(self, *ids: str) -> dict[str, Any]:
        return self.ops([{"op": "remove", "id": i} for i in ids])

    def clear(self) -> dict[str, Any]:
        return self.ops([{"op": "clear"}])

    def link(self, src: str | Mapping[str, Any], dst: str | Mapping[str, Any], *, transform: str | None = None,
             id: str | None = None, enabled: bool = True) -> str:
        """Add a link; returns its id. Endpoints: PortRef dicts, ``"channel:<name>"``, or ``"<entity>:<port>"``."""
        link: dict[str, Any] = {"from": port_ref(src), "to": port_ref(dst), "enabled": enabled}
        if transform:
            link["transform"] = transform
        if id:
            link["id"] = id
        return self.ops([{"op": "link.add", "link": link}])["ids"][0]

    def unlink(self, id: str) -> dict[str, Any]:
        return self.ops([{"op": "link.remove", "id": id}])

    def undo(self) -> dict[str, Any]:
        return self._c.http.json("POST", "/api/scene/undo")

    def redo(self) -> dict[str, Any]:
        return self._c.http.json("POST", "/api/scene/redo")

    def instantiate(self, prefab: str, *, position: Iterable[float] | None = None, rotation: Iterable[float] | None = None,
                    scale: float | Iterable[float] | None = None, parent: str | None = None,
                    props: Mapping[str, Mapping[str, Any]] | None = None) -> dict[str, str]:
        """Instantiate library/prefabs/<prefab>.json -> {prefabLocalId: newId}."""
        payload: dict[str, Any] = {}
        tr = _transform(position, rotation, scale)
        if tr:
            payload["transform"] = tr
        if parent:
            payload["parent"] = parent
        if props:
            payload["props"] = {k: dict(v) for k, v in props.items()}
        return self._c.http.json("POST", f"/api/prefabs/{prefab}/instantiate", _jsonable(payload))["ids"]

    def find(self, *, name: str | None = None, widget: str | None = None, tag: str | None = None) -> list[dict[str, Any]]:
        """Entities matching all given filters (exact name / widget id / tag)."""
        out = []
        for e in self.get().get("entities", {}).values():
            if name is not None and e.get("name") != name:
                continue
            if widget is not None and e.get("widget") != widget:
                continue
            if tag is not None and tag not in (e.get("tags") or []):
                continue
            out.append(e)
        return out


def port_ref(p: str | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(p, Mapping):
        return dict(p)
    if p.startswith("channel:"):
        return {"kind": "channel", "channel": p[len("channel:"):]}
    if ":" not in p:
        raise ValueError(f"port reference {p!r}: use 'channel:<name>' or '<entity>:<port>'")
    ent, port = p.rsplit(":", 1)
    return {"kind": "port", "entity": ent, "port": port}


def _transform(position: Iterable[float] | None, rotation: Iterable[float] | None,
               scale: float | Iterable[float] | None) -> dict[str, Any]:
    tr: dict[str, Any] = {}
    if position is not None:
        tr["position"] = [float(x) for x in position]
    if rotation is not None:
        tr["rotation"] = [float(x) for x in rotation]
    if scale is not None:
        tr["scale"] = [float(scale)] * 3 if isinstance(scale, (int, float)) else [float(x) for x in scale]
    return tr


def _jsonable(v: Any) -> Any:
    """Make numpy scalars/arrays JSON-serializable (also accepts any Mapping)."""
    if isinstance(v, Mapping) and not isinstance(v, dict):
        v = dict(v)
    return jsonable(v)


def _json_bytes(v: Any) -> bytes:
    import json
    return json.dumps(_jsonable(v), separators=(",", ":"), allow_nan=False).encode("utf-8")


__all__ = ["Client", "Scene", "EvolError", "NotFound", "Subscription", "default_url", "port_ref"]
