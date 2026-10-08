# library/prefabs

A prefab is a reusable group of entities + links (`Prefab` in
`packages/protocol/src/scene.ts`): `library/prefabs/<id>.json`. Instantiate with the
`prefab` MCP tool or `POST /api/prefabs/<id>/instantiate {transform?, parent?, props?}`;
every prefab-local id is remapped to a fresh entity id, `parent`s and port links are
remapped, channel ends are kept as written, `props` overrides are keyed by local id.

```json
{
  "description": "What it is, which local ids to override, which channels it uses.",
  "entities": [
    { "id": "slider", "parent": null, "widget": "slider", "props": { "label": "Gain" },
      "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] }, "visible": true },
    { "id": "readout", "parent": "slider", "widget": "number", "props": {},
      "transform": { "position": [0.22, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] }, "visible": true }
  ],
  "links": [
    { "from": { "kind": "port", "entity": "slider", "port": "value" }, "to": { "kind": "port", "entity": "readout", "port": "value" } },
    { "from": { "kind": "port", "entity": "slider", "port": "value" }, "to": { "kind": "channel", "channel": "ui.gain" }, "transform": "Math.round(x * 100) / 100" }
  ]
}
```

Tips: parent children to one root so grabbing the root moves everything; put children
~4 mm in front of a parent card (`z: 0.004`); keep channel names dot-separated.
Sliders don't emit on create: give a slider `"emitOnCreate": true` only when a local consumer
needs its initial value (read-out) or it is the only writer of its channel. Channel→port links
with a transform that returns `undefined` for incomplete data act as filters
(`"x && x.sample ? x.sample.total - 1 : undefined"`).

| prefab | contents |
|---|---|
| `slider-number` | slider (`slider`) with a `number` read-out (`readout`) as its child; port→port link |
| `control-panel` | `panel` + sliders `gain`, `threshold`, toggle `enabled`, button `reset`; port→channel links to `ui.control.{gain,threshold,enabled,reset}`; port→port links with constant transforms make Reset restore the sliders. Sliders set `emitOnCreate` (sole writers of their channels) |
| `resid-lens` | `resid-flow` (`resid`) + vertical `layer-slider` + `sample-slider`; slider ranges from `#interp.meta` (channel→port links with transforms), `commit` → `interp.ctl.*`, `interp.ctl.*` → slider `value`. Sliders never emit on create, so loading the scene never overwrites the producer's state. Details: `library/widgets/resid-flow/README.md` |

`library/test/prefabs.test.ts` validates every prefab here against the widget
definitions and simulates its links.
