"""Live process loop against the SDK's in-process fake server (toy model)."""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

import numpy as np
import pytest

from evolspace import Client
from evolinterp.contract import validate
from evolinterp.live import LiveInterp

fake_server = pytest.importorskip("fake_server")


def _until(pred: Callable[[], Any], timeout: float = 10.0) -> Any:
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = pred()
        if v:
            return v
        time.sleep(0.03)
    raise AssertionError("condition not met in time")


@pytest.fixture()
def running(toy_session):
    fake = fake_server.FakeEvol()
    client = Client(fake.url, ws_url=fake.ws_url, producer="interp:test")
    fake.publish("tl.ctl.layer", 1)  # a slider already holds a value: adopted at startup
    live = LiveInterp(toy_session, client, "tl", rate=20)
    live.start()
    t = threading.Thread(target=live.run, daemon=True)
    t.start()
    try:
        yield fake, client, live
    finally:
        live.stop()
        t.join(5)
        client.close()
        fake.close()


def _val(fake, name):
    c = fake.channels.get(name)
    if c is None:
        return None
    return c["tensor"][1] if c["tensor"] else c["value"]


def test_publishes_contract_on_start(running, toy_session) -> None:
    fake, client, live = running
    a = toy_session.adapter
    _until(lambda: _val(fake, "tl.lens.readout"))
    _until(lambda: _val(fake, "tl.status"))
    payload = {n: _val(fake, n) for n in fake.channels if n.startswith("tl.") and not n.startswith("tl.ctl.")}
    assert validate(payload, "tl", L=a.n_layers, T=a.n_tokens, H=a.n_heads) == []
    for n in ("meta", "resid.proj", "resid.norm", "resid.delta", "resid.mask", "attn", "probe.index", "probe.color",
              "probe.color.acc", "lens.readout", "status"):
        assert f"tl.{n}" in fake.channels, n
    assert _val(fake, "tl.meta")["sample"]["index"] == 0
    assert _val(fake, "tl.lens.readout")["layer"] == 1          # adopted from the existing ctl value
    # defaults seeded for the controls nobody had set
    _until(lambda: _val(fake, "tl.ctl.sample") == 0 and _val(fake, "tl.ctl.play") is False)


def test_controls_trigger_republish(running) -> None:
    fake, client, live = running
    _until(lambda: _val(fake, "tl.meta"))
    proj_seq = fake.channels["tl.resid.proj"]["seq"]
    client.publish("tl.ctl.sample", 7)
    _until(lambda: _val(fake, "tl.meta")["sample"]["index"] == 7)
    assert fake.channels["tl.resid.proj"]["seq"] > proj_seq
    # layer/token changes only republish the lens (not the sample tensors)
    proj_seq = fake.channels["tl.resid.proj"]["seq"]
    client.publish("tl.ctl.token", 3)
    _until(lambda: _val(fake, "tl.lens.readout")["token"] == 3)
    client.publish("tl.ctl.layer", 99)                            # clamped to L
    _until(lambda: _val(fake, "tl.lens.readout")["layer"] == live.L)
    time.sleep(0.2)
    assert fake.channels["tl.resid.proj"]["seq"] == proj_seq
    # interventions
    client.publish("tl.ctl.ablate", [{"op": "attn", "layer": 0}])
    _until(lambda: "b0 attn off" in _val(fake, "tl.meta")["interventions"])
    _until(lambda: "KL(clean" in str(_val(fake, "tl.lens.readout")["items"]))
    # a bad control value is reported, not fatal
    client.publish("tl.ctl.ablate", [{"op": "bogus"}])
    _until(lambda: (_val(fake, "tl.status") or {}).get("state") == "error")
    client.publish("tl.ctl.ablate", [])
    _until(lambda: _val(fake, "tl.meta")["interventions"] == "none")


def test_play_advances_samples(running) -> None:
    fake, client, live = running
    _until(lambda: _val(fake, "tl.meta"))
    client.publish("tl.ctl.sample", 10)
    _until(lambda: _val(fake, "tl.meta")["sample"]["index"] == 10)
    client.publish("tl.ctl.play", 20)
    _until(lambda: _val(fake, "tl.meta")["sample"]["index"] >= 13, timeout=10)
    # the process mirrors the advancing sample onto the control channel (for sliders)
    _until(lambda: (_val(fake, "tl.ctl.sample") or 0) >= 12)
    client.publish("tl.ctl.play", False)
    time.sleep(0.3)
    idx = _val(fake, "tl.meta")["sample"]["index"]
    time.sleep(0.4)
    assert _val(fake, "tl.meta")["sample"]["index"] == idx


