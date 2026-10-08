"""Per-layer linear probes (scikit-learn logistic regression) on residual-stream vectors.

For every probe target (adapter.probe_targets: per-token labels derived from the
observations, -1 = not applicable) and every layer, a standardized multinomial
logistic regression is trained on the tokens where the label applies and the
residual exists. Train/test split is by SAMPLE (every 5th sample is held out),
so tokens of one observation never leak across the split.

Published score (contract P.probe.<name> [L+1, T]): a signed confidence in the
TRUE class, ``2 * P(true class) - 1`` in [-1, 1] (+1 = confidently right, 0 =
P(true) 0.5, -1 = confidently wrong); NaN where the probe does not apply (token
kind, padding, uncomputed position). Signed + NaN is what the consumers expect:
resid-flow colours probe scores with a diverging ramp, and both it and heatmap
draw non-finite values as neutral "n/a". P.probe.<name>.acc [L+1] is held-out
accuracy per layer (NaN = no probe at that layer). ``ProbeSet.scores(...,
signed=False)`` returns raw P(true) for analysis.

Weights are stored as plain arrays (probes.npz) and evaluated with numpy.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .adapters.base import Adapter, ProbeTarget

PROBES_VERSION = 1


@dataclass
class LayerProbe:
    mean: np.ndarray          # (d,)
    std: np.ndarray           # (d,)
    coef: np.ndarray          # (K, d) K = present classes (binary: (1, d))
    intercept: np.ndarray     # (K,)
    classes: np.ndarray       # (K or 2,) indices into the target's class list
    acc: float
    n_train: int
    n_test: int

    def proba(self, x: np.ndarray) -> np.ndarray:
        """x [n, d] -> probabilities over self.classes [n, len(classes)]."""
        z = (np.asarray(x, np.float32) - self.mean) / self.std
        logits = z @ self.coef.T + self.intercept
        if self.coef.shape[0] == 1:  # binary sklearn layout
            p1 = 0.5 * (1.0 + np.tanh(0.5 * logits[:, 0]))  # stable sigmoid
            return np.stack([1.0 - p1, p1], axis=1)
        logits = logits - logits.max(1, keepdims=True)
        e = np.exp(logits)
        return e / e.sum(1, keepdims=True)


@dataclass
class Probe:
    name: str
    classes: list[str]
    description: str
    layers: list[LayerProbe | None]
    baseline: float           # majority-class accuracy on the test split

    @property
    def acc(self) -> np.ndarray:
        """[L+1] held-out accuracy per layer, NaN where there is no probe."""
        return np.array([np.nan if p is None else p.acc for p in self.layers], np.float32)


@dataclass
class ProbeSet:
    probes: dict[str, Probe] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def names(self) -> list[str]:
        return list(self.probes)

    def scores(self, resid: np.ndarray, labels: dict[str, np.ndarray], mask: np.ndarray, *,
               signed: bool = True) -> dict[str, np.ndarray]:
        """One sample: resid [L+1, T, d], labels name -> [T], mask [L+1, T] -> name -> [L+1, T]:
        2 * P(true) - 1 (``signed``, the published form) or P(true); NaN = not applicable."""
        out = {}
        Lp1, T = mask.shape
        for name, pr in self.probes.items():
            lab = labels.get(name)
            s = np.full((Lp1, T), np.nan, np.float32)
            if lab is None:
                out[name] = s
                continue
            for li, lp in enumerate(pr.layers):
                if lp is None:
                    continue
                toks = np.where((lab >= 0) & mask[li].astype(bool))[0]
                if toks.size == 0:
                    continue
                p = lp.proba(resid[li, toks])
                col = {int(c): j for j, c in enumerate(lp.classes)}
                s[li, toks] = [p[k, col[int(lab[t])]] if int(lab[t]) in col else 0.0 for k, t in enumerate(toks)]
            out[name] = (2.0 * s - 1.0) if signed else s
        return out

    def predict(self, name: str, layer: int, vec: np.ndarray) -> tuple[np.ndarray, list[str]] | None:
        """Full-class-list probabilities for one residual vector, or None if no probe there."""
        pr = self.probes.get(name)
        if pr is None or not 0 <= layer < len(pr.layers) or pr.layers[layer] is None:
            return None
        lp = pr.layers[layer]
        p = lp.proba(vec[None])[0]
        full = np.zeros(len(pr.classes), np.float32)
        full[lp.classes.astype(int)] = p
        return full, pr.classes

    def readout_items(self, resid: np.ndarray, layer: int, token: int, labels: dict[str, np.ndarray]) -> list[dict[str, Any]]:
        """Lens-readout lines for one token: each applicable probe's prediction at this layer."""
        items = []
        for name, pr in self.probes.items():
            lab = labels.get(name)
            if lab is None or lab[token] < 0:
                continue
            res = self.predict(name, layer, resid[layer, token])
            if res is None:
                continue
            p, classes = res
            k = int(np.argmax(p))
            truth = int(lab[token])
            mark = "" if k == truth else f" (true {classes[truth]})"
            items.append({"label": f"probe {name}: {classes[k]}{mark}", "value": float(p[k])})
        return items

    def index(self) -> list[str]:
        return self.names

    def info(self) -> dict[str, Any]:
        return {
            "score": ("2*P(true class)-1 in [-1,1] at each layer/token (+1 confidently right, "
                      "-1 confidently wrong); NaN = not applicable"),
            "split": "held-out by sample (every 5th sample)",
            "probes": [{"name": n, "classes": p.classes, "description": p.description,
                        "acc": [None if not np.isfinite(a) else round(float(a), 4) for a in p.acc],
                        "baseline": round(p.baseline, 4)}
                       for n, p in self.probes.items()],
        }

    # ------------------------------------------------------------------ io

    def save(self, path: Path) -> None:
        arrays: dict[str, Any] = {"version": PROBES_VERSION}
        meta = {"meta": self.meta, "probes": {}}
        for name, pr in self.probes.items():
            meta["probes"][name] = {"classes": pr.classes, "description": pr.description, "baseline": pr.baseline,
                                    "layers": [None if lp is None else {"acc": lp.acc, "n_train": lp.n_train, "n_test": lp.n_test}
                                               for lp in pr.layers]}
            for li, lp in enumerate(pr.layers):
                if lp is None:
                    continue
                for k in ("mean", "std", "coef", "intercept", "classes"):
                    arrays[f"{name}/{li}/{k}"] = getattr(lp, k)
        arrays["meta"] = json.dumps(meta)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        np.savez_compressed(tmp, **arrays)
        tmp.replace(path)

    @classmethod
    def load(cls, path: Path) -> "ProbeSet | None":
        if not path.exists():
            return None
        # `with`: an open NpzFile keeps the file locked on Windows (blocks a re-train's atomic replace)
        with np.load(path, allow_pickle=False) as z:
            if int(z["version"]) != PROBES_VERSION:
                return None
            meta = json.loads(str(z["meta"]))
            ps = cls(meta=meta.get("meta", {}))
            for name, pm in meta["probes"].items():
                layers: list[LayerProbe | None] = []
                for li, lm in enumerate(pm["layers"]):
                    if lm is None:
                        layers.append(None)
                        continue
                    g = lambda k: z[f"{name}/{li}/{k}"]  # noqa: E731
                    layers.append(LayerProbe(g("mean"), g("std"), g("coef"), g("intercept"), g("classes"),
                                             float(lm["acc"]), int(lm["n_train"]), int(lm["n_test"])))
                ps.probes[name] = Probe(name, list(pm["classes"]), pm["description"], layers, float(pm["baseline"]))
        return ps


