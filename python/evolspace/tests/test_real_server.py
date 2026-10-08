"""End-to-end against the real Node server (apps/server), started on a random port.

Skipped when node/tsx are unavailable or the server fails to boot. Set
EVOL_TEST_URL=http://127.0.0.1:8787 to run against an already-running server
(only ``test.sdk.*`` channels and one tagged entity are touched, then removed).
"""

from __future__ import annotations

import threading

import numpy as np
import pytest

from evolspace import Client, NotFound

pytestmark = pytest.mark.server


def test_channels_roundtrip(real_server: str) -> None:
    c = Client(real_server, producer="sdk-test")
    try:
        assert c.health()["ok"] is True
        arr = np.random.default_rng(1).standard_normal((4, 5, 3)).astype(np.float32)
        info = c.publish("test.sdk.t", arr, description="pytest tensor")
        assert info["kind"] == "tensor" and info["shape"] == [4, 5, 3] and info["dtype"] == "f32"
        np.testing.assert_array_equal(c.get("test.sdk.t"), arr)
        c.publish("test.sdk.m", np.array([[1, 0], [0, 1]], np.uint8))
        assert c.get("test.sdk.m").dtype == np.uint8
        c.publish("test.sdk.j", {"layers": ["embed", "b0"], "x": 1.5})
        assert c.get("test.sdk.j") == {"layers": ["embed", "b0"], "x": 1.5}
        names = {ch["name"] for ch in c.channels()}
        assert {"test.sdk.t", "test.sdk.m", "test.sdk.j"} <= names
        # producer / non-ASCII description travel in the query string (headers are latin-1 only)
        c.publish("test.sdk.d", 1, description="attn — head 3")
        info = next(ch for ch in c.channels() if ch["name"] == "test.sdk.d")
        assert info.get("description") == "attn — head 3" and info.get("producer") == "sdk-test"

        got = threading.Event()
        seen: dict[str, object] = {}

        def cb(ch: str, v: object, seq: int) -> None:
            seen[ch] = v
            if ch == "test.sdk.ctl.layer" and v == 5:
                got.set()

        with c.subscribe(["test.sdk.ctl.*", "test.sdk.t"], cb) as sub:
            np.testing.assert_array_equal(sub.wait("test.sdk.t", 10), arr)  # tensor delivered on subscribe (binary frame)
            c.publish("test.sdk.ctl.layer", 5)
            assert got.wait(10)
            # WS publish (tensor + JSON) lands on the bus
            assert sub.publish("test.sdk.ws", np.full((2,), 3, np.int16))
            assert sub.publish("test.sdk.wsj", {"ok": True})
            for _ in range(100):
                try:
                    if c.get("test.sdk.wsj") == {"ok": True}:
                        break
                except NotFound:
                    pass
                threading.Event().wait(0.05)
            assert c.get("test.sdk.wsj") == {"ok": True}
            np.testing.assert_array_equal(c.get("test.sdk.ws"), np.full((2,), 3, np.int16))
    finally:
        for n in ("test.sdk.t", "test.sdk.m", "test.sdk.j", "test.sdk.ctl.layer", "test.sdk.ws", "test.sdk.wsj"):
            c.delete_channel(n)
        c.close()


def test_scene_and_agent(real_server: str) -> None:
    c = Client(real_server)
    try:
        widgets = {w["id"] for w in c.widgets()}
        if not widgets:
            pytest.skip("the widget library is empty (nothing to spawn)")
        widget = "box" if "box" in widgets else sorted(widgets)[0]
        eid = c.scene.spawn(widget, name="sdk test", position=[0, 1.2, -1.5], tags=["sdk-test"])
        try:
            assert any(e["id"] == eid for e in c.scene.find(tag="sdk-test"))
            c.scene.update(eid, position=[0.1, 1.2, -1.5])
            assert c.scene.get()["entities"][eid]["transform"]["position"] == [0.1, 1.2, -1.5]
            assert "roots" in c.scene.summary()
        finally:
            c.scene.remove(eid)
        assert isinstance(c.say("sdk test message", kind="info"), str)
        page = c.events(types=["scene.changed"])
        assert "next" in page
    finally:
        c.close()
