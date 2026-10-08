"""BeatSaberRL NotePolicy adapter.

The policy code comes from an export of the BeatSaberRL repo's ``exp/bend7``
branch (``python -m evolinterp setup-bsrl`` runs ``git archive``; the BSRL
working tree is never touched). ``beat_arena_env/__init__`` imports the Rust
sim, so the package is stubbed and only ``beat_arena_env.constants`` (pure
Python) is loaded — no gymnasium, Rust or CUDA needed.

Model (from the checkpoint arch): 29 tokens = [saber_L, saber_R, torso, leg_L,
leg_R] + 24 entity slots (notes / bombs / walls, nearest first; padding masked by
the note mask), pre-LN blocks without positional encoding. The LAST block only
computes the 5 lead tokens; those feed a SimBa trunk -> 29 categorical action
heads, and an adapool critic reads the stream entering the final block.

The policy's own forward uses fused kernels / SDPA / tuple-returning blocks, so
:meth:`BsrlAdapter.run` re-implements ``NotePolicy._forward_stacked`` on the fp32
CPU path with explicit softmax(QK^T) attention; :meth:`reference` runs the
original forward (with block hooks for intermediate residuals) to verify it.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import math
import subprocess
import sys
import tarfile
import types
from fractions import Fraction
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import torch
import torch.nn.functional as F

from ..interventions import Interventions
from ..paths import BSRL_BRANCH, BSRL_REPO, DEFAULT_BSRL_CKPT, bsrl_code_dir
from .base import Adapter, Capture, ProbeTarget, TokenInfo, as_index, entropy

LEAD_LABELS = ("saber L", "saber R", "torso", "leg L", "leg R")
LEAD_GROUPS = ("saber", "saber", "body", "body", "body")
KINDS = ("note", "bomb", "wall", "link")
COLORS = ("red", "blue")
DIRS = ("dot", "U", "UR", "R", "DR", "D", "DL", "L", "UL")
TTH_EDGES = (0.25, 0.5, 1.0, 2.0)
TTH_CLASSES = ("<0.25s", "0.25-0.5s", "0.5-1s", "1-2s", ">2s")
# lead token -> (head-group name, first head, end) (policy.HEAD_GROUPS order)
LEAD_HEAD_GROUP = {0: "armL", 1: "armR", 2: "spine", 3: "legL", 4: "legR"}

# note-slot lanes (beat_arena_env obs v17+; see policy.py / constants.py)
L_X, L_Y, L_Z, L_VZ, L_RED, L_BLUE, L_COS, L_SIN, L_BOMB, L_CHAIN_HEAD, L_LINK = range(11)
L_WALL = 14


class BsrlSetupError(RuntimeError):
    pass


def export_bsrl_code(dest: Path | None = None, repo: Path = BSRL_REPO, branch: str = BSRL_BRANCH) -> Path:
    """``git archive <branch> python`` from the BSRL repo into data/bsrl (read-only on the repo)."""
    dest = dest or bsrl_code_dir().parent
    dest.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["git", "-C", str(repo), "archive", branch, "python"], capture_output=True)
    if r.returncode != 0:
        raise BsrlSetupError(f"git archive failed: {r.stderr.decode(errors='replace')}")
    with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tf:
        tf.extractall(dest, filter="data")
    return dest / "python"


_MODULES: dict[str, types.ModuleType] = {}


def load_policy_module(code_dir: Path | None = None) -> types.ModuleType:
    """Import the exported policy.py (as module 'bsrl_policy') with beat_arena_env stubbed."""
    code = Path(code_dir or bsrl_code_dir()).resolve()
    key = str(code)
    if key in _MODULES:
        return _MODULES[key]
    if not (code / "policy.py").exists():
        raise BsrlSetupError(
            f"BeatSaberRL policy code not found at {code}. Export it (read-only on the BSRL repo) with:\n"
            f"  python -m evolinterp setup-bsrl\n"
            f"or: git -C {BSRL_REPO.as_posix()} archive {BSRL_BRANCH} python | tar -x -C {code.parent.as_posix()}")
    if str(code) not in sys.path:
        sys.path.insert(0, str(code))
    # Stub the package so `beat_arena_env.constants` loads without __init__ (which imports the Rust sim).
    pkg = sys.modules.get("beat_arena_env")
    if pkg is None or getattr(pkg, "__evolinterp_stub__", False) is False:
        pkg = types.ModuleType("beat_arena_env")
        pkg.__path__ = [str(code / "beat_arena_env")]  # type: ignore[attr-defined]
        pkg.__evolinterp_stub__ = True  # type: ignore[attr-defined]
        sys.modules["beat_arena_env"] = pkg
    spec = importlib.util.spec_from_file_location("bsrl_policy", code / "policy.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["bsrl_policy"] = mod
    spec.loader.exec_module(mod)
    _MODULES[key] = mod
    return mod


def _frac(f: float) -> str:
    if f == 0:
        return "coast"
    fr = Fraction(abs(f)).limit_denominator(16)
    mag = "full" if fr == 1 else f"{fr.numerator}/{fr.denominator}"
    return ("+" if f > 0 else "-") + mag


def bsrl_names(*, run: str | None, update: Any, role: str | None = None, branched_from: Any = None,
               n_layers: int, d_model: int, n_heads: int, branch: str = BSRL_BRANCH) -> tuple[str, str]:
    """(model, short_name) for P.meta — readable, never a filesystem path (that is meta.checkpoint).

    model: "BeatSaberRL NotePolicy · bend7_cd1000 · upd 7000 (leaf from upd 6000) · 9L d256 h8"
    short: "BSRL bend7 · upd 7000"  (variant = run-name prefix before "_", else the code branch)"""
    run = (run or "").strip()
    variant = run.split("_")[0] if run else branch.rsplit("/", 1)[-1]
    upd = f"upd {update}" if update is not None else ""
    origin = f"{role} from upd {branched_from}" if role and branched_from is not None else (role or "")
    step = " ".join(x for x in (upd, f"({origin})" if origin else "") if x)
    parts = ["BeatSaberRL NotePolicy", run, step, f"{n_layers}L d{d_model} h{n_heads}"]
    short = " · ".join(x for x in (f"BSRL {variant}", upd) if x)
    return " · ".join(p for p in parts if p), short


class BsrlAdapter(Adapter):
    kind = "bsrl"
    lens_kind = "logit-lens"

    def __init__(self, checkpoint: str | Path | None = None, *, dataset: str | Path | None = None,
                 code_dir: Path | None = None, log: Any = print):
        ckpt = Path(checkpoint or DEFAULT_BSRL_CKPT)
        if not ckpt.exists():
            raise BsrlSetupError(f"checkpoint not found: {ckpt}")
        self.P = P = load_policy_module(code_dir)
        ck = torch.load(ckpt, map_location="cpu", weights_only=True)
        self.arch = dict(ck.get("arch", {}))
        self.update = ck.get("update")
        run_args = ck.get("args") if isinstance(ck.get("args"), dict) else {}
        run_dir = run_args.get("run_dir")
        self.run_name = Path(str(run_dir)).name if run_dir else ckpt.parent.name
        self.role = ck.get("wsd_role") if isinstance(ck.get("wsd_role"), str) else None
        self.branched_from = ck.get("branched_from_update")
        self.policy = P.load_policy(ck).eval().float()
        if dataset is not None:
            obs = np.load(dataset).astype(np.float32)
            self.dataset_name = str(dataset)
        else:
            if "diag_probe_obs" not in ck:
                raise BsrlSetupError("checkpoint has no diag_probe_obs; pass --dataset obs.npy (N, 630)")
            obs = ck["diag_probe_obs"].float().numpy()
            self.dataset_name = "diag_probe_obs"
        del ck
        if obs.ndim != 2 or obs.shape[1] != P.OBS_DIM:
            raise BsrlSetupError(f"dataset must be (N, {P.OBS_DIM}), got {obs.shape}")
        self.obs = np.ascontiguousarray(obs)
        self.C = sys.modules["beat_arena_env.constants"]
        pol = self.policy
        self.checkpoint = str(ckpt)
        self.n_lead = pol.n_lead
        self.n_layers = len(pol.blocks)
        self.n_heads = pol.n_heads
        self.d_model = pol.embed
        self.n_slots = P.N_NOTE_SLOTS
        self.n_tokens = self.n_lead + self.n_slots
        st = ckpt.stat()
        h = hashlib.sha1(f"{ckpt.resolve()}|{st.st_size}|{st.st_mtime_ns}|{self.dataset_name}|{len(obs)}".encode()).hexdigest()[:8]
        self.model_id = f"bsrl-{ckpt.stem}-{h}"
        self.model_name, self.short_name = bsrl_names(
            run=self.run_name, update=self.update, role=self.role, branched_from=self.branched_from,
            n_layers=self.n_layers, d_model=self.d_model, n_heads=self.n_heads)
        self.lens_description = (
            "residual of the 5 lead tokens at the selected layer -> SimBa trunk -> 29 action heads "
            "(exact at the last layer); lead token selects its limb's joints, entity tokens show probes + attention")
        self.joint_names = list(self.C.JOINT_NAMES)
        self.gear_labels = [[_frac(g) for g in self.C.joint_gear_table(pol.n_gears, j)] for j in range(len(self.joint_names))]
        self.head_groups = {name: (a, b) for name, a, b in P.HEAD_GROUPS}
        self._decode_entities()

    # ---------------------------------------------------------------- dataset decoding

    def _decode_entities(self) -> None:
        P = self.P
        o = self.obs
        notes = o[:, P.OFF_NOTES:P.OFF_NOTE_MASK].reshape(-1, self.n_slots, P.NOTE_FEAT)
        self.slot_mask = o[:, P.OFF_NOTE_MASK:P.OFF_NOTE_MASK + self.n_slots] > 0.5
        kind = np.zeros(self.slot_mask.shape, np.int16)
        kind[notes[..., L_BOMB] > 0.5] = 1
        kind[notes[..., L_LINK] > 0.5] = 3
        kind[notes[..., L_WALL] > 0.5] = 2
        self.ent_kind = np.where(self.slot_mask, kind, -1).astype(np.int16)
        color = np.full(kind.shape, -1, np.int16)
        color[notes[..., L_RED] > 0.5] = 0
        color[notes[..., L_BLUE] > 0.5] = 1
        self.color = np.where(self.slot_mask & ((self.ent_kind == 0) | (self.ent_kind == 3)), color, -1).astype(np.int16)
        c, s = notes[..., L_COS], notes[..., L_SIN]
        ang = np.degrees(np.arctan2(s, c))
        dbin = np.mod(np.round((90.0 - ang) / 45.0).astype(int), 8) + 1
        d = np.where(np.abs(c) + np.abs(s) < 0.5, 0, dbin)
        self.cutdir = np.where(self.slot_mask & (self.ent_kind == 0), d, -1).astype(np.int16)
        # seconds until the note reaches the plane it is judged at (policy._note_geo t_plane, unclipped)
        z_m = np.sinh(notes[..., L_Z]) * float(self.policy.z_asinh)
        speed = np.maximum(-notes[..., L_VZ] * P._Z_SCALE, 1e-3)
        z_off = o[:, P._OBS_HEAD_Z][:, None] * P._X_NORM
        self.tth = ((z_m - z_off) / speed).astype(np.float32)
        self.ent_x = notes[..., L_X] * P._X_NORM
        self.ent_y = notes[..., L_Y] * P._Y_NORM
        self.chain_head = notes[..., L_CHAIN_HEAD] > 0.5

    def num_samples(self) -> int:
        return len(self.obs)

    def valid(self, idx: Sequence[int] | np.ndarray) -> np.ndarray:
        ix = as_index(idx, len(self.obs))
        return np.concatenate([np.ones((len(ix), self.n_lead), bool), self.slot_mask[ix]], axis=1)

    def computed(self) -> np.ndarray:
        c = np.ones((self.n_layers + 1, self.n_tokens), bool)
        c[self.n_layers, self.n_lead:] = False  # the final block only computes the lead tokens
        return c

    # ---------------------------------------------------------------- instrumented forward

    def _embed(self, obs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Mirror of the token-building half of NotePolicy._forward_stacked (fp32)."""
        P, pol = self.P, self.policy
        sabers, body, notes, note_mask = pol._split(obs)
        B = obs.shape[0]
        if pol.note_geo:
            notes = torch.cat([notes, P._note_geo(notes.float(), sabers.float().reshape(B, 2, P.SABER_FEAT),
                                                  pol.z_asinh, pol.game == "flux",
                                                  z_off=obs[:, P._OBS_HEAD_Z].float()).to(notes.dtype)], dim=-1)
        emb = pol.note_mlp(notes)
        hand_id = torch.eye(2, dtype=obs.dtype).expand(B, 2, 2)
        saber_feat = torch.cat([sabers.reshape(B, 2, P.SABER_FEAT), hand_id], dim=-1)
        torso_tok = pol.torso_mlp(body[:, :P.TORSO_FEAT].contiguous()).unsqueeze(1)
        leg_feat = torch.cat([body[:, P.TORSO_FEAT:].contiguous().view(B, 2, P.LEG_FEAT), hand_id], dim=-1)
        body_tok = torch.cat([torso_tok, pol.leg_mlp(leg_feat)], dim=1)
        tokens = torch.cat([pol.saber_mlp(saber_feat), body_tok, emb], dim=1)
        attn_bias = F.pad((note_mask.unsqueeze(1) - 1.0) * P.MASK_BIAS, (pol.n_lead, 0))  # (B, 1, T)
        if pol.emb_ln is not None:
            tokens = pol.emb_ln(tokens)
        return tokens, attn_bias

    def _heads(self, h: torch.Tensor) -> torch.Tensor:
        """Trunk feature h (B, trunk) -> stacked logits (B, 29, k_max) with MASKED_LOGIT fill."""
        pol, P = self.policy, self.P
        w = torch.cat([m.weight for m in pol.heads])
        b = torch.cat([m.bias for m in pol.heads])
        out = F.linear(h, w, b)
        B = h.shape[0]
        if pol._gear_idx is not None:
            out = out.new_full((B, P.N_ACTION_HEADS * pol.k_max), P.MASKED_LOGIT).index_copy(1, pol._gear_idx, out)
        return out.view(B, P.N_ACTION_HEADS, pol.k_max)

    def lead_logits(self, lead: torch.Tensor) -> torch.Tensor:
        """Lead-token residuals (B, 5, d) -> action logits (B, 29, k_max) via (final_ln) + trunk + heads."""
        pol = self.policy
        x = pol.final_ln(lead) if pol.final_ln is not None else lead
        return self._heads(pol._trunk(x.reshape(x.shape[0], -1)))

    @torch.no_grad()
    def run(self, idx: Sequence[int] | np.ndarray, interventions: Interventions | None = None,
            want_attn: bool = True) -> Capture:
        iv = interventions or Interventions()
        P, pol = self.P, self.policy
        obs = torch.from_numpy(self.obs[as_index(idx, len(self.obs))])
        B = obs.shape[0]
        T, d, H, L, nq = self.n_tokens, self.d_model, self.n_heads, self.n_layers, self.n_lead
        dh = d // H
        x, attn_bias = self._embed(obs)
        resid = torch.zeros(B, L + 1, T, d)
        resid[:, 0] = x
        aw = torch.zeros(B, L, T)
        mw = torch.zeros(B, L, T)
        attn = torch.zeros(B, L, H, T, T) if want_attn else None
        v0 = None
        x_res = None
        for li, blk in enumerate(pol.blocks):
            final = li == L - 1
            h = blk.ln_attn(x)
            k, v = blk.k_proj(h), blk.v_proj(h)
            v_own = v
            if v0 is not None and blk.vres_a is not None:
                v = P._VMix.apply(v, v0, blk.vres_a, blk.vres_b)
            if final:
                x_res = x
                xq, hq = x[:, :nq], h[:, :nq]
            else:
                xq, hq = x, h
            q = blk.q_proj(hq)
            Tq = q.shape[1]
            bias = attn_bias.unsqueeze(1)                                  # (B, 1, 1, T)
            blocked = iv.blocked(li)
            if blocked:
                bias = bias.expand(B, 1, Tq, T).clone()
                for qi, ki in blocked:
                    if qi is None:
                        bias[:, :, :, ki] = -P.MASK_BIAS
                    elif qi < Tq:
                        bias[:, :, qi, ki] = -P.MASK_BIAS
            if blk.n_heads == 1:
                scores = (q @ k.transpose(1, 2)) * (d ** -0.5) + bias[:, 0]
                att = torch.softmax(scores, dim=-1)                       # (B, Tq, T)
                o = att @ v
                hs = iv.head_scales(li, 1)
                if hs is not None:
                    o = o * hs[0]
                a_out = o
                att_h = att.unsqueeze(1)
            else:
                qh = q.view(B, Tq, H, dh).transpose(1, 2)
                kh = k.view(B, T, H, dh).transpose(1, 2)
                vh = v.view(B, T, H, dh).transpose(1, 2)
                scores = qh @ kh.transpose(-2, -1) / (dh ** 0.5) + bias
                att_h = torch.softmax(scores, dim=-1)                     # (B, H, Tq, T)
                o = att_h @ vh
                hs = iv.head_scales(li, H)
                if hs is not None:
                    o = o * torch.tensor(hs, dtype=o.dtype)[None, :, None, None]
                a_out = blk.out_proj(o.transpose(1, 2).reshape(B, Tq, d))
            a_out = a_out * iv.scale("attn", li)
            x_mid = xq + a_out
            m_out = blk.ffn(blk.ln_ffn(x_mid)) * iv.scale("mlp", li)
            x = x_mid + m_out
            resid[:, li + 1, :Tq] = x
            aw[:, li, :Tq] = a_out.norm(dim=-1)
            mw[:, li, :Tq] = m_out.norm(dim=-1)
            if attn is not None:
                attn[:, li, :, :Tq] = att_h
            if li == 0 and pol.value_residual:
                v0 = v_own
        lead = x  # (B, 5, d): the final block's computed rows
        if pol.final_ln is not None:
            lead_t = pol.final_ln(lead)
        else:
            lead_t = lead
        hfeat = pol._trunk(lead_t.reshape(B, -1))
        logits = self._heads(hfeat)
        value = pol._critic(x_res, hfeat, attn_bias)
        return Capture(resid=resid.numpy(), attn_write=aw.numpy(), mlp_write=mw.numpy(),
                       attn=None if attn is None else attn.numpy(),
                       outputs={"logits": logits.numpy(), "value": value.numpy()})

    @torch.no_grad()
    def reference(self, idx: Sequence[int] | np.ndarray) -> dict[str, Any]:
        """policy.forward_stacked + block hooks (fp32 CPU path, where module hooks fire)."""
        pol = self.policy
        obs = torch.from_numpy(self.obs[as_index(idx, len(self.obs))])
        B, T, d, L = obs.shape[0], self.n_tokens, self.d_model, self.n_layers
        resid = torch.full((B, L + 1, T, d), float("nan"))
        hooks = []

        def pre0(mod: Any, args: tuple) -> None:
            resid[:, 0] = args[0]

        def post(li: int):
            def fn(mod: Any, args: tuple, out: Any) -> None:
                if li == L - 1:
                    o, x_full = out
                    resid[:, L, :o.shape[1]] = o
                    resid[:, L - 1] = x_full
                else:
                    x_mid, ffn_out, ffn_b = out[:3]
                    r = x_mid + ffn_out
                    if torch.is_tensor(ffn_b):  # bias folded out of the FFN (fp16 path only)
                        r = r + ffn_b
                    resid[:, li + 1] = r
            return fn

        hooks.append(pol.blocks[0].register_forward_pre_hook(pre0))
        for li, blk in enumerate(pol.blocks):
            hooks.append(blk.register_forward_hook(post(li)))
        try:
            logits, value = pol.forward_stacked(obs)
        finally:
            for hk in hooks:
                hk.remove()
        return {"logits": logits.numpy(), "value": value.numpy(), "resid": resid.numpy()}

    # ---------------------------------------------------------------- labels

    def _entity(self, i: int, s: int) -> TokenInfo:
        if not self.slot_mask[i, s]:
            return TokenInfo("pad", "pad")
        k = int(self.ent_kind[i, s])
        t = float(self.tth[i, s])
        where = f"x {self.ent_x[i, s]:+.2f} m, y {self.ent_y[i, s]:+.2f} m (head-relative), hits in {t:.2f}s"
        if k == 2:
            return TokenInfo(f"wall {t:.2f}s", "wall", where)
        if k == 1:
            return TokenInfo(f"bomb {t:.2f}s", "bomb", where)
        col = COLORS[self.color[i, s]] if self.color[i, s] >= 0 else "?"
        if k == 3:
            return TokenInfo(f"{col} link {t:.2f}s", col if col != "?" else "note", "chain link · " + where)
        dname = DIRS[self.cutdir[i, s]] if self.cutdir[i, s] >= 0 else "?"
        extra = "chain head · " if self.chain_head[i, s] else ""
        return TokenInfo(f"{col} {dname} {t:.2f}s", col if col != "?" else "note", f"{extra}cut {dname} · {where}")

    def _lead(self, i: int, t: int) -> TokenInfo:
        P, C = self.P, self.C
        o = self.obs[i]
        if t < 2:
            hb = C.OFF_HAND_L if t == 0 else C.OFF_HAND_R
            speed = float(np.linalg.norm(o[hb + 3:hb + 6]) * C.V_NORM)
            detail = f"wrist speed {speed:.1f} m/s, swing meter {o[hb + 9]:.2f}, follow-through {o[hb + 10]:.2f}"
        elif t == 2:
            v = float(np.linalg.norm(o[C.OFF_ROOT_VLIN:C.OFF_ROOT_VLIN + 3]) * C.ROOT_VLIN_NORM)
            detail = f"pelvis speed {v:.2f} m/s, head z offset {o[P._OBS_HEAD_Z]:+.2f}"
        else:
            g = C.OFF_GROUND_IMP + (0 if t == 3 else 2)
            detail = f"ground contact heel {o[g]:.2f} toe {o[g + 1]:.2f}"
        return TokenInfo(LEAD_LABELS[t], LEAD_GROUPS[t], detail)

    def tokens(self, i: int) -> list[TokenInfo]:
        return [self._lead(i, t) for t in range(self.n_lead)] + [self._entity(i, s) for s in range(self.n_slots)]

    def token_key(self, i: int, t: int) -> str:
        if t < self.n_lead:
            return LEAD_LABELS[t]
        s = t - self.n_lead
        if not self.slot_mask[i, s]:
            return "pad"
        b = int(np.digitize(self.tth[i, s], TTH_EDGES))
        lab = self._entity(i, s).label.rsplit(" ", 1)[0]
        return f"{lab} {TTH_CLASSES[b]}"

    def sample_label(self, i: int) -> str:
        n = int(self.slot_mask[i].sum())
        notes = np.where(self.slot_mask[i] & (self.ent_kind[i] == 0) & (self.tth[i] > -0.1))[0]
        nxt = ""
        if notes.size:
            s = notes[np.argmin(self.tth[i, notes])]
            nxt = f" · next {self._entity(i, int(s)).label}"
        return f"#{i}: {n} entities{nxt}"

    def probe_targets(self) -> dict[str, ProbeTarget]:
        N, nl = len(self.obs), self.n_lead
        pad = np.full((N, nl), -1, np.int16)
        tthb = np.digitize(self.tth, TTH_EDGES).astype(np.int16)
        tth = np.where(self.slot_mask & (self.ent_kind != 2), tthb, -1).astype(np.int16)
        cat = lambda a: np.concatenate([pad, a.astype(np.int16)], axis=1)  # noqa: E731
        return {
            "kind": ProbeTarget("kind", list(KINDS), cat(self.ent_kind), "entity kind: note / bomb / wall / chain link (entity tokens)"),
            "color": ProbeTarget("color", list(COLORS), cat(self.color), "note colour red/blue (notes + chain links)"),
            "cutdir": ProbeTarget("cutdir", list(DIRS), cat(self.cutdir), "required cut direction, 'dot' = any (notes)"),
            "tth": ProbeTarget("tth", list(TTH_CLASSES), cat(tth), "time until the entity reaches its judging plane (notes, bombs, links)"),
        }

    # ---------------------------------------------------------------- lens

    @torch.no_grad()
    def lens_probs(self, resid: np.ndarray) -> np.ndarray:
        """One sample's residuals [n_layers, T, d] -> action probabilities [n_layers, 29, k_max]
        (the lead rows of every layer decoded through trunk + heads)."""
        lead = torch.from_numpy(np.ascontiguousarray(resid[:, :self.n_lead], dtype=np.float32))
        return torch.softmax(self.lead_logits(lead), dim=-1).numpy()

    def lens(self, i: int, cap: Capture, layer: int, token: int, *, probes: Any = None,
             clean: Capture | None = None) -> dict[str, Any]:
        L = self.n_layers
        layer = int(np.clip(layer, 0, L))
        token = int(np.clip(token, 0, self.n_tokens - 1))
        toks = self.tokens(i)
        lab = self.layer_labels[layer]
        items: list[dict[str, Any]] = []
        if token < self.n_lead:
            probs = self.lens_probs(cap.resid[0])                       # [L+1, 29, k]
            p, pf = probs[layer], probs[L]
            g = LEAD_HEAD_GROUP[token]
            a, b = self.head_groups[g]
            ent = entropy(p)
            for j in range(a, b):
                top = int(np.argmax(p[j]))
                name = self.joint_names[j]
                name = name[2:] if name[:2] in ("l_", "r_") else name
                items.append({"label": f"{name} {self.gear_labels[j][top]} (H {ent[j]:.2f})", "value": float(p[j, top])})
            agree = float(np.mean(np.argmax(p, -1) == np.argmax(pf, -1)))
            with np.errstate(divide="ignore", invalid="ignore"):
                kl = np.nansum(np.where(pf > 0, pf * (np.log(pf) - np.log(np.maximum(p, 1e-12))), 0.0), -1)
            items.append({"label": "argmax agrees with final (29 heads)", "value": agree})
            items.append({"label": "KL(final || this layer), mean/head", "value": float(np.mean(kl))})
            items.append({"label": "critic value (normalized)", "value": float(cap.outputs["value"][0])})
            if clean is not None:
                pc = self.lens_probs(clean.resid[0])[L]
                with np.errstate(divide="ignore", invalid="ignore"):
                    klc = np.nansum(np.where(pc > 0, pc * (np.log(pc) - np.log(np.maximum(pf, 1e-12))), 0.0), -1)
                items.append({"label": "KL(clean || intervened) policy, mean/head", "value": float(np.mean(klc))})
                items.append({"label": "clean critic value", "value": float(clean.outputs["value"][0])})
            title = f"logit lens @ {lab} · {LEAD_LABELS[token]} -> {g} joints"
        else:
            info = toks[token]
            if info.group == "pad":
                return {"layer": layer, "token": token, "title": f"{lab} · empty entity slot (padding)", "items": []}
            if probes is not None and layer < L:
                items.extend(probes.readout_items(cap.resid[0], layer, token, self.probe_labels_for(i)))
            blk = min(layer, L - 1)
            if cap.attn is not None:
                for q in range(self.n_lead):
                    items.append({"label": f"attn {LEAD_LABELS[q]} -> this (b{blk}, mean heads)",
                                  "value": float(cap.attn[0, blk, :, q, token].mean())})
            items.append({"label": "residual norm", "value": float(np.linalg.norm(cap.resid[0, min(layer, L - 1), token]))})
            note = " (not computed in the final block)" if layer == L else ""
            title = f"{lab} · {info.label}{note}"
        return {"layer": layer, "token": token, "title": title, "items": items}

    def describe(self) -> dict[str, Any]:
        d = super().describe()
        d.update(update=self.update, dataset=self.dataset_name, head_sizes=list(self.policy.head_sizes))
        return d
