"""Toy model: instrumented forward, interventions, contract payloads, probes, SAE."""

from __future__ import annotations

import numpy as np
import pytest

from evolinterp.contract import ch, validate
from evolinterp.interventions import InterventionError, Interventions


def test_toy_learns_task(toy) -> None:
    assert toy.train_stats["accuracy"] > 0.9


def test_instrumented_forward_matches_original(toy) -> None:
    res = toy.verify(np.arange(256))
    assert res["logits"] < 1e-4
    assert res["resid"] < 1e-4


def test_capture_shapes_and_attention(toy) -> None:
    cap = toy.run(np.arange(8))
    L, H, T, d = toy.n_layers, toy.n_heads, toy.n_tokens, toy.d_model
    assert cap.resid.shape == (8, L + 1, T, d) and cap.resid.dtype == np.float32
    assert cap.attn.shape == (8, L, H, T, T)
    np.testing.assert_allclose(cap.attn.sum(-1), 1.0, atol=1e-5)
    # padding keys get no attention
    pad = ~toy.valid(np.arange(8))
    assert np.all(cap.attn.transpose(0, 1, 2, 4, 3)[np.broadcast_to(pad[:, None, None, :, None], (8, L, H, T, T))] < 1e-3)


def test_interventions(toy) -> None:
    ix = np.arange(64)
    clean = toy.run(ix)
    same = toy.run(ix, Interventions.parse([{"op": "head", "layer": 0, "head": 1, "scale": 1.0}]))
    np.testing.assert_allclose(same.outputs["logits"], clean.outputs["logits"], atol=1e-6)
    abl = toy.run(ix, Interventions.parse([{"op": "attn", "layer": 0}, {"op": "attn", "layer": 1}, {"op": "attn", "layer": 2}]))
    # without attention the CLS token cannot see the items: accuracy collapses
    acc_clean = (clean.outputs["logits"].argmax(-1) == toy.answers[ix]).mean()
    acc_abl = (abl.outputs["logits"].argmax(-1) == toy.answers[ix]).mean()
    assert acc_clean > 0.9 and acc_abl < 0.6
    blk = toy.run(ix, Interventions.parse({"op": "block", "key": 1, "layer": "b0"}))
    assert np.all(blk.attn[:, 0, :, :, 1] < 1e-3)
    assert np.any(blk.attn[:, 1, :, :, 1] > 1e-3)
    mlp = toy.run(ix, Interventions.parse([{"op": "mlp", "layer": 1}]))
    assert np.all(mlp.mlp_write[:, 1] == 0)


def test_intervention_parsing() -> None:
    iv = Interventions.parse('[{"op":"head","layer":"b2","head":3,"scale":0.5},{"op":"block","key":4}]', n_layers=4, n_heads=4, n_tokens=8)
    assert iv.head_scales(2, 4) == [1.0, 1.0, 1.0, 0.5]
    assert iv.blocked(0) == [(None, 4)] and iv.blocked(3) == [(None, 4)]
    assert "b2h3x0.5" in iv.describe()
    assert not Interventions.parse(None) and not Interventions.parse([])
    for bad in ([{"op": "nope"}], [{"op": "head", "layer": 9, "head": 0}], [{"op": "head", "layer": 0, "head": 7}],
                [{"op": "mlp"}], "not json", [{"op": "block", "key": 99}],
                [{"op": "mlp", "layer": 0, "scale": float("nan")}], [{"op": "attn", "layer": 0, "scale": 1e30}],
                [{"op": "attn", "layer": 0, "scale": "big"}], [{"op": "attn", "layer": 0, "scale": None}]):
        with pytest.raises(InterventionError):
            Interventions.parse(bad, n_layers=4, n_heads=4, n_tokens=8)


