"""Dataset-wide activation capture: the shared PCA basis and the per-sample
contract arrays (proj / norm / delta / mask) for every dataset sample.

Each residual vector is first divided by its RMS (``r / sqrt(mean(r**2))``): the
model reads the stream through pre-LayerNorm anyway, and residual norms grow ~7x
through depth, so without this the basis is dominated by late layers and early
layers collapse onto the centre. The PCA basis is then fit on ALL meaningful
normalized residual vectors of the dataset (every layer, every computed
non-padding token) and shared across layers, so a token's trajectory through
depth is comparable in one 3D frame. Coordinates are centred on the global mean
(of the normalized vectors) and scaled by one scalar so the 99th-percentile point
sits at radius 1. Magnitudes are not lost: P.resid.norm carries the raw L2 norms.

Cached at data/interp/<model_id>/capture.npz; the full residual tensor is only
kept in memory (float16) for probe / SAE training.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .adapters.base import Adapter
from .paths import data_dir

#: capture.npz format. 2: projection of RMS-normalized residuals (v1 projected raw residuals;
#: v1 files are ignored and recaptured).
CACHE_VERSION = 2
#: Projection mode written by this version (also checked on load).
PROJ_NORMALIZED = True
_EPS = 1e-12


def normalize_rows(resid: np.ndarray) -> np.ndarray:
    """[..., d] -> each vector divided by its RMS (zero vectors stay zero), float32."""
    r = np.asarray(resid, dtype=np.float32)
    rms = np.sqrt(np.mean(np.square(r, dtype=np.float32), axis=-1, keepdims=True))
    return np.divide(r, rms, out=np.zeros_like(r), where=rms > _EPS)


def model_dir(adapter: Adapter) -> Path:
    p = data_dir() / adapter.model_id
    p.mkdir(parents=True, exist_ok=True)
    return p


@dataclass
class Projector:
    mean: np.ndarray            # (d,)
    basis: np.ndarray           # (3, d) orthonormal rows (top principal directions)
    scale: float                # multiply projected coords by this
    explained: np.ndarray       # (3,) explained-variance ratio of each component
    normalized: bool = PROJ_NORMALIZED   # residuals are RMS-normalized before centring/projection

    def project(self, resid: np.ndarray) -> np.ndarray:
        """[..., d] -> [..., 3] float32."""
        r = normalize_rows(resid) if self.normalized else np.asarray(resid, dtype=np.float32)
        return ((r - self.mean) @ self.basis.T * self.scale).astype(np.float32)

    def describe(self) -> dict[str, Any]:
        """P.meta.proj"""
        return {"normalized": bool(self.normalized), "basis": "pca",
                "explained_variance": [round(float(x), 6) for x in np.asarray(self.explained).reshape(-1)[:3]]}


@dataclass
class DatasetCache:
    model_id: str
    layer_labels: list[str]
    projector: Projector
    proj: np.ndarray            # (N, L+1, T, 3) f32
    norm: np.ndarray            # (N, L+1, T) f32
    delta: np.ndarray           # (N, L, 2, T) f32  [attn, mlp] write norms
    mask: np.ndarray            # (N, L+1, T) u8
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def n_samples(self) -> int:
        return self.proj.shape[0]

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        np.savez_compressed(
            tmp, version=CACHE_VERSION, model_id=self.model_id, layer_labels=np.array(self.layer_labels),
            pca_mean=self.projector.mean, pca_basis=self.projector.basis, pca_scale=self.projector.scale,
            pca_explained=self.projector.explained, pca_normalized=self.projector.normalized, proj=self.proj, norm=self.norm, delta=self.delta,
            mask=self.mask, meta=json.dumps(self.meta))
        tmp.replace(path)

    @classmethod
    def load(cls, path: Path, model_id: str | None = None) -> "DatasetCache | None":
        if not path.exists():
            return None
        # `with`: an open NpzFile keeps the file locked on Windows (blocks `capture --force`'s atomic replace)
        with np.load(path, allow_pickle=False) as z:
            if int(z["version"]) != CACHE_VERSION or (model_id is not None and str(z["model_id"]) != model_id):
                return None
            if "pca_normalized" not in z.files or bool(z["pca_normalized"]) != PROJ_NORMALIZED:
                return None
            proj = Projector(z["pca_mean"], z["pca_basis"], float(z["pca_scale"]), z["pca_explained"],
                             bool(z["pca_normalized"]))
            return cls(str(z["model_id"]), [str(x) for x in z["layer_labels"]], proj, z["proj"], z["norm"],
                       z["delta"], z["mask"], json.loads(str(z["meta"])))


def capture_dataset(adapter: Adapter, *, batch: int = 256, keep_resid: bool = True,
                    log: Callable[[str], None] | None = print) -> tuple[DatasetCache, np.ndarray | None]:
    """Run the instrumented forward over the whole dataset.

    Returns the cache and (if keep_resid) the residuals as float16 [N, L+1, T, d]."""
    N, L, T, d = adapter.num_samples(), adapter.n_layers, adapter.n_tokens, adapter.d_model
    t0 = time.time()
    resid_all = np.zeros((N, L + 1, T, d), np.float16) if keep_resid else None
    norm = np.zeros((N, L + 1, T), np.float32)
    delta = np.zeros((N, L, 2, T), np.float32)
    mask = np.zeros((N, L + 1, T), np.uint8)
    s1 = np.zeros(d, np.float64)
    s2 = np.zeros((d, d), np.float64)
    count = 0
    for a in range(0, N, batch):
        ix = np.arange(a, min(N, a + batch))
        cap = adapter.run(ix, want_attn=False)
        m = adapter.mask(ix)
        mask[ix] = m
        norm[ix] = np.linalg.norm(cap.resid, axis=-1) * m
        delta[ix, :, 0] = cap.attn_write
        delta[ix, :, 1] = cap.mlp_write
        rows = normalize_rows(cap.resid[m]).astype(np.float64)
        s1 += rows.sum(0)
        s2 += rows.T @ rows
        count += rows.shape[0]
        if resid_all is not None:
            resid_all[ix] = cap.resid
        if log and (a // batch) % 4 == 0:
            log(f"[capture] {min(N, a + batch)}/{N} samples")
    mean = s1 / max(count, 1)
    cov = s2 / max(count, 1) - np.outer(mean, mean)
    evals, evecs = np.linalg.eigh(cov)
    order = np.argsort(evals)[::-1][:3]
    basis = evecs[:, order].T
    basis *= np.sign(basis[np.arange(3), np.argmax(np.abs(basis), axis=1)])[:, None]  # deterministic signs
    explained = evals[order] / max(evals.sum(), 1e-12)
    projector = Projector(mean.astype(np.float32), basis.astype(np.float32), 1.0, explained.astype(np.float32),
                          PROJ_NORMALIZED)
    # projection (second pass over the stored residuals, or a re-run without them)
    proj = np.zeros((N, L + 1, T, 3), np.float32)
    for a in range(0, N, batch):
        ix = np.arange(a, min(N, a + batch))
        r = resid_all[ix].astype(np.float32) if resid_all is not None else adapter.run(ix, want_attn=False).resid
        proj[ix] = projector.project(r)
    radii = np.linalg.norm(proj, axis=-1)[mask.astype(bool)]
    scale = 1.0 / max(float(np.percentile(radii, 99)), 1e-6) if radii.size else 1.0
    projector.scale = scale
    proj *= scale
    proj *= mask[..., None]
    meta = {"seconds": round(time.time() - t0, 2), "rows": int(count), "explained": [float(x) for x in explained],
            "proj": projector.describe(),
            "describe": _jsonable(adapter.describe())}
    if log:
        log(f"[capture] {N} samples, {count} residual vectors in {meta['seconds']}s; "
            f"PCA (RMS-normalized) explained {', '.join(f'{x:.1%}' for x in explained)}")
    cache = DatasetCache(adapter.model_id, adapter.layer_labels, projector, proj, norm, delta, mask, meta)
    return cache, resid_all


def load_or_capture(adapter: Adapter, *, force: bool = False, keep_resid: bool = False,
                    log: Callable[[str], None] | None = print) -> tuple[DatasetCache, np.ndarray | None]:
    path = model_dir(adapter) / "capture.npz"
    if not force and not keep_resid:
        cache = DatasetCache.load(path, adapter.model_id)
        if cache is not None and cache.n_samples == adapter.num_samples():
            if log:
                log(f"[capture] loaded {path}")
            return cache, None
    cache, resid = capture_dataset(adapter, keep_resid=keep_resid, log=log)
    cache.save(path)
    if log:
        log(f"[capture] saved {path}")
    return cache, resid


def _jsonable(v: Any) -> Any:
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist() if v.size <= 64 else f"<array {v.shape}>"
    return v
