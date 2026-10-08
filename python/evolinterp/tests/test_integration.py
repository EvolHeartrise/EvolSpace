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
            st = c.get("interp.status")
            assert st["owner"]["source"] == "interp-toy" and m["short_name"].startswith("toy")
            toy_pid = st["owner"]["pid"]

            # a second interp source on the same prefix refuses (before loading its model) and
            # stops itself, so the supervisor does not restart it in a loop
            c.source("interp-bsrl", "start")
            def refused():
                b = c.source("interp-bsrl")
                return not b["running"] and b.get("lastExit") and b
            b = _until(refused, 90, "interp-bsrl refusal")
            log = "\n".join(b["logTail"])
            assert "refusing to start source interp-bsrl" in log and "interp-toy" in log, log
            time.sleep(2.0)
            assert c.source("interp-bsrl")["running"] is False                     # not restarted
            assert c.get("interp.status")["owner"]["pid"] == toy_pid               # owner untouched
            assert c.get("interp.meta")["short_name"] == m["short_name"]

            # restarting the owner itself: the killed process leaves a fresh-looking status,
            # but its pid is dead, so the new process takes the prefix over
            c.source("interp-toy", "restart")
            def taken_over():
                s = c.get("interp.status", default=None) or {}
                return s.get("owner", {}).get("pid") not in (None, toy_pid) and s.get("state") in ("ready", "training-probes")
            _until(taken_over, 120, "restarted interp-toy owning the prefix")
            assert c.source("interp-toy")["running"] is True
        finally:
            c.source("interp-toy", "stop")
        assert c.source("interp-toy")["running"] is False
    finally:
        c.close()
        sp.stop()
