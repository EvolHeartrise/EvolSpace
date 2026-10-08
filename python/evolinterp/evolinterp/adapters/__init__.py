"""Model adapters: ``make_adapter("bsrl" | "toy", checkpoint=..., dataset=...)``."""

from __future__ import annotations

from typing import Any

from .base import Adapter, Capture, ProbeTarget, TokenInfo

MODELS = ("bsrl", "toy")


def make_adapter(model: str, checkpoint: str | None = None, *, dataset: str | None = None, log: Any = print) -> Adapter:
    if model == "toy":
        from .toy import ToyAdapter
        return ToyAdapter(checkpoint=checkpoint, log=log)
    if model == "bsrl":
        from .bsrl import BsrlAdapter
        return BsrlAdapter(checkpoint, dataset=dataset, log=log)
    raise ValueError(f"unknown model {model!r} (use one of {', '.join(MODELS)})")


__all__ = ["Adapter", "Capture", "ProbeTarget", "TokenInfo", "make_adapter", "MODELS"]
