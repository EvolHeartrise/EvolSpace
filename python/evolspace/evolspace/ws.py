"""WebSocket subscription (role 'tool') with automatic reconnect.

Runs one background thread per Subscription. Channel values arrive as JSON
text messages ({type:'channel.value', channel, value, seq}) or binary tensor
frames; both are delivered to the callback as ``callback(channel, value, seq)``
with tensors decoded to numpy arrays. The server sends current values right
after ``channel.subscribe`` and skips echoing a client's own publishes back to it.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable, Iterable

from .codec import (CodecError, decode_json_value, decode_tensor_frame, encode_tensor_frame, is_audio_frame,
                    is_tensor_like, jsonable)

log = logging.getLogger("evolspace.ws")

ChannelCallback = Callable[[str, Any, int], None]
MessageCallback = Callable[[dict[str, Any]], None]

_MISSING = object()


def _match(pattern: str, name: str) -> bool:
    if pattern == "*":
        return True
    if pattern.endswith(".*"):
        return name.startswith(pattern[:-1])
    return pattern == name


class Subscription:
    """A live WS connection subscribed to channel names / ``prefix.*`` patterns.

    Use as a context manager or call :meth:`close`. Values seen so far are kept in
    :attr:`latest` and can be awaited with :meth:`wait`.
    """

    def __init__(self, ws_url: str, channels: Iterable[str], callback: ChannelCallback | None = None, *,
                 on_connect: Callable[["Subscription"], None] | None = None,
                 on_message: MessageCallback | None = None,
                 producer: str | None = None, reconnect: bool = True,
                 backoff: tuple[float, float] = (0.25, 5.0), user_agent: str = "evolspace-python"):
        self.ws_url = ws_url
        self.channels: list[str] = list(dict.fromkeys(channels))
        self.callback = callback
        self.on_connect = on_connect
        self.on_message = on_message
        self.producer = producer
        self.reconnect = reconnect
        self.backoff = backoff
        self.user_agent = user_agent
        self.client_id: str | None = None
        self.latest: dict[str, tuple[Any, int]] = {}
        self.connects = 0
        self.last_error: Exception | None = None
        self._cond = threading.Condition()
        self._closed = threading.Event()
        self._connected = threading.Event()
        self._ws: Any = None
        self._send_lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, name=f"evolspace-ws[{','.join(self.channels)[:40]}]", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------ public

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def wait_connected(self, timeout: float | None = 10.0) -> bool:
        return self._connected.wait(timeout)

    def wait(self, channel: str, timeout: float | None = 10.0, *, newer_than: int | None = None) -> Any:
        """Block until a value for ``channel`` has arrived (with seq > newer_than) and return it."""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._cond:
            while True:
                cur = self.latest.get(channel)
                if cur is not None and (newer_than is None or cur[1] > newer_than):
                    return cur[0]
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise TimeoutError(f"no value on channel '{channel}' within {timeout}s")
                self._cond.wait(remaining)

    def get(self, channel: str, default: Any = None) -> Any:
        cur = self.latest.get(channel)
        return default if cur is None else cur[0]

    def add(self, channels: Iterable[str]) -> None:
        new = [c for c in channels if c not in self.channels]
        if not new:
            return
        self.channels.extend(new)
        self._send_json({"type": "channel.subscribe", "channels": new})

    def remove(self, channels: Iterable[str]) -> None:
        gone = [c for c in channels if c in self.channels]
        self.channels = [c for c in self.channels if c not in gone]
        if gone:
            self._send_json({"type": "channel.unsubscribe", "channels": gone})

    def publish(self, channel: str, value: Any, *, dtype: str | None = None) -> bool:
        """Publish over this socket (fire-and-forget; errors only show in server logs).

        Returns False when not connected. Prefer ``Client.publish`` (HTTP) when you
        need error reporting."""
        if is_tensor_like(value) or dtype is not None:
            return self._send_bytes(encode_tensor_frame(channel, value, dtype=dtype, producer=self.producer))
        return self._send_json({"type": "channel.publish", "channel": channel, "value": value})

    def send(self, message: dict[str, Any]) -> bool:
        """Send any ClientMessage (e.g. {'type': 'command', 'name': 'undo'})."""
        return self._send_json(message)

    def close(self, timeout: float = 5.0) -> None:
        self._closed.set()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001 - closing a broken socket
                pass
        if threading.current_thread() is not self._thread:
            self._thread.join(timeout)

    def __enter__(self) -> "Subscription":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ------------------------------------------------------------------ internals

    def _send_json(self, msg: dict[str, Any]) -> bool:
        # Serialization errors (NaN, unserializable objects) raise to the caller like Client.publish.
        return self._send(json.dumps(jsonable(msg), separators=(",", ":"), allow_nan=False))

    def _send_bytes(self, data: bytes) -> bool:
        return self._send(data)

    def _send(self, data: str | bytes) -> bool:
        ws = self._ws
        if ws is None or not self._connected.is_set():
            return False
        try:
            with self._send_lock:
                ws.send(data)
            return True
        except Exception as e:  # noqa: BLE001 - connection dropped; reader thread reconnects
            log.debug("send failed: %s", e)
            return False

    def _run(self) -> None:
        from websockets.sync.client import connect

        delay = self.backoff[0]
        while not self._closed.is_set():
            try:
                with connect(self.ws_url, max_size=None, compression=None, open_timeout=10,
                             user_agent_header=self.user_agent) as ws:
                    self._ws = ws
                    if self._closed.is_set():  # close() raced with the connect: don't start reading
                        break
                    ws.send(json.dumps({"type": "hello", "role": "tool", "userAgent": self.user_agent}))
                    if self.channels:
                        ws.send(json.dumps({"type": "channel.subscribe", "channels": self.channels}))
                    self._connected.set()
                    self.connects += 1
                    delay = self.backoff[0]
                    if self.on_connect:
                        try:
                            self.on_connect(self)
                        except Exception:  # noqa: BLE001 - user callback
                            log.exception("on_connect callback failed")
                    for raw in ws:
                        self._dispatch(raw)
            except Exception as e:  # noqa: BLE001 - any transport failure -> reconnect
                self.last_error = e
                if not self._closed.is_set():
                    log.info("websocket %s: %s", self.ws_url, e)
            finally:
                self._connected.clear()
                self._ws = None
            if not self.reconnect or self._closed.is_set():
                break
            self._closed.wait(delay)
            delay = min(delay * 2, self.backoff[1])

    def _dispatch(self, raw: str | bytes) -> None:
        if isinstance(raw, (bytes, bytearray, memoryview)):
            if is_audio_frame(raw):
                return
            try:
                header, arr = decode_tensor_frame(raw)
            except CodecError as e:
                log.warning("bad binary frame: %s", e)
                return
            self._deliver(str(header.get("channel")), arr, int(header.get("seq") or 0))
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("invalid JSON message from server")
            return
        t = msg.get("type")
        if t == "channel.value":
            self._deliver(str(msg.get("channel")), decode_json_value(msg.get("value")), int(msg.get("seq") or 0))
        elif t == "hello":
            self.client_id = msg.get("clientId")
        if self.on_message and t != "channel.value":
            try:
                self.on_message(msg)
            except Exception:  # noqa: BLE001 - user callback
                log.exception("on_message callback failed")

    def _deliver(self, channel: str, value: Any, seq: int) -> None:
        with self._cond:
            self.latest[channel] = (value, seq)
            self._cond.notify_all()
        if self.callback and any(_match(p, channel) for p in self.channels):
            try:
                self.callback(channel, value, seq)
            except Exception:  # noqa: BLE001 - user callback must not kill the reader
                log.exception("channel callback failed for %s", channel)
