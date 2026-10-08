"""Live interp source: publishes the interp contract for the selected sample and
re-publishes whenever a control channel changes.

    python -m evolinterp.live --model bsrl|toy [--checkpoint PATH] [--prefix interp] [--url URL]

Controls (subscribed over WS): P.ctl.layer, P.ctl.token, P.ctl.sample (numbers),
P.ctl.play (bool, or a number = Hz), P.ctl.ablate (intervention list JSON).
Sample changes republish everything; layer/token changes republish only
P.lens.readout and P.sae.*.top. While playing, the process advances
P.ctl.sample itself (published over its own WS connection, which the server
never echoes back, so play cannot race with its own updates).

One process per prefix: P.status carries an owner + heartbeat (lease.py); a second
process on the same prefix refuses to start (stderr, exit code 3, and with --source it
asks the supervisor to stop it).

Startup: status -> P.status; activations for the whole dataset are cached on
disk (data/interp/<model_id>/capture.npz) after the first run; probes are
trained in a background thread when missing (--probes auto) and published when
ready.
"""

from __future__ import annotations

import argparse
import logging
import math
import os
import sys
import threading
import time
import traceback
from typing import Any

import numpy as np

from evolspace import Client, EvolError

from .contract import CTL_CHANNELS, ch, json_safe, publish_order
from .interventions import InterventionError, Interventions
from .lease import EXIT_CONFLICT, PrefixLease, describe_owner, request_self_stop
from .session import InterpSession

MAX_PLAY_HZ = 30.0


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


