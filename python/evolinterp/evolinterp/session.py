"""InterpSession: an adapter + its dataset cache + probes + SAEs, answering
"what should be published for sample i / layer l / token t (under interventions)".

Used by the live process and handy from a Python shell:

    from evolinterp.session import InterpSession
    from evolinterp.adapters import make_adapter
    s = InterpSession.open(make_adapter("bsrl"))
    view = s.view(17)                         # SampleView (contract arrays)
    s.readout(17, layer=6, token=0)           # P.lens.readout dict
    s.payload("interp", 17, 6, 0)             # every channel -> value
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .adapters.base import Adapter, Capture
from .capture import DatasetCache, load_or_capture, model_dir
from .contract import SampleView, ch, meta_payload, sample_channels
from .interventions import Interventions
from .probes import ProbeSet, format_table, train_probes
from .sae import SparseAutoencoder, load_sae

Log = Callable[[str], None] | None


class InterpSession:
    def __init__(self, adapter: Adapter, cache: DatasetCache, *, probes: ProbeSet | None = None,
                 saes: dict[str, tuple[SparseAutoencoder, dict[str, Any]]] | None = None, lru: int = 64):
        self.adapter = adapter
        self.cache = cache
        self.probes = probes
        self.saes = saes or {}
        self._lru: OrderedDict[tuple[int, str], Capture] = OrderedDict()
        self._lru_size = lru
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ construction

    @classmethod
    def open(cls, adapter: Adapter, *, probes: str = "load", force_capture: bool = False, log: Log = print) -> "InterpSession":
        """probes: 'load' (use saved probes if present), 'train' (train if missing), 'off'."""
        cache, resid = load_or_capture(adapter, force=force_capture, keep_resid=False, log=log)
        s = cls(adapter, cache)
        if probes != "off":
            s.probes = ProbeSet.load(s.probes_path)
            if s.probes is not None and s.probes.meta.get("model_id") != adapter.model_id:
                s.probes = None
            if s.probes is None and probes == "train":
                s.train_probes(log=log)
        s.load_saes(log=log)
        return s

    @property
    def dir(self) -> Path:
        return model_dir(self.adapter)

    @property
    def probes_path(self) -> Path:
        return self.dir / "probes.npz"

    def train_probes(self, log: Log = print, **kw: Any) -> ProbeSet:
        cache, resid = load_or_capture(self.adapter, keep_resid=True, log=log)
        assert resid is not None
        ps = train_probes(self.adapter, resid, cache.mask, log=log, **kw)
        ps.save(self.probes_path)
        if log:
            log(f"[probe] saved {self.probes_path}\n" + format_table(ps, self.adapter.layer_labels))
        with self._lock:
            self.cache = cache
            self.probes = ps
        return ps

    def load_saes(self, log: Log = print) -> None:
        for p in sorted(self.dir.glob("sae-*.pt")):
            label = p.stem[len("sae-"):]
            if label not in self.adapter.layer_labels:
                continue
            try:
                self.saes[label] = load_sae(p)
                if log:
                    log(f"[sae] loaded {p.name}")
            except Exception as e:  # noqa: BLE001 - a stale/corrupt file must not stop the session
                if log:
                    log(f"[sae] could not load {p.name}: {e}")

    # ------------------------------------------------------------------ captures

    def n_samples(self) -> int:
        return self.adapter.num_samples()

    def capture(self, i: int, interventions: Interventions | None = None) -> Capture:
        iv = interventions or Interventions()
        key = (int(i), iv.key())
        with self._lock:
            cap = self._lru.get(key)
            if cap is not None:
                self._lru.move_to_end(key)
                return cap
        cap = self.adapter.run([int(i)], iv, want_attn=True)
        with self._lock:
            self._lru[key] = cap
            while len(self._lru) > self._lru_size:
                self._lru.popitem(last=False)
        return cap

    def view(self, i: int, interventions: Interventions | None = None) -> SampleView:
        a = self.adapter
        i = int(i) % a.num_samples()
        iv = interventions or Interventions()
        cap = self.capture(i, iv)
        mask = a.mask([i])[0]
        if iv:
            proj = self.cache.projector.project(cap.resid[0]) * mask[..., None]
            norm = np.linalg.norm(cap.resid[0], axis=-1) * mask
            delta = np.stack([cap.attn_write[0], cap.mlp_write[0]], axis=1)
        else:
            proj, norm, delta = self.cache.proj[i], self.cache.norm[i], self.cache.delta[i]
        probes = {}
        if self.probes is not None:
            probes = self.probes.scores(cap.resid[0], a.probe_labels_for(i), mask)
        return SampleView(index=i, total=a.num_samples(), label=a.sample_label(i),
                          tokens=[t.to_json() for t in a.tokens(i)], proj=proj.astype(np.float32),
                          norm=norm.astype(np.float32), delta=delta.astype(np.float32),
                          mask=mask.astype(np.uint8), attn=None if cap.attn is None else cap.attn[0], probes=probes)

    def readout(self, i: int, layer: int, token: int, interventions: Interventions | None = None) -> dict[str, Any]:
        iv = interventions or Interventions()
        cap = self.capture(i, iv)
        clean = self.capture(i) if iv else None
        ro = self.adapter.lens(int(i), cap, int(layer), int(token), probes=self.probes, clean=clean)
        if iv:
            ro["title"] += f" [{iv.describe()}]"
        return ro

    def sae_top(self, label: str, i: int, token: int, interventions: Interventions | None = None, k: int = 8) -> dict[str, Any]:
        from .sae import top_features

        sae, meta = self.saes[label]
        li = self.adapter.layer_labels.index(label)
        cap = self.capture(i, interventions)
        ok = bool(self.adapter.mask([i])[0, li, token])
        feats = []
        if ok:
            summ = meta.get("features", [])
            for fid, act in top_features(sae, cap.resid[0, li, token], k):
                s = summ[fid] if fid < len(summ) else {}
                feats.append({"id": fid, "act": round(act, 4), "label": s.get("label", ""), "freq": round(s.get("freq", 0.0), 4)})
        return {"layer": label, "token": int(token), "sample": int(i), "features": feats,
                "stats": meta.get("stats", {}), "note": "" if ok else "no residual at this layer/token"}

    # ------------------------------------------------------------------ payloads

    def static_payload(self, prefix: str) -> dict[str, Any]:
        """Channels that only change when probes/SAEs change."""
        out: dict[str, Any] = {}
        if self.probes is not None:
            out[ch(prefix, "probe.index")] = self.probes.index()
            out[ch(prefix, "probe.info")] = self.probes.info()
            for name, pr in self.probes.probes.items():
                out[ch(prefix, f"probe.{name}.acc")] = pr.acc
        else:
            out[ch(prefix, "probe.index")] = []
        out[ch(prefix, "sae.index")] = sorted(self.saes, key=self.adapter.layer_labels.index)
        return out

    def meta(self, view: SampleView, interventions: Interventions | None = None) -> dict[str, Any]:
        a = self.adapter
        iv = interventions or Interventions()
        return meta_payload(model=a.model_name, short_name=a.short_name or a.model_name, checkpoint=a.checkpoint,
                            layers=a.layer_labels, view=view, d_model=a.d_model, n_heads=a.n_heads,
                            lens_kind=a.lens_kind, lens_description=a.lens_description,
                            interventions=iv.describe([t["label"] for t in view.tokens]),
                            probes=self.probes.names if self.probes else [],
                            proj=self.cache.projector.describe())

    def payload(self, prefix: str, i: int, layer: int, token: int, interventions: Interventions | None = None, *,
                sample: bool = True, lens: bool = True) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if sample:
            v = self.view(i, interventions)
            out.update(sample_channels(prefix, v, self.meta(v, interventions)))
        if lens:
            out[ch(prefix, "lens.readout")] = self.readout(i, layer, token, interventions)
            for label in self.saes:
                out[ch(prefix, f"sae.{label}.top")] = self.sae_top(label, i, token, interventions)
        return out