def train_probes(adapter: Adapter, resid: np.ndarray, mask: np.ndarray, *, targets: dict[str, ProbeTarget] | None = None,
                 max_train: int = 5000, max_test: int = 4000, C: float = 0.5, seed: int = 0,
                 log: Callable[[str], None] | None = print) -> ProbeSet:
    """resid [N, L+1, T, d] (float16 ok), mask [N, L+1, T] -> trained ProbeSet."""
    import warnings

    from sklearn.exceptions import ConvergenceWarning
    from sklearn.linear_model import LogisticRegression

    targets = targets or adapter.targets()
    N, Lp1, T, d = resid.shape
    rng = np.random.default_rng(seed)
    test_sample = (np.arange(N) % 5) == 0
    ps = ProbeSet(meta={"model_id": adapter.model_id, "C": C, "max_train": max_train})
    t0 = time.time()
    for name, tgt in targets.items():
        layers: list[LayerProbe | None] = []
        baseline = 0.0
        for li in range(Lp1):
            ok = (tgt.labels >= 0) & mask[:, li].astype(bool)
            si, ti = np.nonzero(ok)
            if si.size == 0:
                layers.append(None)
                continue
            y = tgt.labels[si, ti].astype(np.int64)
            tr = np.where(~test_sample[si])[0]
            te = np.where(test_sample[si])[0]
            if tr.size > max_train:
                tr = rng.choice(tr, max_train, replace=False)
            if te.size > max_test:
                te = rng.choice(te, max_test, replace=False)
            if len(np.unique(y[tr])) < 2 or te.size == 0:
                layers.append(None)
                continue
            X = resid[si, li, ti].astype(np.float32)
            mean = X[tr].mean(0)
            std = X[tr].std(0) + 1e-6
            clf = LogisticRegression(C=C, max_iter=300, tol=1e-3)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", ConvergenceWarning)
                clf.fit((X[tr] - mean) / std, y[tr])
            acc = float((clf.predict((X[te] - mean) / std) == y[te]).mean())
            counts = np.bincount(y[te], minlength=len(tgt.classes))
            baseline = float(counts.max() / max(counts.sum(), 1))
            layers.append(LayerProbe(mean.astype(np.float32), std.astype(np.float32), clf.coef_.astype(np.float32),
                                     clf.intercept_.astype(np.float32), clf.classes_.astype(np.int16), acc,
                                     int(tr.size), int(te.size)))
        pr = Probe(name, list(tgt.classes), tgt.description, layers, baseline)
        ps.probes[name] = pr
        if log:
            log(f"[probe] {name:8s} baseline {baseline:.2f} | acc by layer: "
                + " ".join("  -  " if not np.isfinite(a) else f"{a:.2f}" for a in pr.acc))
    ps.meta["seconds"] = round(time.time() - t0, 1)
    return ps


def format_table(ps: ProbeSet, layer_labels: list[str]) -> str:
    head = "probe     base  " + " ".join(f"{lab:>5s}" for lab in layer_labels)
    rows = [head]
    for name, pr in ps.probes.items():
        rows.append(f"{name:9s} {pr.baseline:4.2f}  " + " ".join("    -" if not np.isfinite(a) else f"{a:5.2f}" for a in pr.acc))
    return "\n".join(rows)
