# Launch Claude Code in the EvolSpace repo with the evolspace channel enabled, so
# voice requests from the headset arrive in the session as <channel> events.
#
#   pwsh scripts/claude.ps1                    # interactive session
#   pwsh scripts/claude.ps1 --continue         # extra args are passed through to claude
#
# MCP_PROTOCOL_NEGOTIATION=legacy is required: without it the stdio channel server
# negotiates a newer protocol revision and Claude Code silently does not register
# the channel. The server name (server:evolspace) must match the key in .mcp.json.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error 'claude (Claude Code CLI) is not on PATH. Install: npm install -g @anthropic-ai/claude-code'
  exit 1
}

$prev = $env:MCP_PROTOCOL_NEGOTIATION
$env:MCP_PROTOCOL_NEGOTIATION = 'legacy'
Push-Location $root
try {
  & claude --dangerously-load-development-channels server:evolspace @args
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  $env:MCP_PROTOCOL_NEGOTIATION = $prev
}
exit $code
