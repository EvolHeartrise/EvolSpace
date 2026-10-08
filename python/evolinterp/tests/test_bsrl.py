"""BeatSaberRL adapter (skipped without the code export / checkpoint)."""

from __future__ import annotations

import numpy as np
import pytest

from evolinterp.contract import ch, validate
from evolinterp.interventions import Interventions

pytestmark = pytest.mark.bsrl


def test_instrumented_forward_matches_original(bsrl) -> None:
    res = bsrl.verify(np.arange(128))
    assert res["logits"] < 1e-4, res
    assert res["value"] < 1e-4, res
    assert res["resid_rel"] < 1e-5, res  # every block's residual (block hooks on the fp32 path)


def test_structure_and_masks(bsrl) -> None:
    L, T = bsrl.n_layers, bsrl.n_tokens
    assert (L, bsrl.n_heads, bsrl.d_model, T) == (10, 4, 192, 29)
    c = bsrl.computed()
    assert c[:L].all() and c[L, :5].all() and not c[L, 5:].any()
    ix = np.argsort(bsrl.slot_mask.sum(1), kind="stable")[:16]  # samples with padded slots
    assert (~bsrl.slot_mask[ix]).any()
    m = bsrl.mask(ix)
    assert m.shape == (16, L + 1, T)
    assert np.array_equal(m[:, 0, 5:], bsrl.slot_mask[ix])
    cap = bsrl.run(ix)
    assert np.all(cap.resid[:, L, 5:] == 0)                 # uncomputed final-block rows
    assert np.all(cap.attn[:, L - 1, :, 5:] == 0)           # final block: only lead queries
    np.testing.assert_allclose(cap.attn[:, :L - 1].sum(-1), 1.0, atol=1e-5)
    pad_keys = ~bsrl.valid(ix)
    assert cap.attn.transpose(0, 1, 2, 4, 3)[np.broadcast_to(pad_keys[:, None, None, :, None], cap.attn.shape)].max(initial=0) < 1e-6
    assert cap.outputs["logits"].shape == (16, 29, bsrl.policy.k_max)


def test_token_labels_and_targets(bsrl) -> None:
    toks = bsrl.tokens(0)
    assert [t.label for t in toks[:5]] == ["saber L", "saber R", "torso", "leg L", "leg R"]
    for s in range(24):
        t = toks[5 + s]
        if not bsrl.slot_mask[0, s]:
            assert t.group == "pad"
        else:
            assert t.group in ("red", "blue", "bomb", "wall", "note") and t.label.endswith("s")
    tg = bsrl.targets()
    assert set(tg) == {"kind", "color", "cutdir", "tth"}
    for t in tg.values():
        assert t.labels.shape == (bsrl.num_samples(), 29)
        assert np.all(t.labels[:, :5] == -1)
        assert np.all(t.labels[:, 5:][~bsrl.slot_mask] == -1)
        assert t.labels.max() < len(t.classes)
    # colour/kind decode is consistent with the raw lanes
    notes = bsrl.obs[:, 102:534].reshape(-1, 24, 18)
    red = tg["color"].labels[:, 5:] == 0
    assert np.all(notes[..., 4][red] > 0.5)


def test_lens_is_exact_at_the_last_layer(bsrl) -> None:
    cap = bsrl.run([7])
    probs = bsrl.lens_probs(cap.resid[0])
    final = np.exp(cap.outputs["logits"][0] - cap.outputs["logits"][0].max(-1, keepdims=True))
    final /= final.sum(-1, keepdims=True)
    np.testing.assert_allclose(probs[-1], final, atol=1e-5)
    ro = bsrl.lens(7, cap, bsrl.n_layers, 0)
    agree = next(i for i in ro["items"] if i["label"].startswith("argmax agrees"))
    assert agree["value"] == 1.0
    assert len([i for i in ro["items"] if "(H " in i["label"]]) == 7   # 7 left-arm joints
    ro_e = bsrl.lens(7, cap, 3, 6)
    assert ro_e["token"] == 6 and ro_e["title"].startswith("b2")


def test_interventions_change_the_policy(bsrl) -> None:
    ix = np.arange(32)
    clean = bsrl.run(ix)
    same = bsrl.run(ix, Interventions.parse([{"op": "head", "layer": 5, "head": 2, "scale": 1}]))
    np.testing.assert_allclose(same.outputs["logits"], clean.outputs["logits"], atol=1e-5)
    abl = bsrl.run(ix, Interventions.parse([{"op": "attn", "layer": 9}]))
    assert np.abs(abl.outputs["logits"] - clean.outputs["logits"]).max() > 1e-2
    np.testing.assert_allclose(abl.resid[:, :10], clean.resid[:, :10], atol=1e-4)  # upstream untouched
    blk = bsrl.run(ix, Interventions.parse([{"op": "block", "key": 0, "query": 1}]))
    assert np.all(blk.attn[:, :, :, 1, 0] < 1e-6)


def test_session_payload(bsrl) -> None:
    from evolinterp.session import InterpSession

    s = InterpSession.open(bsrl, probes="off", log=None)
    p = s.payload("ib", 11, 4, 0, Interventions.parse([{"op": "head", "layer": 2, "head": 0}]))
    p.update(s.static_payload("ib"))
    assert validate(p, "ib", L=10, T=29, H=4) == []
    assert p[ch("ib", "resid.mask")][10, 5:].sum() == 0
    assert "b2h0 off" in p[ch("ib", "meta")]["interventions"]


def test_names_never_carry_the_path() -> None:
    from evolinterp.adapters.bsrl import bsrl_names

    model, short = bsrl_names(run="bend7_cd1000", update=7000, role="leaf", branched_from=6000,
                              n_layers=10, d_model=192, n_heads=4)
    assert short == "BSRL bend7 · upd 7000"
    assert model == "BeatSaberRL NotePolicy · bend7_cd1000 · upd 7000 (leaf from upd 6000) · 10L d192 h4"
    model, short = bsrl_names(run=None, update=None, n_layers=2, d_model=8, n_heads=1, branch="exp/foo")
    assert short == "BSRL foo" and model == "BeatSaberRL NotePolicy · 2L d8 h1"


def test_meta_names_and_normalized_projection(bsrl) -> None:
    from evolinterp.session import InterpSession

    assert bsrl.short_name == f"BSRL bend7 · upd {bsrl.update}"
    s = InterpSession.open(bsrl, probes="off", log=None)
    meta = s.payload("ib", 3, 4, 0)[ch("ib", "meta")]
    assert meta["short_name"] == bsrl.short_name and meta["checkpoint"] == bsrl.checkpoint
    assert "/" not in meta["model"] and "\\" not in meta["model"] and "leaf_from" not in meta["model"]
    assert meta["proj"]["normalized"] is True and len(meta["proj"]["explained_variance"]) == 3
    # early layers are no longer collapsed onto the centre (raw norms grow ~7x through depth)
    m = s.cache.mask.astype(bool)
    r = np.linalg.norm(s.cache.proj, axis=-1)
    mean_r = [r[:, li][m[:, li]].mean() for li in range(bsrl.n_layers + 1)]
    assert min(mean_r) > 0.25 * max(mean_r), mean_r
