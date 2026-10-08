"""One live process per prefix: the P.status owner lease (lease.py) and the live entry point's refusal."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

import pytest

from evolspace import Client
from evolinterp.lease import EXIT_CONFLICT, PrefixLease, pid_alive

fake_server = pytest.importorskip("fake_server")


@pytest.fixture()
def fake():
    f = fake_server.FakeEvol()
    c = Client(f.url, ws_url=f.ws_url, producer="interp:test")
    yield f, c
    c.close()
    f.close()


def _dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def _status(fake, name: str = "lp.status"):
    c = fake.channels.get(name)
    return None if c is None else c["value"]


def test_pid_alive() -> None:
    assert pid_alive(os.getpid())
    assert not pid_alive(_dead_pid())
    assert not pid_alive(0)


def test_active_owner_rules(fake) -> None:
    f, c = fake
    me = PrefixLease(c, "lp", source="interp-toy", model="toy")
    other = PrefixLease(c, "lp", source="interp-bsrl", model="bsrl")
    st = other.stamp({"state": "ready", "message": ""})
    assert me.active_owner(st)["source"] == "interp-bsrl"
    assert me.active_owner(me.stamp({"state": "ready"})) is None                 # ourselves
    assert me.active_owner({**st, "state": "stopped"}) is None                    # clean exit
    assert me.active_owner({**st, "ts": time.time() - 60}) is None                # heartbeat stale
    assert me.active_owner({"state": "ready", "ts": time.time()}) is None         # no owner (older process)
    assert me.active_owner(None) is None and me.active_owner([1]) is None
    dead = {**st, "owner": {**st["owner"], "pid": _dead_pid()}}
    assert me.active_owner(dead) is None                                          # killed (taskkill /F): take over
    remote = {**dead, "owner": {**dead["owner"], "host": "elsewhere"}}
    assert me.active_owner(remote) is not None                                    # cannot check a remote pid
    # earlier claim wins (ties: smaller id)
    me.owner["since"], other.owner["since"] = 100.0, 200.0
    assert other.beats_us(me.owner) is True and me.beats_us(other.owner) is False
    other.owner["since"] = 100.0
    assert me.beats_us(other.owner) is (other.owner["id"] < me.owner["id"])


def test_conflict_and_release(fake) -> None:
    f, c = fake
    a = PrefixLease(c, "lp", source="interp-bsrl", model="bsrl")
    b = PrefixLease(c, "lp", source="interp-toy", model="toy")
    assert a.conflict() is None
    a.publish({"state": "loading", "message": "x"})
    st = _status(f)
    assert st["owner"]["id"] == a.owner["id"] and st["owner"]["source"] == "interp-bsrl" and st["state"] == "loading"
    o = b.conflict()
    assert o is not None and o["id"] == a.owner["id"]
    msg = b.refusal_message(o)
    assert "interp-toy" in msg and "interp-bsrl" in msg and "/api/sources/interp-bsrl/stop" in msg and "'lp.*'" in msg
    a.release()
    assert _status(f)["state"] == "stopped"
    assert b.conflict() is None                                                   # free again
    # release never clobbers a successor's status
    b.publish({"state": "ready", "message": ""})
    a2 = PrefixLease(c, "lp", source="x")
    a2.release()
    assert _status(f)["owner"]["id"] == b.owner["id"] and _status(f)["state"] == "ready"


def test_heartbeat_settles_a_race(fake) -> None:
    f, c = fake
    first = PrefixLease(c, "lp", source="interp-bsrl")
    second = PrefixLease(c, "lp", source="interp-toy")
    second.owner["since"] = first.owner["since"] + 1.0
    first.publish({"state": "ready", "message": "first"})
    second.publish({"state": "ready", "message": "second"})            # overwrote the earlier owner
    contested: list[bool] = []
    first.beat(on_contest=lambda: contested.append(True))
    assert contested == [True] and _status(f)["owner"]["id"] == first.owner["id"]
    assert _status(f)["message"] == "first"
    lost: list[dict] = []
    second.beat(on_lost=lost.append)
    assert second.lost is not None and lost and lost[0]["id"] == first.owner["id"]
    second.publish({"state": "ready", "message": "late"})              # a yielded lease stays quiet
    assert _status(f)["message"] == "first"


def test_heartbeat_refreshes_ts(fake) -> None:
    f, c = fake
    a = PrefixLease(c, "lp", heartbeat=0.05)
    a.publish({"state": "ready", "message": "hi"})
    ts0 = _status(f)["ts"]
    a.start_heartbeat()
    try:
        deadline = time.time() + 5
        while _status(f)["ts"] == ts0 and time.time() < deadline:
            time.sleep(0.02)
        assert _status(f)["ts"] > ts0 and _status(f)["message"] == "hi"
    finally:
        a.release()
    assert _status(f)["state"] == "stopped"


def test_live_main_refuses_a_taken_prefix(fake, capsys) -> None:
    """A second live process on the same prefix exits with EXIT_CONFLICT before loading a model
    and leaves the owner's P.status alone."""
    from evolinterp import live

    f, c = fake
    owner = PrefixLease(c, "lq", source="interp-bsrl", model="BSRL bend7 · upd 7000")
    owner.publish({"state": "ready", "message": "serving"})
    before = _status(f, "lq.status")
    import torch

    threads = torch.get_num_threads()
    try:
        rc = live.main(["--model", "toy", "--prefix", "lq", "--url", f.url, "--threads", "1"])
    finally:
        torch.set_num_threads(threads)
    assert rc == EXIT_CONFLICT
    err = capsys.readouterr().err
    assert "refusing to start" in err and "interp-bsrl" in err and "BSRL bend7" in err
    assert _status(f, "lq.status") == before
    assert not any(n.startswith("lq.") and n != "lq.status" for n in f.channels)


def test_live_status_carries_owner(toy_session, fake) -> None:
    from evolinterp.live import LiveInterp

    f, c = fake
    lease = PrefixLease(c, "lr", source="interp-toy", model=toy_session.adapter.short_name)
    live = LiveInterp(toy_session, c, "lr", rate=4, lease=lease)
    t = threading.Thread(target=live.run, kwargs={"until": time.monotonic() + 5}, daemon=True)
    live.start()
    t.start()
    try:
        deadline = time.time() + 10
        while (_status(f, "lr.status") or {}).get("model_id") is None and time.time() < deadline:
            time.sleep(0.03)
        st = _status(f, "lr.status")
        assert st["owner"]["source"] == "interp-toy" and st["owner"]["pid"] == os.getpid()
        assert st["short_name"] == toy_session.adapter.short_name and st["state"] == "ready"
        assert PrefixLease(c, "lr").conflict()["id"] == lease.owner["id"]
    finally:
        live.stop()
        t.join(5)
        lease.release()
