#!/usr/bin/env bash
# Launch Claude Code in the EvolSpace repo with the evolspace channel enabled, so
# voice requests from the headset arrive in the session as <channel> events.
#
#   scripts/claude.sh               # interactive session
#   scripts/claude.sh --continue    # extra args are passed through to claude
#
# MCP_PROTOCOL_NEGOTIATION=legacy is required: without it the stdio channel server
# negotiates a newer protocol revision and Claude Code silently does not register
# the channel. The server name (server:evolspace) must match the key in .mcp.json.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v claude >/dev/null 2>&1; then
  echo "claude (Claude Code CLI) is not on PATH. Install: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi
cd "$root"
export MCP_PROTOCOL_NEGOTIATION=legacy
exec claude --dangerously-load-development-channels server:evolspace "$@"
