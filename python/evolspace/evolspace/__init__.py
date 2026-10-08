"""EvolSpace Python SDK: channels (JSON + binary tensors), scene ops and agent I/O.

See README.md. Contracts: packages/protocol/src/{api,data,codec,messages,scene}.ts.
"""

from .client import Client, Scene, default_url, port_ref
from .codec import (
    DTYPES,
    TENSOR_MIME,
    CodecError,
    decode_tensor_frame,
    encode_tensor_frame,
    tensor_from_json,
    tensor_to_json,
)
from .transport import EvolError, NotFound
from .ws import Subscription

__version__ = "0.1.0"

__all__ = [
    "Client", "Scene", "Subscription", "EvolError", "NotFound", "CodecError",
    "DTYPES", "TENSOR_MIME", "encode_tensor_frame", "decode_tensor_frame",
    "tensor_to_json", "tensor_from_json", "default_url", "port_ref", "__version__",
]
