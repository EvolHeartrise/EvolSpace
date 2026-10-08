from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Iterator

import pytest

from evolspace import Client

sys.path.insert(0, str(Path(__file__).parent))
from fake_server import FakeEvol  # noqa: E402
from server_proc import start_server  # noqa: E402


@pytest.fixture()
def fake() -> Iterator[FakeEvol]:
    f = FakeEvol()
    try:
        yield f
    finally:
        f.close()


@pytest.fixture()
def client(fake: FakeEvol) -> Iterator[Client]:
    c = Client(fake.url, ws_url=fake.ws_url, producer="pytest")
    try:
        yield c
    finally:
        c.close()


@pytest.fixture(scope="session")
def real_server() -> Iterator[str]:
    """The real Node server on a random port with a temp data dir.

    EVOL_TEST_URL targets an already-running server instead (tests only touch
    channels under ``test.sdk.*``). Skips when node / the repo's node_modules are
    missing or the server does not come up (it may be mid-rewrite by another agent).
    """
    if os.environ.get("EVOL_TEST_URL"):
        yield os.environ["EVOL_TEST_URL"]
        return
    sp = start_server()
    if isinstance(sp, str):
        pytest.skip(sp)
    try:
        yield sp.url
    finally:
        sp.stop()
