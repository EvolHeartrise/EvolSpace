"""Parent watchdog: the service must not outlive the process that launched it."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

from evol_stt.watchdog import owner_pid, pid_alive

ROOT = Path(__file__).resolve().parents[1]


def test_owner_pid_skips_the_venv_launcher():
    # Under a venv launcher our direct parent runs sys.executable; the owner must be
    # something else (pytest's own launcher parent: a shell, uv, node, ...).
    pid = owner_pid()
    assert pid is not None and pid != os.getpid()
    assert pid_alive(pid)


def test_child_exits_when_its_owner_is_killed():
    # owner (python) -> [venv launcher ->] child running watch_parent(); kill the
    # owner alone (not its tree) and the child must exit on its own.
    child_code = textwrap.dedent(
        """
        import sys, time
        from evol_stt.watchdog import watch_parent
        print(watch_parent(), flush=True)
        time.sleep(30)
        """
    )
    owner_code = textwrap.dedent(
        f"""
        import os, subprocess, sys, time
        c = subprocess.Popen([sys.executable, "-c", {child_code!r}], stdout=subprocess.PIPE, text=True)
        watched = c.stdout.readline().strip()
        print(os.getpid(), c.pid, watched, flush=True)
        time.sleep(30)
        """
    )
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    owner = subprocess.Popen([sys.executable, "-c", owner_code], stdout=subprocess.PIPE, text=True, env=env, cwd=ROOT)
    try:
        line = owner.stdout.readline().split()
        assert len(line) == 3, line
        owner_real, child_launcher, watched = (int(x) if x.isdigit() else x for x in line)
        assert watched == owner_real  # the launcher shim was skipped
        os.kill(owner_real, signal.SIGTERM)  # TerminateProcess on Windows: no tree kill
        deadline = time.time() + 10
        while pid_alive(child_launcher) and time.time() < deadline:
            time.sleep(0.1)
        assert not pid_alive(child_launcher), "child outlived its owner"
    finally:
        owner.kill()
        owner.wait(10)
