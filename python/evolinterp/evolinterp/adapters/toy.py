"""Toy transformer testbed, trained in seconds on a synthetic set-reasoning task.

Task ("red-majority shape"): a sequence is [CLS] + 4..11 items + padding, each
item a (colour, shape) pair, colour in {red, blue}, shape in {circle, square,
triangle, star}. The answer is the most frequent shape among the RED items
(sequences with no red item or a tie are rejected). Like BeatSaberRL there is no
positional encoding: the model must filter by colour and count by shape —
attention to red keys plus an MLP decode, which gives probes and the logit lens
something real to find.

The model is a small pre-LN transformer whose own forward uses fused
``F.scaled_dot_product_attention``; the adapter re-implements it explicitly to
capture the residual stream / attention and is verified against it.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from ..interventions import Interventions
from ..paths import data_dir
from .base import Adapter, Capture, ProbeTarget, TokenInfo, as_index, entropy

COLORS = ("red", "blue")
SHAPES = ("circle", "square", "triangle", "star")
PAD, CLS = 0, 1
N_ITEM_IDS = len(COLORS) * len(SHAPES)
VOCAB = 2 + N_ITEM_IDS
MASK_BIAS = -1e4


def item_id(color: int, shape: int) -> int:
    return 2 + color * len(SHAPES) + shape


def decode_id(tok: int) -> tuple[int, int] | None:
    if tok < 2:
        return None
    return (tok - 2) // len(SHAPES), (tok - 2) % len(SHAPES)


@dataclass(frozen=True)
class ToyConfig:
    seq_len: int = 12
    d_model: int = 64
    n_heads: int = 4
    n_layers: int = 3
    d_mlp: int = 256
    min_items: int = 4
    train_steps: int = 200
    batch: int = 256
    lr: float = 3e-3
    seed: int = 0
    n_eval: int = 1024           # the adapter's dataset (fixed seed)

    def key(self) -> str:
        return hashlib.sha1(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()[:8]


def make_task(n: int, cfg: ToyConfig, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """-> ids [n, T] int64, answers [n] int64."""
    T = cfg.seq_len
    ids = np.zeros((n, T), np.int64)
    ans = np.zeros(n, np.int64)
    k = 0
    while k < n:
        m = int(rng.integers(cfg.min_items, T))  # items occupy positions 1..m
        col = rng.integers(0, 2, m)
        shp = rng.integers(0, len(SHAPES), m)
        red = shp[col == 0]
        if red.size == 0:
            continue
        counts = np.bincount(red, minlength=len(SHAPES))
        if (counts == counts.max()).sum() > 1:
            continue
        ids[k, 0] = CLS
        ids[k, 1:m + 1] = 2 + col * len(SHAPES) + shp
        ans[k] = int(counts.argmax())
        k += 1
    return ids, ans


class ToyBlock(nn.Module):
    def __init__(self, d: int, n_heads: int, d_mlp: int):
        super().__init__()
        self.ln1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.out = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d)
        self.mlp = nn.Sequential(nn.Linear(d, d_mlp), nn.GELU(), nn.Linear(d_mlp, d))
        self.n_heads = n_heads

    def forward(self, x: torch.Tensor, bias: torch.Tensor) -> torch.Tensor:
        B, T, d = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(d, dim=-1)
        sh = lambda t: t.view(B, T, self.n_heads, d // self.n_heads).transpose(1, 2)  # noqa: E731
        a = F.scaled_dot_product_attention(sh(q), sh(k), sh(v), attn_mask=bias[:, None, None, :])
        x = x + self.out(a.transpose(1, 2).reshape(B, T, d))
        return x + self.mlp(self.ln2(x))


class ToyTransformer(nn.Module):
    def __init__(self, cfg: ToyConfig):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Embedding(VOCAB, cfg.d_model)
        self.blocks = nn.ModuleList(ToyBlock(cfg.d_model, cfg.n_heads, cfg.d_mlp) for _ in range(cfg.n_layers))
        self.ln_f = nn.LayerNorm(cfg.d_model)
        self.unembed = nn.Linear(cfg.d_model, len(SHAPES))

    def key_bias(self, ids: torch.Tensor) -> torch.Tensor:
        return (ids == PAD).float() * MASK_BIAS

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        """Logits [B, n_classes] read from the CLS token (position 0)."""
        x = self.embed(ids)
        bias = self.key_bias(ids)
        for b in self.blocks:
            x = b(x, bias)
        return self.unembed(self.ln_f(x[:, 0]))


def train_toy(cfg: ToyConfig, log: Any = print) -> tuple[ToyTransformer, dict[str, float]]:
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed + 1)
    model = ToyTransformer(cfg)
    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=cfg.lr, total_steps=cfg.train_steps, pct_start=0.1)
    t0 = time.time()
    model.train()
    for step in range(cfg.train_steps):
        ids, ans = make_task(cfg.batch, cfg, rng)
        loss = F.cross_entropy(model(torch.from_numpy(ids)), torch.from_numpy(ans))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sched.step()
        if log and (step + 1) % 200 == 0:
            log(f"[toy] step {step + 1}/{cfg.train_steps} loss {loss.item():.3f}")
    model.eval()
    ids, ans = make_task(2048, cfg, np.random.default_rng(cfg.seed + 99))
    with torch.no_grad():
        acc = (model(torch.from_numpy(ids)).argmax(-1).numpy() == ans).mean()
    stats = {"accuracy": float(acc), "seconds": time.time() - t0, "final_loss": float(loss.item())}
    if log:
        log(f"[toy] trained in {stats['seconds']:.1f}s, held-out accuracy {acc:.3f}")
    return model, stats


def load_or_train_toy(cfg: ToyConfig = ToyConfig(), cache: Path | None = None, log: Any = print,
                      force: bool = False) -> tuple[ToyTransformer, dict[str, Any]]:
    path = cache or (data_dir() / "toy" / f"toy-{cfg.key()}.pt")
    if path.exists() and not force:
        blob = torch.load(path, map_location="cpu", weights_only=True)
        model = ToyTransformer(cfg)
        model.load_state_dict(blob["state_dict"])
        return model.eval(), dict(blob.get("stats", {}), path=str(path))
    model, stats = train_toy(cfg, log)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dict": model.state_dict(), "config": asdict(cfg), "stats": stats}, path)
    return model, dict(stats, path=str(path))


class ToyAdapter(Adapter):
    kind = "toy"
    lens_kind = "logit-lens"

    def __init__(self, cfg: ToyConfig = ToyConfig(), *, checkpoint: str | None = None, log: Any = print):
        self.cfg = cfg
        self.model, self.train_stats = load_or_train_toy(cfg, Path(checkpoint) if checkpoint else None, log=log)
        self.checkpoint = self.train_stats.get("path")
        self.ids, self.answers = make_task(cfg.n_eval, cfg, np.random.default_rng(cfg.seed + 12345))
        self.n_layers, self.n_heads, self.d_model, self.n_tokens = cfg.n_layers, cfg.n_heads, cfg.d_model, cfg.seq_len
        self.model_id = f"toy-{cfg.key()}"
        self.model_name = f"toy red-majority transformer ({cfg.n_layers}L d{cfg.d_model} h{cfg.n_heads})"
        self.lens_description = ("final LayerNorm + unembedding applied to the residual at the selected layer/token "
                                 "(answer = most frequent shape among red items, read from CLS)")

    # ---------------------------------------------------------------- structure

    def num_samples(self) -> int:
        return len(self.ids)

    def valid(self, idx: Sequence[int] | np.ndarray) -> np.ndarray:
        return self.ids[as_index(idx, len(self.ids))] != PAD

    # ---------------------------------------------------------------- forwards

    @torch.no_grad()
    def run(self, idx: Sequence[int] | np.ndarray, interventions: Interventions | None = None,
            want_attn: bool = True) -> Capture:
        iv = interventions or Interventions()
        ids = torch.from_numpy(self.ids[as_index(idx, len(self.ids))])
        m = self.model
        B, T = ids.shape
        d, H = self.d_model, self.n_heads
        dh = d // H
        x = m.embed(ids)
        base_bias = m.key_bias(ids)[:, None, None, :].expand(B, H, T, T)  # [B,H,Tq,Tk]
        resid = [x]
        aw, mw, attns = [], [], []
        for li, blk in enumerate(m.blocks):
            q, k, v = blk.qkv(blk.ln1(x)).split(d, dim=-1)
            sh = lambda t: t.view(B, T, H, dh).transpose(1, 2)  # noqa: E731
            bias = base_bias
            blocked = iv.blocked(li)
            if blocked:
                bias = bias.clone()
                for qi, ki in blocked:
                    if qi is None:
                        bias[:, :, :, ki] = MASK_BIAS
                    else:
                        bias[:, :, qi, ki] = MASK_BIAS
            scores = sh(q) @ sh(k).transpose(-2, -1) / math.sqrt(dh) + bias
            att = torch.softmax(scores, dim=-1)
            o = att @ sh(v)                                              # [B,H,T,dh]
            hs = iv.head_scales(li, H)
            if hs is not None:
                o = o * torch.tensor(hs, dtype=o.dtype)[None, :, None, None]
            a_out = blk.out(o.transpose(1, 2).reshape(B, T, d)) * iv.scale("attn", li)
            x = x + a_out
            m_out = blk.mlp(blk.ln2(x)) * iv.scale("mlp", li)
            x = x + m_out
            resid.append(x)
            aw.append(a_out.norm(dim=-1))
            mw.append(m_out.norm(dim=-1))
            if want_attn:
                attns.append(att)
        logits = m.unembed(m.ln_f(x[:, 0]))
        return Capture(
            resid=torch.stack(resid, 1).numpy(),
            attn_write=torch.stack(aw, 1).numpy(),
            mlp_write=torch.stack(mw, 1).numpy(),
            attn=torch.stack(attns, 1).numpy() if want_attn else None,
            outputs={"logits": logits.numpy()},
        )

    @torch.no_grad()
    def reference(self, idx: Sequence[int] | np.ndarray) -> dict[str, Any]:
        ids = torch.from_numpy(self.ids[as_index(idx, len(self.ids))])
        outs: list[torch.Tensor] = []
        hooks = [b.register_forward_hook(lambda mod, inp, out: outs.append(out)) for b in self.model.blocks]
        try:
            logits = self.model(ids)
        finally:
            for h in hooks:
                h.remove()
        emb = self.model.embed(ids)
        return {"logits": logits.numpy(), "resid": torch.stack([emb] + outs, 1).numpy()}

    # ---------------------------------------------------------------- labels

    def _token(self, tok: int) -> TokenInfo:
        if tok == CLS:
            return TokenInfo("CLS", "cls", "readout token: the answer is read here")
        if tok == PAD:
            return TokenInfo("pad", "pad")
        c, s = decode_id(tok)  # type: ignore[misc]
        return TokenInfo(f"{COLORS[c]} {SHAPES[s]}", COLORS[c])

    def tokens(self, i: int) -> list[TokenInfo]:
        return [self._token(int(t)) for t in self.ids[i]]

    def sample_label(self, i: int) -> str:
        n = int((self.ids[i] >= 2).sum())
        return f"#{i}: {n} items, answer {SHAPES[self.answers[i]]}"

    def probe_targets(self) -> dict[str, ProbeTarget]:
        ids = self.ids
        item = ids >= 2
        color = np.where(item, (ids - 2) // len(SHAPES), -1).astype(np.int16)
        shape = np.where(item, (ids - 2) % len(SHAPES), -1).astype(np.int16)
        counted = np.where(item, ((color == 0) & (shape == self.answers[:, None])).astype(np.int16), -1).astype(np.int16)
        answer = np.full(ids.shape, -1, np.int16)
        answer[:, 0] = self.answers
        return {
            "color": ProbeTarget("color", list(COLORS), color, "item colour (item tokens)"),
            "shape": ProbeTarget("shape", list(SHAPES), shape, "item shape (item tokens)"),
            "counted": ProbeTarget("counted", ["no", "yes"], counted,
                                   "item is red AND has the answer shape (item tokens) — needs global context"),
            "answer": ProbeTarget("answer", list(SHAPES), answer, "the task answer (CLS token only)"),
        }

    # ---------------------------------------------------------------- lens

    @torch.no_grad()
    def decode(self, vec: np.ndarray) -> np.ndarray:
        """Final LN + unembed -> class probabilities for residual vectors [..., d]."""
        v = torch.from_numpy(np.ascontiguousarray(vec, dtype=np.float32))
        return torch.softmax(self.model.unembed(self.model.ln_f(v)), -1).numpy()

    def lens(self, i: int, cap: Capture, layer: int, token: int, *, probes: Any = None,
             clean: Capture | None = None) -> dict[str, Any]:
        toks = self.tokens(i)
        layer = int(np.clip(layer, 0, self.n_layers))
        token = int(np.clip(token, 0, self.n_tokens - 1))
        p = self.decode(cap.resid[0, layer, token])
        order = np.argsort(-p)
        items = [{"label": f"answer {SHAPES[c]}" + (" (true)" if c == self.answers[i] else ""), "value": float(p[c])}
                 for c in order]
        final = self.decode(cap.resid[0, self.n_layers, 0])
        items.append({"label": f"entropy (nats, max {math.log(len(SHAPES)):.2f})", "value": float(entropy(p))})
        items.append({"label": "agrees with final CLS answer", "value": float(order[0] == final.argmax())})
        if clean is not None:
            pc = self.decode(clean.resid[0, self.n_layers, 0])
            kl = float(np.sum(pc * (np.log(pc + 1e-12) - np.log(final + 1e-12))))
            items.append({"label": "KL(clean || intervened) at CLS output", "value": kl})
        if probes is not None:
            items.extend(probes.readout_items(cap.resid[0], layer, token, self.probe_labels_for(i)))
        if toks[token].group == "pad":
            title = f"logit lens @ {self.layer_labels[layer]} · pad (no residual)"
        else:
            title = f"logit lens @ {self.layer_labels[layer]} · {toks[token].label}"
        return {"layer": layer, "token": token, "title": title, "items": items}
