# Demo mode (`?mode=demo`)

A frontend-only walkthrough of the Obsidian + LibreOffice Calc recombination. The pipeline is
scripted from recorded run 2 (`docs/obsidian-calc-demo-run2-gap-log.md`); the finished notes app runs
live on the run-2 engines. No backend, AWS or model calls.

`engines/` holds byte-identical copies of the run-2 export's package sources
(`obsidian-calc-demo-run2.zip`, plan `49717df1…`). `tests/demo.test.ts` pins their SHA-256 to that
export's `splice.lock.json`; do not edit them.

| File | Package | `src/index.ts` sha256 |
|---|---|---|
| `engines/obsidianRenderer.ts` | `splice.obsidian.editor` (`pkg_9391603c…`) | `2b96666b…2481` |
| `engines/calcTables.ts` | `splice.calc.tables` (`pkg_1bba6dac…`) | `d7f40aa5…16a5` |

Pacing: `?speed=4` runs the scripted pipeline four times faster.