def test_republishes_after_reconnect(running) -> None:
    fake, client, live = running
    _until(lambda: _val(fake, "tl.meta"))
    # simulate a server restart that lost every channel
    with fake.lock:
        for n in [n for n in fake.channels if not n.startswith("tl.ctl.")]:
            del fake.channels[n]
    fake.drop_ws_clients()
    _until(lambda: _val(fake, "tl.meta"), timeout=15)
    assert isinstance(_val(fake, "tl.resid.proj"), np.ndarray)


def test_compute_error_is_reported_not_fatal(running, monkeypatch) -> None:
    """An exception while computing a sample (bug, odd intervention) must not kill the
    source: a crash would make the supervisor restart it into the same control values."""
    fake, client, live = running
    _until(lambda: _val(fake, "tl.meta"))
    orig = live.s.payload

    def payload(prefix, i, *a, **kw):
        if i == 13:
            raise RuntimeError("boom")
        return orig(prefix, i, *a, **kw)

    monkeypatch.setattr(live.s, "payload", payload)
    client.publish("tl.ctl.sample", 13)
    _until(lambda: (_val(fake, "tl.status") or {}).get("state") == "error")
    assert "boom" in _val(fake, "tl.status")["message"]
    client.publish("tl.ctl.sample", 14)                      # the loop is still alive
    _until(lambda: _val(fake, "tl.meta")["sample"]["index"] == 14)
    _until(lambda: _val(fake, "tl.status")["state"] == "ready")


def test_extreme_intervention_stays_json_safe(running) -> None:
    fake, client, live = running
    _until(lambda: _val(fake, "tl.meta"))
    # rejected outright (non-finite / absurd scales)
    client.publish("tl.ctl.ablate", [{"op": "mlp", "layer": 0, "scale": 1e30}])
    _until(lambda: (_val(fake, "tl.status") or {}).get("state") == "error")
    # allowed but extreme: readouts may hold non-finite numbers -> published as null, never a crash
    client.publish("tl.ctl.ablate", [{"op": "mlp", "layer": i, "scale": 1e6} for i in range(live.L)])
    _until(lambda: "x1e+06" in _val(fake, "tl.meta")["interventions"])
    ro = _val(fake, "tl.lens.readout")
    assert ro["items"] and all(it["value"] is None or np.isfinite(it["value"]) for it in ro["items"])


def test_reconnect_reseeds_lost_controls(running) -> None:
    """After a server restart the bus has no control values: the process re-seeds them from
    its current state (not the defaults), so bound sliders show the truth."""
    fake, client, live = running
    _until(lambda: _val(fake, "tl.meta"))
    client.publish("tl.ctl.sample", 5)
    client.publish("tl.ctl.ablate", [{"op": "head", "layer": 1, "head": 0}])
    _until(lambda: "b1h0" in _val(fake, "tl.meta")["interventions"] and _val(fake, "tl.meta")["sample"]["index"] == 5)
    with fake.lock:
        fake.channels.clear()
    fake.drop_ws_clients()
    _until(lambda: _val(fake, "tl.meta"), timeout=15)
    _until(lambda: _val(fake, "tl.ctl.sample") == 5)
    assert _val(fake, "tl.ctl.layer") == 1                     # the adopted value, not the default L
    assert _val(fake, "tl.ctl.ablate") == [{"op": "head", "layer": 1, "head": 0, "scale": 0.0}]
    assert _val(fake, "tl.meta")["sample"]["index"] == 5


def test_play_value_forms() -> None:
    from evolinterp.live import MAX_PLAY_HZ, _play_hz

    assert _play_hz(True, 4) == 4 and _play_hz(False, 4) == 0 and _play_hz(None, 4) == 0
    assert _play_hz(2, 4) == 2 and _play_hz(0, 4) == 0 and _play_hz(-1, 4) == 0 and _play_hz(1e9, 4) == MAX_PLAY_HZ
    assert _play_hz("on", 4) == 4 and _play_hz("False", 4) == 0 and _play_hz("2.5", 4) == 2.5
    with pytest.raises(ValueError):
        _play_hz("sometimes", 4)
    with pytest.raises(ValueError):
        _play_hz(float("nan"), 4)