class LiveInterp:
    def __init__(self, session: InterpSession, client: Client, prefix: str = "interp", *, rate: float = 4.0,
                 lease: PrefixLease | None = None):
        self.s = session
        self.c = client
        self.prefix = prefix
        self.lease = lease
        a = session.adapter
        self.L, self.T, self.N = a.n_layers, a.n_tokens, a.num_samples()
        self.default_rate = max(0.1, min(float(rate), MAX_PLAY_HZ))
        # control state (guarded by _lock)
        self._lock = threading.Lock()
        self.layer = self.L
        self.token = 0
        self.sample = 0
        self.play_hz = 0.0
        self.iv = Interventions()
        self._dirty = {"static": True, "sample": True, "lens": True}
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._last_advance = 0.0
        self._status: dict[str, Any] = {"state": "ready", "message": ""}
        # an error status is cleared by the next successful publish that follows a control change
        # (not by a reconnect/heartbeat republish of the same state, which would hide the error)
        self._ctl_gen = 0
        self._err_gen = -1
        self.sub = None
        self.published = 0

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        self._load_initial_controls()
        self.sub = self.c.subscribe([ch(self.prefix, "ctl.*")], self._on_ctl, on_connect=self._on_connect)

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self.sub is not None:
            self.sub.close()

    def run(self, until: float | None = None) -> None:
        """Main loop (blocks). ``until``: optional monotonic deadline (tests)."""
        while not self._stop.is_set():
            if until is not None and time.monotonic() >= until:
                break
            with self._lock:
                hz = self.play_hz
            timeout = 1.0 / hz if hz > 0 else 1.0
            if until is not None:
                timeout = max(0.0, min(timeout, until - time.monotonic()))
            self._wake.wait(timeout)
            self._wake.clear()
            if self._stop.is_set():
                break
            if hz > 0 and time.monotonic() - self._last_advance >= 1.0 / hz * 0.98:
                self._advance()
            self.flush()

    # ------------------------------------------------------------------ controls

    def _load_initial_controls(self) -> None:
        """Adopt control values already on the bus (e.g. a slider's last value)."""
        for name in ("layer", "token", "sample", "play", "ablate"):
            try:
                v = self.c.get(ch(self.prefix, f"ctl.{name}"), default=None)
            except EvolError:
                v = None
            if v is not None:
                self._apply_ctl(name, v)

    def _on_connect(self, sub: Any) -> None:
        """(Re)connected — the server may have restarted and lost every channel: republish
        all data, and re-seed control channels the server does not have (defaults on the
        first start, the current state after a restart) so bound sliders show the truth.
        Controls the server still holds are left alone (they arrive via the subscription)."""
        with self._lock:
            for k in self._dirty:
                self._dirty[k] = True
            vals: dict[str, Any] = {"layer": self.layer, "token": self.token, "sample": self.sample,
                                    "play": self.play_hz > 0}
            if self.iv:
                vals["ablate"] = self.iv.to_json()
        for n, v in vals.items():
            name = ch(self.prefix, f"ctl.{n}")
            try:
                exists = self.c.get(name, default=None) is not None
            except EvolError:
                exists = True  # cannot tell: don't overwrite
            if not exists:
                sub.publish(name, v)
        self._wake.set()

    def _on_ctl(self, channel: str, value: Any, seq: int) -> None:
        name = channel[len(self.prefix) + len(".ctl."):]
        if name in CTL_CHANNELS:
            self._apply_ctl(name, value)

    def _apply_ctl(self, name: str, value: Any) -> None:
        try:
            changed = self._set(name, value)
        except (InterventionError, TypeError, ValueError) as e:
            self._set_status("error", f"bad {self.prefix}.ctl.{name}: {e}")
            log(f"[live] ignored {name}={value!r}: {e}")
            return
        if changed:
            with self._lock:
                self._ctl_gen += 1
            self._wake.set()

    def _set(self, name: str, value: Any) -> bool:
        with self._lock:
            if name == "ablate":
                a = self.s.adapter
                iv = Interventions.parse(value, n_layers=a.n_layers, n_heads=a.n_heads, n_tokens=a.n_tokens)
                if iv.key() == self.iv.key():
                    return False
                self.iv = iv
                self._dirty["sample"] = self._dirty["lens"] = True
                return True
            if name == "play":
                hz = _play_hz(value, self.default_rate)
                if hz == self.play_hz:
                    return False
                self.play_hz = hz
                self._last_advance = time.monotonic()
                return True
            v = _num(value)
            if name == "layer":
                v = int(np.clip(round(v), 0, self.L))
                if v == self.layer:
                    return False
                self.layer = v
                self._dirty["lens"] = True
            elif name == "token":
                v = int(np.clip(round(v), 0, self.T - 1))
                if v == self.token:
                    return False
                self.token = v
                self._dirty["lens"] = True
            elif name == "sample":
                v = int(round(v)) % self.N
                if v == self.sample:
                    return False
                self.sample = v
                self._dirty["sample"] = self._dirty["lens"] = True
            return True

    def _advance(self) -> None:
        with self._lock:
            self._ctl_gen += 1
            self.sample = (self.sample + 1) % self.N
            self._dirty["sample"] = self._dirty["lens"] = True
            s = self.sample
            self._last_advance = time.monotonic()
        if self.sub is not None:
            self.sub.publish(ch(self.prefix, "ctl.sample"), s)  # over WS: never echoed back to us

    def mark_static_dirty(self) -> None:
        with self._lock:
            self._dirty["static"] = self._dirty["sample"] = self._dirty["lens"] = True
        self._wake.set()

    # ------------------------------------------------------------------ publishing

    def _set_status(self, state: str, message: str, gen: int | None = None) -> None:
        """gen: control generation the error belongs to (default: the current one)."""
        with self._lock:
            self._status = {"state": state, "message": message}
            if state == "error":
                self._err_gen = self._ctl_gen if gen is None else gen
        self._publish_status()

    def _publish_status(self) -> None:
        with self._lock:
            st = {**self._status, "model": self.s.adapter.model_name,
                  "short_name": self.s.adapter.short_name or self.s.adapter.model_name, "model_id": self.s.adapter.model_id,
                  "sample": self.sample, "layer": self.layer, "token": self.token, "play": self.play_hz,
                  "interventions": self.iv.to_json(), "probes": self.s.probes.names if self.s.probes else [],
                  "saes": sorted(self.s.saes), "pid": os.getpid(), "ts": time.time()}
        if self.lease is not None:
            self.lease.publish(st)  # stamps owner + ts; re-sent by the lease heartbeat
            return
        try:
            self.c.publish(ch(self.prefix, "status"), st)
        except EvolError as e:
            log(f"[live] status publish failed: {e.message}")

    def flush(self) -> bool:
        """Publish whatever is dirty. Returns False if publishing failed (state stays dirty)."""
        with self._lock:
            dirty = dict(self._dirty)
            if not any(dirty.values()):
                return True
            for k in self._dirty:
                self._dirty[k] = False
            i, layer, token, iv = self.sample, self.layer, self.token, self.iv
            gen = self._ctl_gen
        try:
            t0 = time.perf_counter()
            payload: dict[str, Any] = {}
            if dirty["static"]:
                payload.update(self.s.static_payload(self.prefix))
            payload.update(self.s.payload(self.prefix, i, layer, token, iv, sample=dirty["sample"] or dirty["static"],
                                          lens=dirty["lens"] or dirty["sample"] or dirty["static"]))
            t1 = time.perf_counter()
            for name, value in publish_order(payload):
                self.c.publish(name, value if isinstance(value, np.ndarray) else json_safe(value))
            self.published += 1
            if dirty["sample"] or dirty["static"]:
                with self._lock:
                    if self._status.get("state") == "error" and gen > self._err_gen:
                        self._status = {"state": "ready", "message": ""}
                self._publish_status()
            if self.published <= 2 or (time.perf_counter() - t0) > 0.5:
                log(f"[live] published {len(payload)} channels for sample {i} layer {layer} token {token} "
                    f"(compute {1e3 * (t1 - t0):.0f} ms, send {1e3 * (time.perf_counter() - t1):.0f} ms)")
            return True
        except EvolError as e:
            if 400 <= e.status < 500:
                # the server rejected a value: retrying the same payload cannot help
                log(f"[live] publish rejected: {e.message}")
                self._set_status("error", f"publish rejected: {e.message}")
                return False
            with self._lock:  # server down / restarting: keep the work and retry
                for k, v in dirty.items():
                    self._dirty[k] = self._dirty[k] or v
            log(f"[live] publish failed ({e.message}); retrying")
            self._stop.wait(1.0)
            self._wake.set()
            return False
        except Exception as e:  # noqa: BLE001 - a bad sample/intervention must not kill the source
            # Not retried: the same state would fail again (and a crash would make the supervisor
            # restart us into the same control values). The next control change tries again.
            traceback.print_exc()
            self._set_status("error", f"computing sample {i} failed: {type(e).__name__}: {e}", gen=gen)
            return False