def test_contract_payload(toy_session) -> None:
    s, a = toy_session, toy_session.adapter
    L, T, H = a.n_layers, a.n_tokens, a.n_heads
    for iv in (None, Interventions.parse([{"op": "head", "layer": 1, "head": 0}])):
        p = s.payload("tp", 3, 2, 0, iv)
        p.update(s.static_payload("tp"))
        assert validate(p, "tp", L=L, T=T, H=H) == []
        meta = p[ch("tp", "meta")]
        assert meta["layers"] == ["embed", "b0", "b1", "b2"] and meta["d_model"] == a.d_model
        assert meta["sample"] == {"index": 3, "total": a.num_samples(), "label": a.sample_label(3)}
        assert meta["lens"]["kind"] == "logit-lens"
        assert [t["label"] for t in meta["tokens"]][0] == "CLS"
        mask = p[ch("tp", "resid.mask")]
        assert mask.dtype == np.uint8 and np.array_equal(mask[0].astype(bool), a.valid([3])[0])
        # masked positions project to the origin
        proj = p[ch("tp", "resid.proj")]
        assert np.all(proj[mask == 0] == 0)
        assert p[ch("tp", "probe.index")] == ["color", "shape", "counted", "answer"]
        ro = p[ch("tp", "lens.readout")]
        assert ro["layer"] == 2 and ro["token"] == 0 and ro["items"]
    # cached (clean) arrays equal a fresh computation
    v = s.view(5)
    cap = a.run([5])
    np.testing.assert_allclose(v.norm, np.linalg.norm(cap.resid[0], axis=-1) * a.mask([5])[0], rtol=1e-5, atol=1e-4)
    np.testing.assert_allclose(v.proj, s.cache.projector.project(cap.resid[0]) * a.mask([5])[0][..., None], atol=2e-3)
    assert 0.5 < np.percentile(np.linalg.norm(s.cache.proj, axis=-1)[s.cache.mask.astype(bool)], 99) < 1.5


def test_probe_pipeline(toy_session) -> None:
    ps = toy_session.probes
    assert ps is not None
    acc = {n: p.acc for n, p in ps.probes.items()}
    assert acc["color"][0] > 0.95 and acc["shape"][0] > 0.95       # input features are linear in the embedding
    assert acc["answer"][-1] > 0.9 and acc["answer"][0] < 0.6       # the answer only exists after attention
    assert acc["counted"][-1] > acc["counted"][0]
    # published scores: 2*P(true)-1 in [-1, 1]; NaN where n/a (consumers draw non-finite as neutral)
    v = toy_session.view(0)
    sc = v.probes["color"]
    lab = toy_session.adapter.probe_labels_for(0)["color"]
    assert np.all(np.isnan(sc[:, lab < 0]))
    assert np.all((sc[:, lab >= 0] >= -1) & (sc[:, lab >= 0] <= 1))
    assert sc[:, lab >= 0].mean() > 0.8
    ans = v.probes["answer"]
    assert ans[-1, 0] > 0.8 and np.all(np.isnan(ans[:, 1:]))
    raw = toy_session.probes.scores(toy_session.capture(0).resid[0], toy_session.adapter.probe_labels_for(0),
                                    v.mask, signed=False)
    np.testing.assert_allclose(2 * raw["answer"] - 1, ans, atol=1e-6)
    # accuracy: NaN where no probe exists; probe.info stays JSON-safe (null)
    import json

    json.dumps(toy_session.probes.info(), allow_nan=False)
    # save / load round trip
    from evolinterp.probes import ProbeSet

    ps2 = ProbeSet.load(toy_session.probes_path)
    v2 = ps2.scores(toy_session.capture(0).resid[0], toy_session.adapter.probe_labels_for(0), v.mask)
    np.testing.assert_allclose(v2["answer"], ans, atol=1e-6)


def test_sae_train_and_top_features(toy_session) -> None:
    from evolinterp.capture import load_or_capture
    from evolinterp.sae import feature_summaries, load_sae, sae_path, save_sae, top_features, train_sae

    a = toy_session.adapter
    cache, resid = load_or_capture(a, keep_resid=True, log=None)
    si, ti = np.nonzero(cache.mask[:, 2].astype(bool))
    X = resid[si, 2, ti].astype(np.float32)
    sae, stats = train_sae(X, m=128, steps=300, batch=512, log=None)
    assert stats.mse_frac < 0.5 and stats.l0 > 0
    keys = [a.token_key(int(s), int(t)) for s, t in zip(si, ti)]
    summ = feature_summaries(sae, X, keys)
    assert len(summ) == 128 and any(f["freq"] > 0 for f in summ)
    p = sae_path(toy_session.dir, "b1")
    save_sae(p, sae, {"features": summ, "stats": {"l0": stats.l0}})
    sae2, meta = load_sae(p)
    assert top_features(sae2, X[0]) == top_features(sae, X[0])
    toy_session.load_saes(log=None)
    top = toy_session.sae_top("b1", 0, 1)
    assert top["layer"] == "b1" and top["features"] and {"id", "act", "label", "freq"} <= set(top["features"][0])
    assert toy_session.static_payload("tp")[ch("tp", "sae.index")] == ["b1"]
    p.unlink()
    toy_session.saes.clear()


def test_publish_order_puts_indexes_last(toy_session) -> None:
    from evolinterp.contract import publish_order

    p = toy_session.static_payload("tp")
    p.update(toy_session.payload("tp", 1, 1, 0))
    names = [n for n, _ in publish_order(p)]
    first_index = min(i for i, n in enumerate(names) if n.endswith(".index"))
    assert all(n.endswith(".index") for n in names[first_index:])
    assert names.index("tp.probe.color") < names.index("tp.probe.index")


