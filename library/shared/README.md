# library/shared

Helpers bundled into widgets that import them relatively
(`import { … } from '../../shared/<module>.ts'`). Pure TypeScript: no runtime
imports of packages (three.js arrives as `ctx.THREE` and is passed in), no
top-level side effects (caches are created lazily on first use). Editing a file
here rebuilds every widget that imports it.

Module index and usage: **`library/widgets/README.md` → "Shared library"**.
Tests: `library/test/shared.test.ts` (`npx vitest run library/test`).

Conventions:
- Functions that run per frame take `out`/scratch objects instead of allocating.
- Anything that creates GPU resources marks shared ones with `userData.evolShared`
  (the runtime never disposes those) - see `resources.ts`.
- Keep modules small and focused; add a test for each new helper.
