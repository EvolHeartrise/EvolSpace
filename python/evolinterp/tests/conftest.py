from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Iterator

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
# the SDK's in-process fake server (python/evolspace/tests/fake_server.py)
sys.path.insert(0, str(REPO / "python" / "evolspace" / "tests"))


@pytest.fixture(scope="session", autouse=True)
def interp_data(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    """Isolate artifacts (toy weights, captures, probes, SAEs) in a temp dir unless
    EVOL_INTERP_TEST_DATA points at a reusable one."""
    d = Path(os.environ.get("EVOL_INTERP_TEST_DATA") or tmp_path_factory.mktemp("interp"))
    old = os.environ.get("EVOL_INTERP_DATA")
    os.environ["EVOL_INTERP_DATA"] = str(d)
    yield d
    if old is None:
        os.environ.pop("EVOL_INTERP_DATA", None)
    else:
        os.environ["EVOL_INTERP_DATA"] = old


@pytest.fixture(scope="session")
def toy(interp_data: Path):
    from evolinterp.adapters.toy import ToyAdapter, ToyConfig

    return ToyAdapter(ToyConfig(train_steps=150, n_eval=512), log=None)


@pytest.fixture(scope="session")
def toy_session(toy):
    from evolinterp.session import InterpSession

    s = InterpSession.open(toy, probes="off", log=None)
    s.train_probes(log=None, max_train=3000)
    return s


@pytest.fixture(scope="session")
def bsrl(interp_data: Path):
    from evolinterp.paths import DEFAULT_BSRL_CKPT, bsrl_code_dir

    if not (bsrl_code_dir() / "policy.py").exists():
        pytest.skip("BeatSaberRL code export missing (python -m evolinterp setup-bsrl)")
    if not DEFAULT_BSRL_CKPT.exists():
        pytest.skip(f"BeatSaberRL checkpoint missing: {DEFAULT_BSRL_CKPT}")
    from evolinterp.adapters.bsrl import BsrlAdapter

    return BsrlAdapter(log=None)