_TRUE = {"true", "on", "yes", "play"}
_FALSE = {"false", "off", "no", "stop", "pause", ""}


def _play_hz(value: Any, default_rate: float) -> float:
    """P.ctl.play: bool (default rate), a number (Hz; <= 0 stops) or a string of either
    (voice commands substitute strings). Clamped to MAX_PLAY_HZ."""
    if isinstance(value, str):
        s = value.strip().lower()
        if s in _TRUE:
            value = True
        elif s in _FALSE:
            value = False
    if value is None or isinstance(value, bool):
        hz = default_rate if value else 0.0
    else:
        hz = _num(value)
    return 0.0 if hz <= 0 else min(hz, MAX_PLAY_HZ)


def _num(v: Any) -> float:
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float, np.number)):
        f = float(v)
    elif isinstance(v, str):
        f = float(v.strip())
    elif isinstance(v, dict) and "value" in v:
        return _num(v["value"])
    else:
        raise TypeError(f"expected a number, got {type(v).__name__}")
    if not math.isfinite(f):
        raise ValueError("not finite")
    return f


def build_parser(p: argparse.ArgumentParser | None = None) -> argparse.ArgumentParser:
    p = p or argparse.ArgumentParser(prog="python -m evolinterp.live", description=__doc__.split("\n\n")[0])
    p.add_argument("--model", choices=("bsrl", "toy"), default="toy")
    p.add_argument("--checkpoint", default=None, help="model checkpoint (bsrl: .pt; toy: weights cache path)")
    p.add_argument("--dataset", default=None, help="bsrl: observations .npy (N, 630) instead of the checkpoint's diag_probe_obs")
    p.add_argument("--prefix", default="interp", help="channel prefix P (default interp)")
    p.add_argument("--url", default=None, help="server URL (default $EVOL_URL or http://127.0.0.1:8787)")
    p.add_argument("--rate", type=float, default=4.0, help="auto-advance rate (Hz) for P.ctl.play=true")
    p.add_argument("--probes", choices=("auto", "load", "off"), default="auto",
                   help="auto: load saved probes or train them in the background; load: only load; off")
    p.add_argument("--threads", type=int, default=int(os.environ.get("EVOL_INTERP_THREADS", "4")),
                   help="torch CPU threads (keep the PC responsive)")
    p.add_argument("--source", default=os.environ.get("EVOL_SOURCE_ID") or None,
                   help="supervised source id (library/sources/<id>); named in P.status.owner, and stopped via the "
                        "server API when this process refuses to start because the prefix is taken")
    return p


