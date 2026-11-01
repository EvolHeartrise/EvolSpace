# evolspace - Python SDK

Drive EvolSpace from Python: publish/read data channels (JSON and binary
tensors), subscribe to channels over WebSocket, apply scene ops, talk to the
user, take screenshots and follow server events. It is a thin, typed wrapper
over the server's HTTP API (`packages/protocol/src/api.ts`) and WS protocol
(`messages.ts`); tensor frames are byte-identical to `codec.ts`.

Dependencies: `numpy`, `websockets` (HTTP uses the stdlib).

```python
import numpy as np
from evolspace import Client

evol = Client()                       # $EVOL_URL (set for supervised sources) or http://127.0.0.1:8787
evol.publish("demo.wave", np.sin(np.linspace(0, 6.28, 64)))   # ndarray -> binary f32 tensor frame
evol.publish("demo.label", {"text": "hello"})                 # anything else -> JSON
evol.get("demo.wave")                 # -> np.ndarray (float32); evol.get("x", default=None) for optional

# subscriptions run on a background thread and reconnect automatically
def on_value(channel, value, seq):
    print(channel, value)
with evol.subscribe(["interp.ctl.*"], on_value) as sub:
    sub.wait("interp.ctl.layer", timeout=5)   # current values are delivered right after subscribing
    sub.publish("demo.fast", np.zeros(3))    # publish over the socket (fire-and-forget, never echoed back)

# scene
box = evol.scene.spawn("box", name="demo", position=[0, 1.4, -1], scale=0.2, props={"color": "#4af"})
evol.scene.update(box, props={"color": "#f84"}, position=[0.2, 1.4, -1])
evol.scene.link("channel:demo.level", f"{box}:value", transform="x * 2")   # or PortRef dicts
evol.scene.summary(); evol.scene.find(widget="box"); evol.scene.remove(box)
evol.scene.instantiate("resid-lens", position=[0, 1.3, -1.2])

# agent I/O, system
evol.say("Done - the lens is on your left.")       # text panel in XR (kind: reply|info|error|heard)
evol.set_status("working", "running probes"); evol.status()
evol.screenshot("user", "data/shots/now.png")       # or an entity id, or a ScreenshotView dict
evol.command("undo"); evol.sources(); evol.source("interp-bsrl", "restart")
for e in evol.iter_events(["agent.ask", "widget.event"]): ...   # long-poll forever
```

## Behaviour worth knowing

- **Dtypes**: protocol dtypes are `f32 f16 i32 u32 i16 u16 i8 u8`. Without an
  explicit `dtype=`, float64 is sent as f32, int64 as i32 (range-checked), bool
  as u8. `publish(..., dtype="f16")` halves bandwidth. Torch tensors are accepted.
  Decoded arrays are little-endian, writable and own their memory.
- **Errors**: HTTP errors raise `EvolError(status, message)` (`NotFound` for
  404); an unreachable server raises `EvolError` with `status == 0`. Stale
  keep-alive sockets are retried once transparently (never after a timeout).
- **Threads**: one `Client` is safe to share. Each request borrows a
  connection from a small keep-alive pool (up to 4 idle), so a long-poll
  (`iter_events`) on one thread never blocks publishes on another.
  Subscription callbacks run on the subscription's thread; keep them short
  or hand work to your own thread.
- **JSON values**: numpy scalars/arrays inside JSON values are converted (HTTP
  and WS publish alike); NaN/Infinity raise `ValueError` (the bus is strict JSON).
  `producer` / `description` are sent URL-encoded in the query string, so
  non-ASCII descriptions work.
- **WS publish vs HTTP publish**: `Client.publish` (HTTP) reports errors;
  `Subscription.publish` is cheaper and the server never echoes it back to the
  same connection (useful for a process that both drives and watches a
  control channel).
- `Client(url, ws_url=...)` overrides the derived `ws://host:port/ws`.

## Tests

The SDK has its own venv (`uv sync` in this folder, Python 3.12; the
`python/evolinterp` venv also installs it editable):

```
cd python/evolspace
uv sync
.venv/bin/python -m pytest -q              # (.venv/Scripts/python on Windows)
```

- `tests/test_codec.py` - frame layout, all dtypes, malformed frames, and a
  cross-language check that runs `tests/ts_codec_roundtrip.ts` with the repo's
  tsx: Python frames decode in `codec.ts` and TS frames are byte-identical to
  Python's.
- `tests/test_client.py` - everything against `tests/fake_server.py`, an
  in-process fake of the server (HTTP + WS, no-echo semantics, reconnects).
- `tests/test_real_server.py` - the real Node server, started on a random port
  with a temp data dir (`tests/server_proc.py`; skipped if it cannot boot). Set
  `EVOL_TEST_URL=http://127.0.0.1:8787` to target a running server instead
  (touches only `test.sdk.*` channels and one tagged entity).
