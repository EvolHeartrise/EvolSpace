"""Sparse autoencoders on one layer's residual stream.

Architecture (standard ReLU SAE): f = relu(W_enc (x - b_dec) + b_enc), x_hat = W_dec f + b_dec,
loss = ||x - x_hat||^2 / d + l1 * sum_i f_i ||W_dec[i]||  (decoder-norm-weighted L1, so the
penalty cannot be dodged by shrinking features). Inputs are scaled by one constant so the
mean squared norm is d. Trained with Adam on all meaningful residual vectors of the layer.

After training every feature gets an automatic description from the tokens that
activate it most (adapter.token_key: e.g. "red D 0.5-1s", "saber L").

Saved to data/interp/<model_id>/sae-<layer label>.pt.
"""

from __future__ import annotations

import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np
import torch
import torch.nn as nn


class SparseAutoencoder(nn.Module):
    def __init__(self, d: int, m: int, input_scale: float = 1.0):
        super().__init__()
        self.d, self.m = d, m
        g = torch.Generator().manual_seed(0)
        w = torch.randn(m, d, generator=g)
        w = w / w.norm(dim=1, keepdim=True) * 0.1
        self.W_dec = nn.Parameter(w.clone())
        self.W_enc = nn.Parameter(w.t().clone())
        self.b_enc = nn.Parameter(torch.zeros(m))
        self.b_dec = nn.Parameter(torch.zeros(d))
        self.register_buffer("input_scale", torch.tensor(float(input_scale)))

    def encode(self, x: torch.Tensor) -> torch.Tensor:
        return torch.relu((x * self.input_scale - self.b_dec) @ self.W_enc + self.b_enc)

    def decode(self, f: torch.Tensor) -> torch.Tensor:
        return (f @ self.W_dec + self.b_dec) / self.input_scale

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        f = self.encode(x)
        return self.decode(f), f


@dataclass
class SaeStats:
    mse_frac: float      # reconstruction MSE / input variance (fraction of variance unexplained)
    l0: float            # mean active features per vector
    dead_frac: float     # features that never fire on the eval set
    seconds: float


@torch.enable_grad()
def train_sae(X: np.ndarray, *, m: int, l1: float = 3e-3, steps: int = 3000, batch: int = 1024, lr: float = 1e-3,
              seed: int = 0, log: Callable[[str], None] | None = print) -> tuple[SparseAutoencoder, SaeStats]:
    """X [n, d] float -> trained SAE + stats (eval on a held-out 10%)."""
    t0 = time.time()
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    X = np.asarray(X, np.float32)
    perm = rng.permutation(len(X))
    n_eval = max(1, len(X) // 10)
    Xe, Xt = torch.from_numpy(X[perm[:n_eval]]), torch.from_numpy(X[perm[n_eval:]])
    d = X.shape[1]
    scale = float(np.sqrt(d / max(np.mean(np.sum(X.astype(np.float64) ** 2, 1)), 1e-12)))
    sae = SparseAutoencoder(d, m, scale)
    with torch.no_grad():
        sae.b_dec.copy_(Xt.mean(0) * scale)
    opt = torch.optim.Adam(sae.parameters(), lr=lr)
    for step in range(steps):
        xb = Xt[torch.randint(0, len(Xt), (min(batch, len(Xt)),))]
        x_hat, f = sae(xb)
        mse = ((x_hat - xb) * sae.input_scale).pow(2).sum(-1).mean() / d
        sparsity = (f * sae.W_dec.norm(dim=1)).sum(-1).mean()
        warm = min(1.0, (step + 1) / (0.05 * steps + 1))  # l1 warm-up
        loss = mse + warm * l1 * sparsity
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        if log and (step + 1) % max(1, steps // 5) == 0:
            l0 = (f > 0).float().sum(-1).mean().item()
            log(f"[sae] step {step + 1}/{steps} mse {mse.item():.4f} L0 {l0:.1f}")
    sae.eval()
    with torch.no_grad():
        x_hat, f = sae(Xe)
        var = ((Xe - Xe.mean(0)) ** 2).sum(-1).mean()
        mse_frac = float(((x_hat - Xe) ** 2).sum(-1).mean() / var)
        l0 = float((f > 0).float().sum(-1).mean())
        dead = float(((f > 0).sum(0) == 0).float().mean())
    stats = SaeStats(mse_frac, l0, dead, time.time() - t0)
    if log:
        log(f"[sae] done in {stats.seconds:.1f}s: unexplained variance {mse_frac:.3f}, L0 {l0:.1f}, dead {dead:.1%}")
    return sae, stats


@torch.no_grad()
def feature_summaries(sae: SparseAutoencoder, X: np.ndarray, keys: Sequence[str], *, topk: int = 40,
                      batch: int = 8192) -> list[dict[str, Any]]:
    """Per feature: firing frequency, max activation and the token kinds among its top activations."""
    acts = []
    for a in range(0, len(X), batch):
        acts.append(sae.encode(torch.from_numpy(np.asarray(X[a:a + batch], np.float32))).numpy())
    A = np.concatenate(acts) if acts else np.zeros((0, sae.m), np.float32)
    freq = (A > 0).mean(0) if len(A) else np.zeros(sae.m)
    out = []
    k = min(topk, len(A))
    for i in range(sae.m):
        col = A[:, i]
        if k == 0 or col.max() <= 0:
            out.append({"id": i, "freq": 0.0, "max": 0.0, "label": "dead", "top": []})
            continue
        top = np.argpartition(-col, k - 1)[:k]
        top = top[col[top] > 0]
        cnt = Counter(keys[j] for j in top).most_common(3)
        frac = [(key, c / len(top)) for key, c in cnt]
        label = ", ".join(f"{key} {f:.0%}" for key, f in frac[:2])
        out.append({"id": i, "freq": float(freq[i]), "max": float(col.max()), "label": label,
                    "top": [[key, round(f, 3)] for key, f in frac]})
    return out


def sae_path(model_dir: Path, layer_label: str) -> Path:
    return model_dir / f"sae-{layer_label}.pt"


def save_sae(path: Path, sae: SparseAutoencoder, meta: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": sae.state_dict(), "d": sae.d, "m": sae.m, "meta": meta}, path)


def load_sae(path: Path) -> tuple[SparseAutoencoder, dict[str, Any]]:
    blob = torch.load(path, map_location="cpu", weights_only=True)
    sae = SparseAutoencoder(blob["d"], blob["m"])
    sae.load_state_dict(blob["state_dict"])
    return sae.eval(), blob["meta"]


@torch.no_grad()
def top_features(sae: SparseAutoencoder, vec: np.ndarray, k: int = 8) -> list[tuple[int, float]]:
    f = sae.encode(torch.from_numpy(np.asarray(vec, np.float32)[None]))[0].numpy()
    idx = np.argsort(-f)[:k]
    return [(int(i), float(f[i])) for i in idx if f[i] > 0]
