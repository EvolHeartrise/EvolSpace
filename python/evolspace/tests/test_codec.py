from __future__ import annotations

import base64
import json
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
import pytest

from evolspace.codec import (
    CodecError,
    decode_json_value,
    decode_tensor_frame,
    encode_tensor_frame,
    tensor_from_json,
    tensor_to_json,
    to_protocol_array,
)

REPO = Path(__file__).resolve().parents[3]


def test_layout_matches_spec() -> None:
    arr = np.arange(6, dtype=np.float32).reshape(2, 3)
    f = encode_tensor_frame("a.b", arr, seq=3, producer="p")
    (hlen,) = struct.unpack_from("<I", f, 0)
    header = json.loads(f[4:4 + hlen])
    assert header == {"channel": "a.b", "seq": 3, "producer": "p", "type": "channel.value", "dtype": "f32", "shape": [2, 3]}
    start = -(-(4 + hlen) // 8) * 8
    assert start % 8 == 0 and set(f[4 + hlen:start]) <= {0}
    assert np.frombuffer(f[start:], "<f4").tolist() == arr.ravel().tolist()


@pytest.mark.parametrize("dtype,np_dtype", [("f32", np.float32), ("f16", np.float16), ("i32", np.int32), ("u32", np.uint32),
                                            ("i16", np.int16), ("u16", np.uint16), ("i8", np.int8), ("u8", np.uint8)])
def test_roundtrip_all_dtypes(dtype: str, np_dtype: type) -> None:
    rng = np.random.default_rng(0)
    arr = (rng.standard_normal((3, 4, 5)) * 50).astype(np_dtype)
    header, out = decode_tensor_frame(encode_tensor_frame("x", arr))
    assert header["dtype"] == dtype and out.shape == arr.shape and out.dtype == np.dtype(np_dtype)
    assert out.flags.writeable
    np.testing.assert_array_equal(out, arr)
    np.testing.assert_array_equal(tensor_from_json(tensor_to_json(arr)), arr)


def test_conversions() -> None:
    assert to_protocol_array(np.zeros(2, np.float64))[0] == "f32"
    assert to_protocol_array(np.zeros(2, np.int64))[0] == "i32"
    assert to_protocol_array(np.array([True, False]))[0] == "u8"
    assert to_protocol_array([[1.0, 2.0]])[0] == "f32"
    assert to_protocol_array(np.zeros(2), "f16")[1].dtype == np.float16
    with pytest.raises(CodecError):
        to_protocol_array(np.array([2**40]))
    with pytest.raises(CodecError):
        to_protocol_array(np.zeros(2, np.complex64))
    # non-contiguous input is made contiguous
    a = np.arange(12, dtype=np.float32).reshape(3, 4).T
    np.testing.assert_array_equal(decode_tensor_frame(encode_tensor_frame("t", a))[1], a)
    # big-endian input is byte-swapped to little endian
    b = np.arange(4, dtype=">f4")
    np.testing.assert_array_equal(decode_tensor_frame(encode_tensor_frame("t", b))[1], b)


def test_malformed_frames() -> None:
    with pytest.raises(CodecError):
        decode_tensor_frame(b"\x01")
    with pytest.raises(CodecError):
        decode_tensor_frame(struct.pack("<I", 100) + b"{}")
    f = bytearray(encode_tensor_frame("x", np.zeros(4, np.float32)))
    with pytest.raises(CodecError):
        decode_tensor_frame(bytes(f[:-1]))


def test_json_value_decoding() -> None:
    arr = np.array([1.5, -2], np.float32)
    assert decode_json_value({"a": 1}) == {"a": 1}
    np.testing.assert_array_equal(decode_json_value(tensor_to_json(arr)), arr)


@pytest.mark.skipif(shutil.which("node") is None or not (REPO / "node_modules" / "tsx").exists(), reason="node + tsx needed")
def test_compatible_with_ts_codec(tmp_path: Path) -> None:
    """Frames are byte-identical to packages/protocol/src/codec.ts in both directions."""
    py_frames = {
        "f32": encode_tensor_frame("py.f32", np.array([[1, 2, 3], [4, 5, 6.5]], np.float32), seq=7, producer="ts"),
        "u8": encode_tensor_frame("py.u8", np.array([0, 1, 2, 254, 255], np.uint8)),
        "f16": encode_tensor_frame("py.f16", np.array([1.0, -2.0, 65504.0], np.float16)),
        "unicode": encode_tensor_frame("py.ünï", np.array([[7]], np.int32)),
        "empty": encode_tensor_frame("py.empty", np.zeros((0, 4), np.float32)),
    }
    inp, out = tmp_path / "in.json", tmp_path / "out.json"
    inp.write_text(json.dumps([base64.b64encode(f).decode() for f in py_frames.values()]))
    script = Path(__file__).with_name("ts_codec_roundtrip.ts")
    r = subprocess.run([shutil.which("node"), str(REPO / "node_modules" / "tsx" / "dist" / "cli.mjs"), str(script), str(inp), str(out)],
                       cwd=REPO, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    res = json.loads(out.read_text(encoding="utf-8"))
    dec = dict(zip(py_frames, res["decoded"]))
    assert dec["f32"]["header"] == {"channel": "py.f32", "seq": 7, "producer": "ts", "type": "channel.value", "dtype": "f32", "shape": [2, 3]}
    assert dec["f32"]["data"] == [1, 2, 3, 4, 5, 6.5]
    assert dec["u8"]["data"] == [0, 1, 2, 254, 255]
    assert dec["f16"]["data"] == [0x3C00, 0xC000, 0x7BFF]  # raw halves in TS
    assert dec["unicode"]["header"]["channel"] == "py.ünï" and dec["unicode"]["data"] == [7]
    assert dec["empty"]["header"]["shape"] == [0, 4] and dec["empty"]["data"] == []
    # TS tensorToJson b64 decodes to the same arrays in Python
    np.testing.assert_array_equal(tensor_from_json(dec["f32"]["json"]), np.array([[1, 2, 3], [4, 5, 6.5]], np.float32))

    made = {k: base64.b64decode(v) for k, v in res["made"].items()}
    # byte-identical encoders
    assert made["f32"] == encode_tensor_frame("ts.f32", np.array([[1, 2, 3], [4, 5, 6.5]], np.float32), seq=7, producer="ts")
    assert made["u8"] == encode_tensor_frame("ts.u8", np.array([0, 1, 2, 254, 255], np.uint8))
    assert made["i16"] == encode_tensor_frame("ts.i16.longer-name_x", np.array([[-32768, -1], [0, 32767]], np.int16))
    assert made["empty"] == encode_tensor_frame("ts.empty", np.zeros((0, 4), np.float32))
    h, a = decode_tensor_frame(made["f16"])
    assert h["dtype"] == "f16" and a.tolist() == [1.0, -2.0, 65504.0]
