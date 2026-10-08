# library/test

Node tests for the standard widgets, shared helpers and prefabs (vitest, real three.js).

```
npx vitest run library/test
```

| file | covers |
|---|---|
| `harness.ts` | fake `WidgetContext`: stub UiKit (FakeText mimics troika: fields, `sync()` bounds, `onBeforeRender`), in-memory channels, recorders for emit/setProps/publish/event/askAgent/error, interaction helpers (`press`, `drag`, `interact`), `pickerBounds` (bounds as the runtime picker sees them) |
| `lint.ts` | static definition checks (server rules + library conventions) and prop value validation |
| `build.test.ts` | bundles every widget like the server (esbuild esm, no bare imports) and evaluates it in plain Node |
| `smoke.test.ts` | every widget: defaults, mirror mode, all enum options, junk inputs, stray interactions, clean dispose |
| `controls/display/charts/spatial/gauge.test.ts` | behaviour of each widget |
| `shared.test.ts` | library/shared helpers |
| `prefabs.test.ts` | prefab structure vs widget definitions + simulated link dataflow + layout |
| `billboard-troika.test.ts` | billboarding chains the real troika `Text.prototype.onBeforeRender` (and restores it); text widget renders in every billboard mode; panel/number/slider labels are visible and in front of their card |
| `hardening.test.ts` | regressions from the hardening review: every widget mounted on a channel that already holds a value, state props vs input links across `onProps`, drags across rebuilds, bounded instancing, in-place text/geometry updates |

New widgets are picked up by `build.test.ts` and `smoke.test.ts` automatically
(every directory in `library/widgets/` with a `widget.ts`, resid-flow included; `NOT_OURS`
can exclude a widget another component is building). `prefabs.test.ts` checks every prefab
(resid-lens included); resid-flow's own tests live in `library/widgets/resid-flow/test`.
Writing guide: `library/widgets/README.md`.
