"""The interp data contract (ARCHITECTURE.md "Interp data contract"): channel
names, payload construction and validation.

Producer channels (prefix P, default "interp"):
  P.meta            JSON  {model, short_name, checkpoint?, layers[L+1], tokens[T]{label, group, detail?}, d_model,
                           sample{index, total, label}, lens{kind, description}, heads, interventions, probes,
                           proj{normalized, basis, explained_variance[3]}}
  P.resid.proj      f32 [L+1, T, 3]   shared-PCA projection of per-vector-normalized residuals, ~unit range
  P.resid.norm      f32 [L+1, T]
  P.resid.delta     f32 [L, 2, T]     attention (0) / MLP (1) write norms
  P.resid.mask      u8  [L+1, T]
  P.attn            f32 [L, H, T, T]  query x key
  P.probe.index     JSON string[]     probe names
  P.probe.info      JSON              classes, descriptions, accuracy, score semantics (extension)
  P.probe.<name>    f32 [L+1, T]      2*P(true class)-1 in [-1, 1], NaN = n/a
  P.probe.<name>.acc f32 [L+1]        held-out accuracy, NaN = no probe at that layer
  P.lens.readout    JSON {layer, token, title, items[{label, value}]}
  P.sae.index       JSON string[]     layer labels with a trained SAE (extension)
  P.sae.<layer>.top JSON {layer, token, sample, features[{id, act, label, freq}]} (extension)
  P.status          JSON {state, message, interventions, ...} (extension)
Inputs: P.ctl.layer, P.ctl.token, P.ctl.sample (numbers), P.ctl.play (bool or Hz),
        P.ctl.ablate (JSON intervention list, extension; see interventions.py).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

CTL_CHANNELS = ("layer", "token", "sample", "play", "ablate")


def ch(prefix: str, name: str) -> str:
    return f"{prefix}.{name}"


def publish_order(payload: dict[str, Any]) -> list[tuple[str, Any]]:
    """Payload items in publish order: index channels (P.probe.index, P.sae.index) last, so a
    consumer that reacts to an index never looks up a channel that is not published yet."""
    return sorted(payload.items(), key=lambda kv: kv[0].endswith(".index"))  # stable


def json_safe(v: Any) -> Any:
    """Replace non-finite floats in a JSON value with None (the bus rejects NaN/Infinity;
    extreme interventions can produce them in readouts / SAE activations)."""
    if isinstance(v, float) or isinstance(v, np.floating):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [json_safe(x) for x in v]
    return v


@dataclass
class SampleView:
    """Everything published for one sample (+ interventions)."""

    index: int
    total: int
    label: str
    tokens: list[dict[str, Any]]
    proj: np.ndarray        # [L+1, T, 3] f32
    norm: np.ndarray        # [L+1, T] f32
    delta: np.ndarray       # [L, 2, T] f32
    mask: np.ndarray        # [L+1, T] u8
    attn: np.ndarray | None  # [L, H, T, T] f32
    probes: dict[str, np.ndarray] = field(default_factory=dict)   # name -> [L+1, T] f32


def meta_payload(*, model: str, checkpoint: str | None, layers: list[str], view: SampleView, d_model: int,
                 n_heads: int, lens_kind: str, lens_description: str, interventions: str = "none",
                 probes: list[str] | None = None, short_name: str | None = None,
                 proj: dict[str, Any] | None = None) -> dict[str, Any]:
    m: dict[str, Any] = {
        "model": model,
        "short_name": short_name or model,
        "layers": layers,
        "tokens": view.tokens,
        "d_model": d_model,
        "heads": n_heads,
        "sample": {"index": view.index, "total": view.total, "label": view.label},
        "lens": {"kind": lens_kind, "description": lens_description},
        "interventions": interventions,
        "probes": probes or [],
    }
    if checkpoint:
        m["checkpoint"] = checkpoint
    if proj is not None:
        m["proj"] = proj
    return m


def sample_channels(prefix: str, view: SampleView, meta: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        ch(prefix, "meta"): meta,
        ch(prefix, "resid.proj"): np.ascontiguousarray(view.proj, np.float32),
        ch(prefix, "resid.norm"): np.ascontiguousarray(view.norm, np.float32),
        ch(prefix, "resid.delta"): np.ascontiguousarray(view.delta, np.float32),
        ch(prefix, "resid.mask"): np.ascontiguousarray(view.mask, np.uint8),
    }
    if view.attn is not None:
        out[ch(prefix, "attn")] = np.ascontiguousarray(view.attn, np.float32)
    for name, s in view.probes.items():
        out[ch(prefix, f"probe.{name}")] = np.ascontiguousarray(s, np.float32)
    return out


def validate(payload: dict[str, Any], prefix: str, *, L: int, T: int, H: int) -> list[str]:
    """Check a payload against the contract shapes/dtypes. Returns a list of problems (empty = ok)."""
    problems: list[str] = []

    def want(name: str, dtype: Any, shape: tuple[int, ...], allow_nan: bool = False) -> None:
        key = ch(prefix, name)
        v = payload.get(key)
        if v is None:
            return
        if not isinstance(v, np.ndarray):
            problems.append(f"{key}: expected ndarray, got {type(v).__name__}")
        elif v.dtype != np.dtype(dtype) or v.shape != shape:
            problems.append(f"{key}: expected {np.dtype(dtype)}{list(shape)}, got {v.dtype}{list(v.shape)}")
        elif v.dtype.kind == "f" and not (np.isfinite(v) | (np.isnan(v) & allow_nan)).all():
            problems.append(f"{key}: non-finite values")

    want("resid.proj", np.float32, (L + 1, T, 3))
    want("resid.norm", np.float32, (L + 1, T))
    want("resid.delta", np.float32, (L, 2, T))
    want("resid.mask", np.uint8, (L + 1, T))
    want("attn", np.float32, (L, H, T, T))
    for key in payload:
        if key.startswith(ch(prefix, "probe.")) and key not in (ch(prefix, "probe.index"), ch(prefix, "probe.info")):
            name = key[len(ch(prefix, "probe.")):]
            want(f"probe.{name}", np.float32, (L + 1,) if name.endswith(".acc") else (L + 1, T), allow_nan=True)
            v = payload[key]
            if isinstance(v, np.ndarray) and not name.endswith(".acc") and np.nanmax(np.abs(v), initial=0.0) > 1.0 + 1e-5:
                problems.append(f"{key}: scores must lie in [-1, 1]")
    meta = payload.get(ch(prefix, "meta"))
    if meta is not None:
        if len(meta.get("layers", [])) != L + 1:
            problems.append(f"meta.layers: expected {L + 1} labels")
        if len(meta.get("tokens", [])) != T:
            problems.append(f"meta.tokens: expected {T} tokens")
        for k in ("model", "d_model", "sample", "lens"):
            if k not in meta:
                problems.append(f"meta.{k} missing")
        for k in ("model", "short_name", "checkpoint"):
            if k in meta and not isinstance(meta[k], str):
                problems.append(f"meta.{k}: expected a string")
        if isinstance(meta.get("model"), str) and isinstance(meta.get("checkpoint"), str) and meta["checkpoint"]                 and meta["checkpoint"] in meta["model"]:
            problems.append("meta.model must not contain the checkpoint path (use meta.checkpoint)")
        pj = meta.get("proj")
        if pj is not None:
            ev = pj.get("explained_variance") if isinstance(pj, dict) else None
            if not (isinstance(pj, dict) and isinstance(pj.get("normalized"), bool) and isinstance(pj.get("basis"), str)
                    and isinstance(ev, list) and len(ev) == 3 and all(isinstance(x, (int, float)) for x in ev)):
                problems.append("meta.proj: expected {normalized: bool, basis: str, explained_variance: number[3]}")
        if not all(isinstance(t, dict) and isinstance(t.get("label"), str) for t in meta.get("tokens", [])):
            problems.append("meta.tokens: every token needs a string label")
    ro = payload.get(ch(prefix, "lens.readout"))
    if ro is not None:
        if not {"layer", "token", "title", "items"} <= set(ro):
            problems.append("lens.readout: needs layer, token, title, items")
        elif not all(isinstance(i.get("label"), str) and isinstance(i.get("value"), (int, float)) and np.isfinite(i["value"])
                     for i in ro["items"]):
            problems.append("lens.readout.items: each needs a string label and a finite number value")
    return problems
