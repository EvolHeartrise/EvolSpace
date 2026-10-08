"""Make the CUDA 12 runtime DLLs from the nvidia-* wheels visible to CTranslate2.

CTranslate2's Windows wheel bundles cuDNN but links cuBLAS 12 dynamically. The
``nvidia-cublas-cu12`` / ``nvidia-cudnn-cu12`` wheels drop their DLLs into
``site-packages/nvidia/<lib>/bin``, which is not on the DLL search path. Call
:func:`register_cuda_dlls` before the first ``import ctranslate2``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_done = False


def register_cuda_dlls() -> list[str]:
    """Add nvidia/*/bin folders to the DLL search path (Windows only). Idempotent."""
    global _done
    if _done or sys.platform != "win32":
        return []
    _done = True
    added: list[str] = []
    for entry in sys.path:
        root = Path(entry) / "nvidia"
        if not root.is_dir():
            continue
        for lib in sorted(root.iterdir()):
            bin_dir = lib / "bin"
            if bin_dir.is_dir():
                os.add_dll_directory(str(bin_dir))
                # Some CUDA libraries load their siblings via PATH rather than the
                # process DLL directories, so prepend there too.
                os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
                added.append(str(bin_dir))
    return added
