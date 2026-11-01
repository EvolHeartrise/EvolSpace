# EvolSpace

An XR work environment for a Quest 3, driven by Claude Code. A WebXR client with hand
tracking and voice renders a scene described by a server on the PC. Claude Code controls
the space through an MCP bridge, and can wire anything on the machine into 3D widgets
through data channels.

## What it does

- **Interpretability in 3D:** visualizes transformer internals, with activation capture,
  probes and SAEs in `python/evolinterp`.
- **Agent-authored widgets:** a widget library that is watched and compiled with esbuild,
  so the agent can build new views while you use them.
- **Hand and voice input:** pose matching, an interaction engine for grabbing and scaling,
  and push-to-talk speech-to-text through faster-whisper.
- **Agent feedback:** a headless Chromium mirror gives the agent screenshots of the scene.

## Architecture

```
Quest 3 browser (apps/client)  <-- WebSocket -->  apps/server (Node, TypeScript)
                                                    scene authority, undo, widget compiler,
                                                    data bus, voice routing, headless mirror
Claude Code  <-->  apps/mcp-bridge (stdio MCP)  <-- HTTP/WS -->  apps/server
python/stt, python/evolspace, python/evolinterp  <-- HTTP/WS -->  apps/server
```

Contracts live in `packages/protocol/src`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
full design.

## Development

```sh
npm install
npm run dev        # start the server
npm test           # vitest
npm run typecheck
```