def test_meta_names_and_projection_info(toy_session) -> None:
    s, a = toy_session, toy_session.adapter
    meta = s.payload("tp", 2, 1, 0)[ch("tp", "meta")]
    assert meta["model"] == a.model_name and meta["short_name"] == a.short_name == "toy red-majority · 3L d64"
    assert meta["checkpoint"] == a.checkpoint and meta["checkpoint"].endswith(".pt")
    assert meta["checkpoint"] not in meta["model"] and "/" not in meta["model"] and "\\" not in meta["model"]
    pj = meta["proj"]
    assert pj["normalized"] is True and pj["basis"] == "pca" and len(pj["explained_variance"]) == 3
    ev = pj["explained_variance"]
    assert all(0 < x < 1 for x in ev) and ev[0] >= ev[1] >= ev[2] and sum(ev) <= 1 + 1e-6
    # the validator catches a path leaking into meta.model and a malformed meta.proj
    bad = {ch("tp", "meta"): {**meta, "model": f"toy {meta['checkpoint']}", "proj": {"normalized": True}}}
    probs = validate(bad, "tp", L=a.n_layers, T=a.n_tokens, H=a.n_heads)
    assert any("checkpoint path" in p for p in probs) and any("meta.proj" in p for p in probs)


def test_projection_is_scale_invariant_per_vector(toy_session) -> None:
    """P.resid.proj projects RMS-normalized residuals: a vector's magnitude does not move it
    (P.resid.norm carries magnitudes), so low-norm early layers are not collapsed to the centre."""
    from evolinterp.capture import normalize_rows

    pr = toy_session.cache.projector
    assert pr.normalized
    r = toy_session.capture(4).resid[0]                       # [L+1, T, d]
    np.testing.assert_allclose(pr.project(r * 7.5), pr.project(r), atol=1e-4)
    n = normalize_rows(r)
    rms = np.sqrt(np.mean(n.astype(np.float64) ** 2, -1))
    m = np.linalg.norm(r, axis=-1) > 0
    np.testing.assert_allclose(rms[m], 1.0, atol=1e-4)
    assert np.all(normalize_rows(np.zeros((2, 5), np.float32)) == 0)   # zero vectors stay zero (no NaN)
    # norms still carry the magnitudes
    v = toy_session.view(4)
    np.testing.assert_allclose(v.norm, np.linalg.norm(r, axis=-1) * v.mask, rtol=1e-5, atol=1e-4)
    # interventions use the same normalized projection
    iv = Interventions.parse([{"op": "mlp", "layer": 0, "scale": 3.0}])
    vi = toy_session.view(4, iv)
    np.testing.assert_allclose(vi.proj, pr.project(toy_session.capture(4, iv).resid[0]) * vi.mask[..., None], atol=1e-5)


def test_stale_capture_cache_is_recaptured(toy, tmp_path, monkeypatch) -> None:
    """v1 caches (raw-residual projection) are ignored and replaced, never reused."""
    from evolinterp import capture as cap_mod

    monkeypatch.setenv("EVOL_INTERP_DATA", str(tmp_path))
    path = cap_mod.model_dir(toy) / "capture.npz"
    fresh, _ = cap_mod.load_or_capture(toy, log=None)
    assert cap_mod.DatasetCache.load(path, toy.model_id) is not None
    # rewrite it as a version-1 file
    with np.load(path, allow_pickle=False) as z:
        d = {k: z[k] for k in z.files if k != "pca_normalized"}
    d["version"] = np.array(1)
    d["proj"] = np.full_like(d["proj"], 9.0)
    np.savez_compressed(path, **d)
    assert cap_mod.DatasetCache.load(path, toy.model_id) is None
    msgs: list[str] = []
    again, _ = cap_mod.load_or_capture(toy, log=msgs.append)
    assert not any("loaded" in m for m in msgs)
    np.testing.assert_allclose(again.proj, fresh.proj, atol=1e-5)
    with np.load(path, allow_pickle=False) as z:
        assert int(z["version"]) == cap_mod.CACHE_VERSION and bool(z["pca_normalized"])
    # same version but a different projection mode is also rejected
    with np.load(path, allow_pickle=False) as z:
        d = {k: z[k] for k in z.files}
    d["pca_normalized"] = np.array(False)
    np.savez_compressed(path, **d)
    assert cap_mod.DatasetCache.load(path, toy.model_id) is None
