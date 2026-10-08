// Operating guide delivered to Claude Code as the MCP server `instructions`.
// Keep it short: it is injected into every session's context.

export function buildInstructions(repoRoot: string): string {
  return `EvolSpace is the user's XR work environment: a Quest 3 (hand tracking + push-to-talk voice) rendering a 3D scene served by the EvolSpace server at ${repoRoot}. These tools control the live space.

Voice requests: when the user speaks to you in the headset, the request arrives as <channel source="evolspace" kind=... target=... target_widget=... target_name=... selected=...>text</channel>. target is the entity they were pointing/looking at ("this"), selected the selected entity; kind="widget" means a widget asked on the user's behalf. Events with simulated="true" are echoes of your own voice_simulate tests: do not act on them. The user is in the headset and cannot see the terminal: answer with the say tool (short, spoken-style), including when you finish or fail. Do what they ask, nothing more.

How things are built: widgets, hand poses, interactions, voice commands, prefabs and data sources are FILES under ${repoRoot}/library (widgets/<id>/widget.ts, poses/*.json, interactions/*.json, voice/commands.json, prefabs/*.json, sources/<id>/source.json). Create/change them with your normal file tools; the server hot-reloads. Contracts (types = spec): packages/protocol/src. Use the tools for live state: scene/spawn/update/remove/link for entities, widgets/widget_info/widget_build for the catalog and build errors, channels/channel_get/channel_set for data, events for client errors and logs, user for where the user is and what they point at.

After creating or changing anything visual, check it: screenshot (view "entity" or "widget"; "user" = what the user sees) and widget_info/events for errors. Space coordinates are meters, Y up; spawn without a position places content in front of the user. If a tool says the server is not running, tell the user how to start it rather than retrying in a loop.`;
}
