# Fonts

These fonts are served by the client at `/fonts/` and used by
`@evolspace/runtime` through troika-three-text. Never load fonts from a CDN:
the headset may be offline or on a LAN.

| File | Source | License |
|---|---|---|
| `Inter-Regular.ttf`, `Inter-SemiBold.ttf` | rsms/inter release v4.1 (`Inter-4.1.zip`, `extras/ttf/`) | SIL OFL 1.1 (`Inter-LICENSE.txt`) |
| `JetBrainsMono-Regular.ttf` | JetBrains/JetBrainsMono release v2.304 (`fonts/ttf/`) | SIL OFL 1.1 (`JetBrainsMono-LICENSE.txt`) |

These are TTF rather than WOFF2 because troika parses TTF/OTF/WOFF natively.
`packages/runtime/test/fonts.test.ts` checks that the files are valid
TrueType fonts with the expected family names.

The runtime maps text onto these fonts' glyph coverage before handing it to
troika; otherwise troika would fetch fallback fonts from a CDN for missing
characters, and offline the text would never render. The coverage tables in
`packages/runtime/src/ui/glyphCoverage.ts` are generated from the fonts. After
replacing a font, run `node packages/runtime/scripts/gen-glyph-coverage.mjs`.
The fonts test fails if the tables are stale.
