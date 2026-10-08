"""Exit when the process that launched us dies (no orphaned STT servers).

The EvolSpace server supervises this service and kills its whole process tree
on stop/restart. But if the server itself dies hard (crash, killed from Task
Manager), an orphaned STT process would keep port 8790 and ~1 GB of GPU memory,
and every later server start would fail to bind its own copy.

On Windows a uv/venv ``.venv\\Scripts\\python.exe`` is a *launcher* that runs
the real interpreter as a child and waits for it, so our direct parent is that
launcher, which stays alive as long as we do. The process to watch is the
launcher's parent (the Node server). :func:`owner_pid` skips parents whose
image is our own ``sys.executable`` for that reason.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time

log = logging.getLogger("evol_stt")

_IS_WIN = sys.platform == "win32"

if _IS_WIN:
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    _TH32CS_SNAPPROCESS = 0x2
    _INVALID_HANDLE = wintypes.HANDLE(-1).value
    _SYNCHRONIZE = 0x00100000
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    _INFINITE = 0xFFFFFFFF
    _WAIT_TIMEOUT = 0x102

    _k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    _k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    _k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.WaitForSingleObject.restype = wintypes.DWORD
    _k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]

    def _parent_map() -> dict[int, int]:
        """pid -> parent pid for every process (one toolhelp snapshot)."""
        snap = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
        if snap == _INVALID_HANDLE or not snap:
            return {}
        try:
            out: dict[int, int] = {}
            e = _PROCESSENTRY32W()
            e.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
            ok = _k32.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                out[int(e.th32ProcessID)] = int(e.th32ParentProcessID)
                ok = _k32.Process32NextW(snap, ctypes.byref(e))
            return out
        finally:
            _k32.CloseHandle(snap)

    def _image_path(pid: int) -> str | None:
        h = _k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return None
        try:
            buf = ctypes.create_unicode_buffer(32768)
            n = wintypes.DWORD(len(buf))
            if not _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                return None
            return buf.value
        finally:
            _k32.CloseHandle(h)


def _same_file(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def owner_pid() -> int | None:
    """The process that launched us, skipping a venv launcher shim (Windows)."""
    ppid = os.getppid()
    if not _IS_WIN:
        return ppid if ppid > 1 else None
    parents = _parent_map()
    pid = ppid
    # At most a couple of launcher levels (a venv launcher, maybe the py.exe launcher).
    for _ in range(3):
        if not _same_file(_image_path(pid), sys.executable):
            return pid
        nxt = parents.get(pid)
        if not nxt:
            return None  # the launcher's parent is already gone
        pid = nxt
    return pid


def pid_alive(pid: int) -> bool:
    """Best-effort liveness check (used by tests and diagnostics)."""
    if _IS_WIN:
        h = _k32.OpenProcess(_SYNCHRONIZE, False, pid)
        if not h:
            return False
        try:
            return _k32.WaitForSingleObject(h, 0) == _WAIT_TIMEOUT
        finally:
            _k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def watch_parent(on_exit=None, poll_s: float = 2.0) -> int | None:
    """Start a daemon thread that exits the process when the owner process dies.

    Returns the watched pid, or None if there is nothing sensible to watch.
    ``on_exit`` (tests) replaces the default ``os._exit(0)``.
    """
    def die() -> None:
        log.warning("parent process %s exited; shutting down", pid)
        if on_exit is not None:
            on_exit()
            return
        logging.shutdown()
        os._exit(0)

    pid = owner_pid()
    if not pid:
        log.info("parent watchdog: no parent process to watch")
        return None

    if _IS_WIN:
        # Open the handle NOW: it pins this exact process (no pid-reuse confusion).
        handle = _k32.OpenProcess(_SYNCHRONIZE, False, pid)
        if not handle:
            log.info("parent watchdog: cannot open parent %s; not watching", pid)
            return None

        def wait() -> None:
            _k32.WaitForSingleObject(handle, _INFINITE)
            die()
    else:
        def wait() -> None:
            while os.getppid() == pid:
                time.sleep(poll_s)
            die()

    threading.Thread(target=wait, name="parent-watchdog", daemon=True).start()
    log.info("parent watchdog: exiting when process %s exits", pid)
    return pid
