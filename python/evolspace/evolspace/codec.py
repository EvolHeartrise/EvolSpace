"""Binary tensor frames and JSON tensor forms, byte-compatible with
packages/protocol/src/codec.ts.

Tensor frame layout (WebSocket binary messages and HTTP bodies with
Content-Type application/x-evol-tensor)::

    bytes 0..3   : u32 LE = header length H
    bytes 4..4+H : UTF-8 JSON header {type:'channel.value', channel, dtype, shape, seq?, producer?}
    zero padding to the next multiple of 8
    remaining    : raw little-endian, row-major tensor data

DType names follow data.ts: f32 f16 i32 u32 i16 u16 i8 u8.
"""

from __future__ import annotations

import base64
import json
import struct
from typing import Any

import numpy as np

TENSOR_MIME = "application/x-evol-tensor"
AUDIO_FRAME_MAGIC = b"AUD0"

#: protocol dtype name -> little-endian numpy dtype
DTYPES: dict[str, np.dtype] = {
    "f32": np.dtype("<f4"),
    "f16": np.dtype("<f2"),
    "i32": np.dtype("<i4"),
    "u32": np.dtype("<u4"),
    "i16": np.dtype("<i2"),
    "u16": np.dtype("<u2"),
    "i8": np.dtype("i1"),
    "u8": np.dtype("u1"),
}
DTYPE_BYTES = {k: v.itemsize for k, v in DTYPES.items()}

# numpy kinds that have a lossless protocol dtype
_NATIVE = {(np.dtype(v).kind, np.dtype(v).itemsize): k for k, v in DTYPES.items()}


class CodecError(ValueError):
    """Malformed frame or a value that cannot be expressed as a protocol tensor."""


def is_tensor_like(value: Any) -> bool:
    """True for values the SDK publishes as binary tensors (numpy arrays, torch tensors)."""
    if isinstance(value, np.ndarray):
        return True
    mod = type(value).__module__
    return mod.startswith("torch") and hasattr(value, "detach") and hasattr(value, "numpy")


def to_protocol_array(value: Any, dtype: str | None = None) -> tuple[str, np.ndarray]:
    """Convert an array-like to (protocol dtype, contiguous little-endian ndarray).

    Without an explicit ``dtype``: float64 -> f32 (the interp/widget world is f32),
    int64 -> i32 and uint64 -> u32 (range-checked), bool -> u8; other numpy dtypes
    map 1:1. ``dtype`` forces a cast (e.g. ``'f16'`` to halve bandwidth).
    """
    if not isinstance(value, np.ndarray):
        if hasattr(value, "detach"):  # torch tensor
            value = value.detach().cpu().numpy()
        else:
            value = np.asarray(value)
    arr = value
    if dtype is None:
        if arr.dtype == np.bool_:
            dtype = "u8"
        elif arr.dtype.kind == "f" and arr.dtype.itemsize == 8:
            dtype = "f32"
        elif arr.dtype.kind in "iu" and arr.dtype.itemsize == 8:
            dtype = "i32" if arr.dtype.kind == "i" else "u32"
            info = np.iinfo(DTYPES[dtype])
            if arr.size and (arr.min() < info.min or arr.max() > info.max):
                raise CodecError(f"{arr.dtype} values out of {dtype} range; cast explicitly")
        else:
            dtype = _NATIVE.get((arr.dtype.kind, arr.dtype.itemsize))
            if dtype is None:
                raise CodecError(f"numpy dtype {arr.dtype} has no protocol dtype (use one of {', '.join(DTYPES)})")
    if dtype not in DTYPES:
        raise CodecError(f"unknown dtype {dtype!r} (use one of {', '.join(DTYPES)})")
    out = np.ascontiguousarray(arr, dtype=DTYPES[dtype])
    return dtype, out


def encode_tensor_frame(channel: str, value: Any, *, dtype: str | None = None,
                        seq: int | None = None, producer: str | None = None) -> bytes:
    """Encode a channel value as a binary tensor frame (see module docstring)."""
    dt, arr = to_protocol_array(value, dtype)
    header: dict[str, Any] = {"channel": channel}
    if seq is not None:
        header["seq"] = int(seq)
    if producer is not None:
        header["producer"] = producer
    # Same key order as codec.ts: {...header, type, dtype, shape}
    header.update({"type": "channel.value", "dtype": dt, "shape": [int(n) for n in arr.shape]})
    head = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    data_start = -(-(4 + len(head)) // 8) * 8
    pad = data_start - 4 - len(head)
    return b"".join((struct.pack("<I", len(head)), head, b"\0" * pad, arr.tobytes(order="C")))


def decode_tensor_frame(frame: bytes | bytearray | memoryview) -> tuple[dict[str, Any], np.ndarray]:
    """Decode a binary tensor frame -> (header dict, ndarray). The array owns its memory."""
    buf = memoryview(frame).cast("B")
    if len(buf) < 4:
        raise CodecError("frame shorter than its 4-byte header length")
    (hlen,) = struct.unpack_from("<I", buf, 0)
    if 4 + hlen > len(buf):
        raise CodecError(f"header length {hlen} exceeds frame size {len(buf)}")
    try:
        header = json.loads(bytes(buf[4:4 + hlen]).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise CodecError(f"bad frame header: {e}") from None
    dt = header.get("dtype")
    shape = header.get("shape")
    if (dt not in DTYPES or not isinstance(shape, list)
            or not all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in shape)):
        raise CodecError(f"bad frame header dtype/shape: {header!r}")
    data_start = -(-(4 + hlen) // 8) * 8
    n = int(np.prod(shape, dtype=np.int64)) if shape else 1
    nbytes = n * DTYPE_BYTES[dt]
    body = buf[data_start:data_start + nbytes]
    if len(body) != nbytes:
        raise CodecError(f"frame carries {len(body)} data bytes but {dt}{shape} needs {nbytes}")
    arr = np.frombuffer(bytearray(body), dtype=DTYPES[dt]).reshape(shape)  # writable, owns its memory
    return header, arr


def tensor_to_json(value: Any, dtype: str | None = None) -> dict[str, Any]:
    """JSON-safe tensor form {$tensor, dtype, shape, b64} (as used by SSE / ?format=json)."""
    dt, arr = to_protocol_array(value, dtype)
    return {"$tensor": True, "dtype": dt, "shape": list(arr.shape), "b64": base64.b64encode(arr.tobytes()).decode("ascii")}


def tensor_from_json(obj: dict[str, Any]) -> np.ndarray:
    dt = obj.get("dtype")
    if dt not in DTYPES:
        raise CodecError(f"unknown dtype {dt!r}")
    raw = base64.b64decode(obj["b64"])
    return np.frombuffer(raw, dtype=DTYPES[dt]).reshape(obj["shape"]).copy()


def is_json_tensor(value: Any) -> bool:
    return isinstance(value, dict) and value.get("$tensor") is True and "b64" in value


def decode_json_value(value: Any) -> Any:
    """Turn a JSON channel value into Python, decoding {$tensor, b64} forms to ndarrays."""
    return tensor_from_json(value) if is_json_tensor(value) else value


def jsonable(v: Any) -> Any:
    """Make numpy scalars/arrays JSON-serializable (arrays become nested lists)."""
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


def is_audio_frame(frame: bytes | bytearray | memoryview) -> bool:
    b = bytes(memoryview(frame)[:4])
    return len(memoryview(frame)) >= 40 and b == AUDIO_FRAME_MAGIC
