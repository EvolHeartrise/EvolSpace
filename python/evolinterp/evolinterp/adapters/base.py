"""Common model-adapter interface.

An adapter wraps one model + its dataset and exposes an *instrumented*
forward that records, for a batch of samples:

* the residual stream entering every block and after the last one
  (``resid``: [B, L+1, T, d] — layer 0 = embeddings, layer l+1 = output of block l),
* the norms of each block's attention and MLP writes,
* explicit attention patterns softmax(QK^T/sqrt(dh)),
* the model outputs (verified against the model's own forward).

Everything the interp contract publishes is derived from these captures plus
adapter-specific token labels, probe targets and a logit-lens readout.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

from ..interventions import Interventions


@dataclass
class TokenInfo:
    label: str
    group: str
    detail: str | None = None

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"label": self.label, "group": self.group}
        if self.detail:
            d["detail"] = self.detail
        return d


@dataclass
class Capture:
    """Instrumented-forward results for a batch (numpy, float32)."""

    resid: np.ndarray                 # [B, L+1, T, d]
    attn_write: np.ndarray            # [B, L, T]  ||attention write||
    mlp_write: np.ndarray             # [B, L, T]  ||MLP write||
    attn: np.ndarray | None           # [B, L, H, T, T] (query x key); uncomputed query rows are 0
    outputs: dict[str, np.ndarray] = field(default_factory=dict)

    def __len__(self) -> int:
        return self.resid.shape[0]

    def sample(self, b: int) -> "Capture":
        return Capture(self.resid[b:b + 1], self.attn_write[b:b + 1], self.mlp_write[b:b + 1],
                       None if self.attn is None else self.attn[b:b + 1],
                       {k: v[b:b + 1] for k, v in self.outputs.items()})


@dataclass
class ProbeTarget:
    """Per-token classification target derived from the observations."""

    name: str
    classes: list[str]
    labels: np.ndarray                # [N, T] int16, -1 = not applicable
    description: str


class Adapter(ABC):
    """Model + dataset + instrumentation. Subclasses set the attributes below in __init__."""

    kind: str                         # "bsrl" | "toy"
    model_id: str                     # cache-dir key (stable for a given checkpoint/config)
    model_name: str                   # human label for P.meta.model (never a filesystem path)
    short_name: str = ""              # compact label for P.meta.short_name (e.g. "BSRL bend7 · upd 7000")
    checkpoint: str | None = None     # filesystem path -> P.meta.checkpoint
    n_layers: int                     # L (blocks)
    n_heads: int
    d_model: int
    n_tokens: int                     # T
    lens_kind: str = "logit-lens"
    lens_description: str = ""

    # ---------------------------------------------------------------- structure

    @property
    def layer_labels(self) -> list[str]:
        return ["embed"] + [f"b{i}" for i in range(self.n_layers)]

    @abstractmethod
    def num_samples(self) -> int: ...

    @abstractmethod
    def valid(self, idx: Sequence[int] | np.ndarray) -> np.ndarray:
        """[B, T] bool: token exists (not padding) in these samples."""

    def computed(self) -> np.ndarray:
        """[L+1, T] bool: positions the forward actually computes (default: all)."""
        return np.ones((self.n_layers + 1, self.n_tokens), bool)

    def mask(self, idx: Sequence[int] | np.ndarray) -> np.ndarray:
        """[B, L+1, T] bool: residual exists and is meaningful."""
        return self.computed()[None] & self.valid(idx)[:, None, :]

    # ---------------------------------------------------------------- forwards

    @abstractmethod
    def run(self, idx: Sequence[int] | np.ndarray, interventions: Interventions | None = None,
            want_attn: bool = True) -> Capture:
        """Instrumented forward on dataset rows ``idx``."""

    @abstractmethod
    def reference(self, idx: Sequence[int] | np.ndarray) -> dict[str, Any]:
        """The model's own (uninstrumented) forward, for verification. Returns outputs
        and, where hooks allow, intermediate residuals ``resid`` [B, L+1, T, d] (NaN = not observed)."""

    def verify(self, idx: Sequence[int] | np.ndarray) -> dict[str, float]:
        """Max |instrumented - reference| per output (and intermediate residuals when available)."""
        cap = self.run(idx, want_attn=False)
        ref = self.reference(idx)
        out: dict[str, float] = {}
        for k, v in ref.items():
            if k == "resid":
                m = ~np.isnan(v)
                out["resid"] = float(np.max(np.abs(cap.resid[m] - v[m]))) if m.any() else float("nan")
                out["resid_rel"] = out["resid"] / max(float(np.max(np.abs(v[m]))), 1e-12) if m.any() else float("nan")
            elif k in cap.outputs:
                out[k] = float(np.max(np.abs(cap.outputs[k] - v)))
        return out

    # ---------------------------------------------------------------- labels

    @abstractmethod
    def tokens(self, i: int) -> list[TokenInfo]: ...

    @abstractmethod
    def sample_label(self, i: int) -> str: ...

    def token_key(self, i: int, t: int) -> str:
        """Coarse token description for aggregations (SAE feature labels): label minus numbers."""
        lab = self.tokens(i)[t].label
        return re.sub(r"\s+", " ", re.sub(r"[-+]?\d*\.?\d+s?", "", lab)).strip() or lab

    @abstractmethod
    def probe_targets(self) -> dict[str, ProbeTarget]: ...

    def targets(self) -> dict[str, ProbeTarget]:
        """Cached probe_targets()."""
        if getattr(self, "_targets_cache", None) is None:
            self._targets_cache = self.probe_targets()
        return self._targets_cache

    def probe_labels_for(self, i: int) -> dict[str, np.ndarray]:
        """Per-probe true labels [T] for sample i (-1 = n/a)."""
        return {k: v.labels[i] for k, v in self.targets().items()}

    # ---------------------------------------------------------------- lens

    @abstractmethod
    def lens(self, i: int, cap: Capture, layer: int, token: int, *, probes: Any = None,
             clean: Capture | None = None) -> dict[str, Any]:
        """P.lens.readout for one sample capture (B=1): {layer, token, title, items:[{label, value}]}."""

    # ---------------------------------------------------------------- misc

    def fingerprint(self) -> str:
        return self.model_id

    def describe(self) -> dict[str, Any]:
        return {"kind": self.kind, "model": self.model_name, "short_name": self.short_name or self.model_name,
                "checkpoint": self.checkpoint,
                "layers": self.n_layers, "heads": self.n_heads, "d_model": self.d_model,
                "tokens": self.n_tokens, "samples": self.num_samples()}


def as_index(idx: Sequence[int] | np.ndarray | int | slice, n: int) -> np.ndarray:
    if isinstance(idx, slice):
        return np.arange(n)[idx]
    if isinstance(idx, (int, np.integer)):
        return np.array([int(idx)])
    return np.asarray(idx, dtype=np.int64).reshape(-1)


def entropy(p: np.ndarray, axis: int = -1) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return -np.nansum(np.where(p > 0, p * np.log(p), 0.0), axis=axis)
