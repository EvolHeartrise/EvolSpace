"""SDK behaviour against the in-process fake server (see fake_server.py)."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np
import pytest

from evolspace import Client, EvolError, NotFound, port_ref


def test_publish_get_json_and_tensor(client: Client, fake) -> None:
    info = client.publish("demo.label", {"text": "hi", "n": np.int64(3)})
    assert info["kind"] == "json"
    assert client.get("demo.label") == {"text": "hi", "n": 3}
    arr = np.arange(12, dtype=np.float64).reshape(3, 4)
    info = client.publish("demo.t", arr)
    assert info["dtype"] == "f32" and info["shape"] == [3, 4]
    out = client.get("demo.t")
    assert out.dtype == np.float32
    np.testing.assert_array_equal(out, arr)
    client.publish("demo.h", np.ones(3), dtype="f16")
    assert client.get("demo.h").dtype == np.float16
    assert client.get("nope", default=None) is None
    with pytest.raises(NotFound):
        client.get("nope")
    assert client.delete_channel("demo.t") and not client.delete_channel("demo.t")
    assert [c["name"] for c in client.channels()] == ["demo.h", "demo.label"]


def test_keepalive_reconnects_after_server_drops_connection(client: Client, fake) -> None:
    client.publish("a", 1)
    assert len(client.http._idle) == 1
    client.http._idle[0].sock.close()  # simulate the server closing an idle keep-alive socket
    client.publish("a", 2)
    assert client.get("a") == 2
    assert len(client.http._idle) == 1  # the stale connection was replaced, not leaked


def test_long_poll_does_not_block_other_threads(client: Client, fake) -> None:
    """A shared Client: a long-poll on one thread must not serialize publishes on another."""
    import evolspace.transport as tr

    started = threading.Event()
    done = threading.Event()

    def slow_events() -> None:
        started.set()
        # the fake server answers /api/events immediately, so emulate a slow request
        conn, _ = client.http._acquire(5)
        try:
            time.sleep(1.5)
        finally:
            client.http._release(conn)
        done.set()

    th = threading.Thread(target=slow_events, daemon=True)
    th.start()
    assert started.wait(2)
    t0 = time.monotonic()
    client.publish("b", 1)
    assert client.get("b") == 1
    assert time.monotonic() - t0 < 1.0, "publish waited for the other thread's request"
    th.join(5)
    assert done.is_set()
    assert len(client.http._idle) <= tr.HttpTransport.MAX_IDLE


def test_unreachable_server_raises_evol_error() -> None:
    c = Client("http://127.0.0.1:9", timeout=2)
    with pytest.raises(EvolError) as e:
        c.health()
    assert e.value.status == 0
    assert not c.is_up(timeout=0.5)


def test_subscribe_receives_current_and_new_values(client: Client, fake) -> None:
    client.publish("p.ctl.layer", 3)
    client.publish("p.resid.proj", np.zeros((2, 3, 3), np.float32))
    got: list[tuple[str, object]] = []
    ev = threading.Event()

    def cb(ch: str, v: object, seq: int) -> None:
        got.append((ch, v))
        if ch == "p.ctl.token":
            ev.set()

    with client.subscribe(["p.ctl.*"], cb) as sub:
        assert sub.wait("p.ctl.layer", 5) == 3          # current value delivered on subscribe
        client.publish("p.ctl.token", 7)                 # via HTTP -> pushed over WS
        assert ev.wait(5)
        assert ("p.ctl.token", 7) in got
        assert all(ch.startswith("p.ctl.") for ch, _ in got)
        # tensors arrive as numpy arrays
        sub.add(["p.resid.proj"])
        v = sub.wait("p.resid.proj", 5)
        assert isinstance(v, np.ndarray) and v.shape == (2, 3, 3)


def test_ws_publish_and_no_echo(client: Client, fake) -> None:
    seen: list[str] = []
    with client.subscribe(["x.*"], lambda ch, v, s: seen.append(ch)) as sub:
        assert sub.wait_connected(5)
        assert sub.publish("x.json", {"a": 1})
        assert sub.publish("x.tensor", np.ones((2, 2), np.float32))
        deadline = time.time() + 5
        while time.time() < deadline and ("x.json" not in fake.channels or "x.tensor" not in fake.channels):
            time.sleep(0.02)
        assert fake.channels["x.json"]["value"] == {"a": 1}
        assert fake.channels["x.tensor"]["tensor"][1].shape == (2, 2)
        time.sleep(0.2)
        assert seen == []  # the server never echoes a client's own publishes


def test_subscription_reconnects_and_resubscribes(client: Client, fake) -> None:
    connects: list[int] = []
    with client.subscribe(["r.v"], on_connect=lambda s: connects.append(s.connects)) as sub:
        assert sub.wait_connected(5)
        fake.drop_ws_clients()
        client.publish("r.v", 42)  # published while (probably) disconnected
        deadline = time.time() + 10
        while time.time() < deadline and len(connects) < 2:
            time.sleep(0.05)
        assert len(connects) >= 2
        # the re-sent channel.subscribe delivers the current value
        assert sub.wait("r.v", 5) == 42


def test_scene_helpers(client: Client, fake) -> None:
    eid = client.scene.spawn("box", name="b", props={"color": "#f00"}, position=[0, 1, -1], scale=0.5, tags=["t"])
    e = fake.entities[eid]
    assert e["widget"] == "box" and e["transform"] == {"position": [0.0, 1.0, -1.0], "scale": [0.5, 0.5, 0.5]}
    client.scene.update(eid, props={"size": 2}, position=[1, 1, 1], name="renamed")
    assert fake.entities[eid]["props"] == {"color": "#f00", "size": 2} and fake.entities[eid]["name"] == "renamed"
    lid = client.scene.link("channel:interp.ctl.layer", f"{eid}:value", transform="x * 2")
    assert fake.links[lid]["from"] == {"kind": "channel", "channel": "interp.ctl.layer"}
    assert fake.links[lid]["to"] == {"kind": "port", "entity": eid, "port": "value"}
    assert [x["id"] for x in client.scene.find(tag="t")] == [eid]
    assert client.scene.summary()["roots"][0]["id"] == eid
    client.scene.remove(eid)
    assert eid not in fake.entities
    with pytest.raises(EvolError):
        client.scene.update("missing", props={})
    assert port_ref({"kind": "channel", "channel": "c"}) == {"kind": "channel", "channel": "c"}
    with pytest.raises(ValueError):
        port_ref("nocolon")


def test_agent_io_and_commands(client: Client, fake, tmp_path: Path) -> None:
    assert client.say("hello") == "m1"
    assert fake.said[-1] == {"text": "hello", "kind": "reply"}
    client.set_status("working", "testing")
    assert client.status()["status"] == {"state": "working", "detail": "testing"}
    assert client.command("undo") == {"ran": "undo"}
    png = client.screenshot("e12", tmp_path / "shots" / "a.png", width=320)
    assert png.startswith(b"\x89PNG") and (tmp_path / "shots" / "a.png").read_bytes() == png
    assert fake.last_screenshot == {"view": {"kind": "entity", "entity": "e12"}, "width": 320}
    client.screenshot({"kind": "camera", "position": [0, 1.6, 1], "lookAt": [0, 1, 0]})
    assert fake.last_screenshot["view"]["kind"] == "camera"


def test_events(client: Client, fake) -> None:
    fake.event("widget.event", {"name": "a"})
    page = client.events()
    assert page["next"] == 1 and page["events"][0]["data"] == {"name": "a"}
    fake.event("agent.ask", {"text": "x"})
    fake.event("widget.event", {"name": "b"})
    page = client.events(1, types=["widget.event"])
    assert [e["data"]["name"] for e in page["events"]] == ["b"]
    it = client.iter_events(["agent.ask"], since=0, wait=0.1)
    assert next(it)["data"] == {"text": "x"}


def test_ws_publish_accepts_numpy_scalars(client: Client, fake) -> None:
    with client.subscribe([]) as sub:
        assert sub.wait_connected(5)
        assert sub.publish("np.scalar", {"i": np.int64(4), "f": np.float32(0.5), "a": np.arange(2)})
        deadline = time.time() + 5
        while time.time() < deadline and "np.scalar" not in fake.channels:
            time.sleep(0.02)
    assert fake.channels["np.scalar"]["value"] == {"i": 4, "f": 0.5, "a": [0, 1]}


def test_close_right_after_open_leaves_no_connection(client: Client, fake) -> None:
    """close() racing the initial connect must stop the reader thread and drop the socket."""
    for _ in range(5):
        sub = client.subscribe(["race.*"])
        sub.close(timeout=5)
        assert not sub._thread.is_alive()
    deadline = time.time() + 5
    while time.time() < deadline and fake.ws_clients:
        time.sleep(0.02)
    assert not fake.ws_clients


def test_decode_rejects_negative_shape() -> None:
    import json as _json
    import struct

    from evolspace import CodecError, decode_tensor_frame

    head = _json.dumps({"type": "channel.value", "channel": "x", "dtype": "f32", "shape": [-1, 2]}).encode()
    frame = struct.pack("<I", len(head)) + head + b"\0" * (-(4 + len(head)) % 8) + b"\0" * 8
    with pytest.raises(CodecError):
        decode_tensor_frame(frame)
