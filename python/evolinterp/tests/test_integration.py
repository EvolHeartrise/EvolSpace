"""End to end: the real server supervises library/sources/interp-toy (resolving
{python:python/evolinterp}); the live process publishes the contract and follows
controls. Skipped when the server cannot start. Slow (~30 s: toy training + imports)."""

from __future__ import annotations

import time

import numpy as np
import pytest

from evolspace import Client, NotFound

server_proc = pytest.importorskip("server_proc")
pytestmark = pytest.mark.server


def _until(pred, timeout: float, what: str, sp=None):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            v = pred()
            if v:
                return v
        except NotFound as e:
            last = e
        time.sleep(0.25)
    raise AssertionError(f"timed out waiting for {what} ({last})")


def test_interp_toy_source_end_to_end(interp_data) -> None:
    sp = server_proc.start_server(env={"EVOL_INTERP_DATA": str(interp_data)})
    if isinstance(sp, str):
        pytest.skip(sp)
    c = Client(sp.url)
    try:
        ids = {s["id"] for s in c.sources()}
        assert {"interp-toy", "interp-bsrl"} <= ids
        src = c.source("interp-toy")
        assert src["running"] is False and src["autostart"] is False
        c.source("interp-toy", "start")
        try:
            def meta():
                st = c.source("interp-toy")
                if not st["running"] and st.get("lastExit"):
                    raise AssertionError("interp-toy exited:\n" + "\n".join(st["logTail"]))
                return c.get("interp.meta", default=None)

            m = _until(meta, 120, "interp.meta")
            assert m["layers"][0] == "embed" and m["sample"]["index"] == 0
            L, T = len(m["layers"]) - 1, len(m["tokens"])
            proj = c.get("interp.resid.proj")
            assert proj.dtype == np.float32 and proj.shape == (L + 1, T, 3)
            assert c.get("interp.resid.mask").dtype == np.uint8
            assert c.get("interp.attn").shape[0] == L
            c.publish("interp.ctl.sample", 9)
            _until(lambda: c.get("interp.meta")["sample"]["index"] == 9, 20, "sample 9")
            c.publish("interp.ctl.layer", 0)
            _until(lambda: c.get("interp.lens.readout")["layer"] == 0, 20, "lens layer 0")
            _until(lambda: c.get("interp.probe.index", default=[]), 120, "probes trained")
            assert c.get("interp.probe.color").shape == (L + 1, T)
        finally:
            c.source("interp-toy", "stop")
        assert c.source("interp-toy")["running"] is False
    finally:
        c.close()
        sp.stop()
