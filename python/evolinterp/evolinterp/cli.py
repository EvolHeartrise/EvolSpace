"""evolinterp command line.

  python -m evolinterp setup-bsrl                         export BeatSaberRL exp/bend7 python/ into data/bsrl
  python -m evolinterp verify  --model bsrl|toy [--n 256] instrumented forward vs the model's own forward
  python -m evolinterp capture --model ... [--force]      dataset activations + shared PCA -> capture.npz
  python -m evolinterp probe   --model ...                 train per-layer linear probes -> probes.npz
  python -m evolinterp sae-train --model ... --layer b5   train a sparse autoencoder -> sae-b5.pt
  python -m evolinterp info    --model ... [--sample 0]   tokens / labels / readout for one sample
  python -m evolinterp publish --model ... --sample 3 [--ablate JSON]   one-shot publish (no control loop)
  python -m evolinterp live    --model ... [--prefix interp]            the live source (see live.py)

Artifacts live in data/interp/<model_id>/ (model_id printed by every command).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

import numpy as np


def _log(msg: str) -> None:
    print(msg, flush=True)


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--model", choices=("bsrl", "toy"), default="bsrl")
    p.add_argument("--checkpoint", default=None, help="bsrl checkpoint .pt (default: $EVOL_BSRL_CKPT / paths.DEFAULT_BSRL_CKPT)")
    p.add_argument("--dataset", default=None, help="bsrl: observation .npy (N, 630); default: the checkpoint's diag_probe_obs")


def _adapter(args: argparse.Namespace) -> Any:
    from .adapters import make_adapter

    a = make_adapter(args.model, args.checkpoint, dataset=args.dataset, log=_log)
    _log(f"model {a.model_name}\nmodel_id {a.model_id}  ({a.num_samples()} samples, L={a.n_layers} H={a.n_heads} "
         f"T={a.n_tokens} d={a.d_model})")
    return a


def cmd_setup_bsrl(args: argparse.Namespace) -> int:
    from .adapters.bsrl import export_bsrl_code

    out = export_bsrl_code()
    _log(f"exported BeatSaberRL policy code to {out}")
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    a = _adapter(args)
    n = min(args.n, a.num_samples())
    res = a.verify(np.arange(n))
    _log(json.dumps(res, indent=2))
    worst = max(v for k, v in res.items() if k != "resid_rel" and np.isfinite(v))
    ok = worst <= args.tol
    _log(f"{'OK' if ok else 'MISMATCH'}: max abs diff {worst:.3g} (tolerance {args.tol:g}) over {n} samples")
    return 0 if ok else 1


def cmd_capture(args: argparse.Namespace) -> int:
    from .capture import load_or_capture, model_dir

    a = _adapter(args)
    cache, _ = load_or_capture(a, force=args.force, log=_log)
    m = cache.mask.astype(bool)
    _log(f"saved to {model_dir(a) / 'capture.npz'}")
    _log("layer  mean|resid|   (writes of the block producing it: |attn|  |mlp|)")
    for li, lab in enumerate(a.layer_labels):
        nm = cache.norm[:, li][m[:, li]].mean() if m[:, li].any() else float("nan")
        if li == 0:
            _log(f"{lab:6s} {nm:11.2f}")
            continue
        aw = cache.delta[:, li - 1, 0][m[:, li]].mean()
        mw = cache.delta[:, li - 1, 1][m[:, li]].mean()
        _log(f"{lab:6s} {nm:11.2f}   {aw:39.2f} {mw:6.2f}")
    return 0


def cmd_probe(args: argparse.Namespace) -> int:
    from .session import InterpSession

    a = _adapter(args)
    s = InterpSession.open(a, probes="off", log=_log)
    s.train_probes(log=_log, max_train=args.max_train, C=args.C)
    return 0


def cmd_sae_train(args: argparse.Namespace) -> int:
    from .capture import load_or_capture, model_dir
    from .sae import feature_summaries, sae_path, save_sae, train_sae

    a = _adapter(args)
    if args.layer not in a.layer_labels:
        _log(f"--layer must be one of {', '.join(a.layer_labels)}")
        return 2
    li = a.layer_labels.index(args.layer)
    cache, resid = load_or_capture(a, keep_resid=True, log=_log)
    assert resid is not None
    m = cache.mask[:, li].astype(bool)
    si, ti = np.nonzero(m)
    X = resid[si, li, ti].astype(np.float32)
    keys_by_sample: dict[int, list[str]] = {}
    keys = []
    for s_, t_ in zip(si.tolist(), ti.tolist()):
        if s_ not in keys_by_sample:
            keys_by_sample[s_] = [a.token_key(s_, t) for t in range(a.n_tokens)]
        keys.append(keys_by_sample[s_][t_])
    del resid
    feats = args.features or 4 * a.d_model
    _log(f"[sae] layer {args.layer}: {len(X)} residual vectors, d={X.shape[1]}, {feats} features, l1={args.l1}")
    sae, stats = train_sae(X, m=feats, l1=args.l1, steps=args.steps, batch=args.batch, lr=args.lr, log=_log)
    summ = feature_summaries(sae, X, keys)
    meta = {"model_id": a.model_id, "layer": args.layer, "l1": args.l1, "steps": args.steps,
            "stats": {"unexplained_variance": round(stats.mse_frac, 4), "l0": round(stats.l0, 2),
                      "dead_frac": round(stats.dead_frac, 4)},
            "features": summ, "created": time.time()}
    path = sae_path(model_dir(a), args.layer)
    save_sae(path, sae, meta)
    _log(f"[sae] saved {path}")
    live = sorted((f for f in summ if f["freq"] > 0), key=lambda f: -f["max"])[:12]
    for f in live:
        _log(f"  f{f['id']:<5d} freq {f['freq']:.3f} max {f['max']:7.2f}  {f['label']}")
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    from .session import InterpSession

    a = _adapter(args)
    s = InterpSession.open(a, probes="load", log=_log)
    i = args.sample % a.num_samples()
    _log(a.sample_label(i))
    for t, tok in enumerate(a.tokens(i)):
        _log(f"  t{t:<3d} {tok.group:6s} {tok.label:18s} {tok.detail or ''}")
    ro = s.readout(i, a.n_layers if args.layer is None else args.layer, args.token)
    _log(f"\n{ro['title']}")
    for it in ro["items"]:
        _log(f"  {it['value']:8.3f}  {it['label']}")
    return 0


def cmd_publish(args: argparse.Namespace) -> int:
    from evolspace import Client

    from .interventions import Interventions
    from .session import InterpSession

    a = _adapter(args)
    s = InterpSession.open(a, probes="load", log=_log)
    iv = Interventions.parse(args.ablate, n_layers=a.n_layers, n_heads=a.n_heads, n_tokens=a.n_tokens)
    c = Client(args.url, producer=f"interp:{args.prefix}")
    payload = s.static_payload(args.prefix)
    payload.update(s.payload(args.prefix, args.sample, a.n_layers if args.layer is None else args.layer, args.token, iv))
    from .contract import json_safe, publish_order

    for name, v in publish_order(payload):
        c.publish(name, v if isinstance(v, np.ndarray) else json_safe(v))
    _log(f"published {len(payload)} channels under '{args.prefix}.*' (interventions: {iv.describe()})")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m evolinterp", description="EvolSpace interp backend",
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("setup-bsrl", help="export BeatSaberRL exp/bend7 python/ via git archive (read-only)")
    sp.set_defaults(fn=cmd_setup_bsrl)

    sp = sub.add_parser("verify", help="instrumented forward vs original forward")
    _common(sp)
    sp.add_argument("--n", type=int, default=256)
    sp.add_argument("--tol", type=float, default=1e-4)
    sp.set_defaults(fn=cmd_verify)

    sp = sub.add_parser("capture", help="capture dataset activations + PCA basis")
    _common(sp)
    sp.add_argument("--force", action="store_true")
    sp.set_defaults(fn=cmd_capture)

    sp = sub.add_parser("probe", help="train per-layer linear probes")
    _common(sp)
    sp.add_argument("--max-train", type=int, default=5000)
    sp.add_argument("--C", type=float, default=0.5)
    sp.set_defaults(fn=cmd_probe)

    sp = sub.add_parser("sae-train", help="train a sparse autoencoder on one layer")
    _common(sp)
    sp.add_argument("--layer", required=True, help="layer label, e.g. b5 (see `info`)")
    sp.add_argument("--features", type=int, default=None, help="dictionary size (default 4 x d_model)")
    sp.add_argument("--l1", type=float, default=3e-3)
    sp.add_argument("--steps", type=int, default=3000)
    sp.add_argument("--batch", type=int, default=1024)
    sp.add_argument("--lr", type=float, default=1e-3)
    sp.set_defaults(fn=cmd_sae_train)

    sp = sub.add_parser("info", help="tokens + lens readout for one sample")
    _common(sp)
    sp.add_argument("--sample", type=int, default=0)
    sp.add_argument("--layer", type=int, default=None)
    sp.add_argument("--token", type=int, default=0)
    sp.set_defaults(fn=cmd_info)

    sp = sub.add_parser("publish", help="publish the contract channels once")
    _common(sp)
    sp.add_argument("--sample", type=int, default=0)
    sp.add_argument("--layer", type=int, default=None)
    sp.add_argument("--token", type=int, default=0)
    sp.add_argument("--ablate", default=None, help='intervention JSON, e.g. \'[{"op":"head","layer":3,"head":1}]\'')
    sp.add_argument("--prefix", default="interp")
    sp.add_argument("--url", default=None)
    sp.set_defaults(fn=cmd_publish)

    sp = sub.add_parser("live", help="run the live source (same as python -m evolinterp.live)")
    from .live import build_parser
    build_parser(sp)
    sp.set_defaults(fn=None)

    args, rest = p.parse_known_args(argv)
    if args.cmd == "live":
        from .live import main as live_main
        return live_main(sys.argv[2:] if argv is None else argv[1:])
    if rest:
        p.error(f"unrecognized arguments: {' '.join(rest)}")
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