def _refuse(lease: PrefixLease, client: Client, other: dict[str, Any], source: str | None) -> int:
    msg = lease.refusal_message(other)
    print(time.strftime("%H:%M:%S"), f"[live] {msg}", file=sys.stderr, flush=True)
    request_self_stop(client, source, log=log)  # supervised: no restart loop (the server kills us here)
    return EXIT_CONFLICT


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s %(message)s")
    import torch

    torch.set_num_threads(max(1, args.threads))
    client = Client(args.url, producer=f"interp:{args.prefix}")
    if not client.is_up():
        log(f"[live] waiting for the EvolSpace server at {client.url} ...")
        client.wait_until_up()

    # one live process per prefix (interp-bsrl and interp-toy share "interp"): see lease.py
    lease = PrefixLease(client, args.prefix, source=args.source, model=args.model, log=log)
    other = lease.conflict()
    if other is not None:
        return _refuse(lease, client, other, args.source)

    def status(state: str, message: str) -> None:
        log(f"[live] {state}: {message}")
        lease.publish({"state": state, "message": message, "model": args.model})

    status("loading", f"loading {args.model} model")          # claims the prefix
    time.sleep(0.5)                                            # settle a simultaneous start
    other = lease.conflict()
    if other is not None and lease.beats_us(other):
        return _refuse(lease, client, other, args.source)
    live: LiveInterp | None = None

    def on_lost(o: dict[str, Any]) -> None:
        print(time.strftime("%H:%M:%S"), f"[live] yielding '{args.prefix}.*' to {describe_owner(o)}, which claimed it "
              "first; exiting", file=sys.stderr, flush=True)
        if live is not None:
            live.stop()

    def on_contest() -> None:
        if live is not None:
            live.mark_static_dirty()  # the other process may have overwritten our channels

    lease.start_heartbeat(on_contest=on_contest, on_lost=on_lost)
    try:
        from .adapters import make_adapter

        adapter = make_adapter(args.model, args.checkpoint, dataset=args.dataset, log=log)
        lease.set_model(adapter.short_name or adapter.model_name)
        if lease.lost is None:
            status("loading", f"capturing activations for {adapter.num_samples()} samples (cached after the first run)")
            session = InterpSession.open(adapter, probes="off" if args.probes == "off" else "load", log=log)
    except Exception as e:  # noqa: BLE001 - report on the bus, then exit non-zero (supervisor backs off)
        status("error", f"{type(e).__name__}: {e}")
        traceback.print_exc()
        lease.release(publish=False)  # keep the error on P.status; our dead pid frees the prefix
        client.close()
        return 1
    if lease.lost is not None:
        request_self_stop(client, args.source, log=log)
        client.close()
        return EXIT_CONFLICT

    live = LiveInterp(session, client, args.prefix, rate=args.rate, lease=lease)
    live.start()
    if session.probes is None and args.probes == "auto":
        def train() -> None:
            live._set_status("training-probes", "training linear probes (published when done)")
            try:
                session.train_probes(log=log)
                live._status = {"state": "ready", "message": "probes trained"}
                live.mark_static_dirty()
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                live._set_status("error", f"probe training failed: {e}")

        threading.Thread(target=train, name="probe-train", daemon=True).start()
    log(f"[live] serving {adapter.model_name} on '{args.prefix}.*' ({adapter.num_samples()} samples, "
        f"L={adapter.n_layers} T={adapter.n_tokens})")
    try:
        live.run()
    except KeyboardInterrupt:
        pass
    finally:
        live.stop()
        if lease.lost is None:
            lease.release()
    if lease.lost is not None:
        request_self_stop(client, args.source, log=log)
        client.close()
        return EXIT_CONFLICT
    client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
