"""Filesystem locations. The repo root comes from this file's location (never the CWD).

Env overrides:
  EVOL_REPO          repo root (the server sets it for supervised sources)
  EVOL_INTERP_DATA   cache/artifact dir (default <repo>/data/interp)
  EVOL_BSRL_CODE     BeatSaberRL python/ export (default <repo>/data/bsrl/python)
  EVOL_BSRL_CKPT     default BeatSaberRL checkpoint
"""

from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent  # python/evolinterp


def repo_root() -> Path:
    env = os.environ.get("EVOL_REPO")
    if env and Path(env).is_dir():
        return Path(env).resolve()
    return PACKAGE_DIR.parents[2]


def data_dir() -> Path:
    env = os.environ.get("EVOL_INTERP_DATA")
    return Path(env).resolve() if env else repo_root() / "data" / "interp"


def bsrl_code_dir() -> Path:
    env = os.environ.get("EVOL_BSRL_CODE")
    return Path(env).resolve() if env else repo_root() / "data" / "bsrl" / "python"


#: BeatSaberRL repo (read-only; only `git archive` is ever run against it)
BSRL_REPO = Path(os.environ.get("EVOL_BSRL_REPO", "D:/Git/BeatSaberRL"))
BSRL_BRANCH = "exp/bend7"
#: Machine-specific default checkpoint (exp/bend7 leaf, ~5.9M params)
DEFAULT_BSRL_CKPT = Path(os.environ.get(
    "EVOL_BSRL_CKPT", "C:/Users/Flee/beat-arena-volume-backup/bend7/runs/bend7_cd1000/leaf_from_upd06000.pt"))
