"""Causal interventions applied inside the instrumented forwards.

An intervention list is plain JSON so it can travel over the data bus
(``<prefix>.ctl.ablate``) or the CLI. Supported ops:

  {"op": "head",  "layer": 3, "head": 1, "scale": 0}   scale one attention head's output (0 = ablate)
  {"op": "attn",  "layer": 3, "scale": 0}              scale block 3's whole attention write
  {"op": "mlp",   "layer": 3, "scale": 0}              scale block 3's MLP write
  {"op": "block", "key": 7, "query": 0, "layer": 3}    forbid query token 0 from attending key token 7
                                                       (query / layer omitted = all queries / all blocks)

``layer`` is a block index (0..L-1) or a block label "b3". ``scale`` defaults to 0.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any, Iterable

_OPS = {"head", "attn", "mlp", "block"}


class InterventionError(ValueError):
    pass


def _layer(v: Any, n_layers: int | None) -> int | None:
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip().lower()
        if s.startswith("b") and s[1:].isdigit():
            v = int(s[1:])
        elif s.lstrip("-").isdigit():
            v = int(s)
        else:
            raise InterventionError(f"layer {v!r}: use a block index or label like 'b3'")
    if not isinstance(v, int) or isinstance(v, bool):
        raise InterventionError(f"layer must be an int or 'bN', got {v!r}")
    if n_layers is not None and not 0 <= v < n_layers:
        raise InterventionError(f"layer {v} out of range 0..{n_layers - 1}")
    return v


@dataclass(frozen=True)
class Interventions:
    ops: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    @classmethod
    def parse(cls, obj: Any, *, n_layers: int | None = None, n_heads: int | None = None,
              n_tokens: int | None = None) -> "Interventions":
        """Accept None, a JSON string, a single op dict, a list of ops, or {"ops": [...]}."""
        if obj is None or obj == "" or obj is False:
            return cls()
        if isinstance(obj, Interventions):
            return obj
        if isinstance(obj, str):
            try:
                obj = json.loads(obj)
            except json.JSONDecodeError as e:
                raise InterventionError(f"not JSON: {e}") from None
        if isinstance(obj, dict) and "ops" in obj:
            obj = obj["ops"]
        if isinstance(obj, dict):
            obj = [obj]
        if not isinstance(obj, list):
            raise InterventionError("interventions must be a list of {op, ...} objects")
        out = []
        for raw in obj:
            if not isinstance(raw, dict) or raw.get("op") not in _OPS:
                raise InterventionError(f"bad intervention {raw!r}; op must be one of {sorted(_OPS)}")
            op = dict(raw)
            op["layer"] = _layer(op.get("layer"), n_layers)
            if op["op"] in ("head", "attn", "mlp"):
                if op["layer"] is None:
                    raise InterventionError(f"{op['op']} intervention needs a layer")
                try:
                    op["scale"] = float(op.get("scale", 0.0))
                except (TypeError, ValueError):
                    raise InterventionError(f"{op['op']} scale must be a number, got {op.get('scale')!r}") from None
                if not math.isfinite(op["scale"]) or abs(op["scale"]) > 1e6:
                    raise InterventionError(f"{op['op']} scale must be finite and |scale| <= 1e6, got {op['scale']}")
            if op["op"] == "head":
                h = op.get("head")
                if not isinstance(h, int) or (n_heads is not None and not 0 <= h < n_heads):
                    raise InterventionError(f"head {h!r} out of range 0..{(n_heads or 1) - 1}")
            if op["op"] == "block":
                for k in ("key", "query"):
                    t = op.get(k)
                    if t is None and k == "query":
                        continue
                    if not isinstance(t, int) or (n_tokens is not None and not 0 <= t < n_tokens):
                        raise InterventionError(f"block.{k} {t!r} must be a token index 0..{(n_tokens or 1) - 1}")
            out.append(op)
        return cls(tuple(out))

    def __bool__(self) -> bool:
        return bool(self.ops)

    def to_json(self) -> list[dict[str, Any]]:
        return [dict(o) for o in self.ops]

    def key(self) -> str:
        return json.dumps(self.to_json(), sort_keys=True)

    # ----------------------------------------------------------------- queries

    def head_scales(self, layer: int, n_heads: int) -> list[float] | None:
        s = [1.0] * n_heads
        hit = False
        for o in self.ops:
            if o["op"] == "head" and o["layer"] == layer:
                s[o["head"]] *= o["scale"]
                hit = True
        return s if hit else None

    def scale(self, kind: str, layer: int) -> float:
        s = 1.0
        for o in self.ops:
            if o["op"] == kind and o["layer"] == layer:
                s *= o["scale"]
        return s

    def blocked(self, layer: int) -> list[tuple[int | None, int]]:
        """(query or None for all, key) pairs blocked in this block."""
        return [(o.get("query"), o["key"]) for o in self.ops
                if o["op"] == "block" and (o["layer"] is None or o["layer"] == layer)]

    def describe(self, token_labels: Iterable[str] | None = None) -> str:
        labels = list(token_labels) if token_labels is not None else None

        def tok(i: int | None) -> str:
            if i is None:
                return "*"
            return labels[i] if labels and 0 <= i < len(labels) else f"t{i}"

        parts = []
        for o in self.ops:
            sc = "" if o.get("scale", 0.0) == 0.0 else f"x{o['scale']:g}"
            if o["op"] == "head":
                parts.append(f"b{o['layer']}h{o['head']}{sc or ' off'}")
            elif o["op"] in ("attn", "mlp"):
                parts.append(f"b{o['layer']} {o['op']}{sc or ' off'}")
            else:
                where = "all" if o["layer"] is None else f"b{o['layer']}"
                parts.append(f"{tok(o.get('query'))}-/->{tok(o['key'])} @{where}")
        return ", ".join(parts) if parts else "none"
