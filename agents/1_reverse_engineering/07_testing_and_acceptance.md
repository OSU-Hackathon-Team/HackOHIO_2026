# 07 — Testing & Acceptance (Step 1)

Each script runs on its own from `packages/backend`. "Done" means the script passes on a clean
clone, on at least two teammates' machines (one of them Windows).

## 1. `src/scripts/testBridge.ts` — `npm run test:bridge`

```ts
import assert from "node:assert/strict";
import path from "node:path";
import { rea } from "../rea/reaClient.js";
import { reaArgs, checkArgsAgainstCatalog } from "../rea/reaArgs.js";
import { REPO_ROOT } from "../config.js";

const t0 = Date.now();
await rea.start();
const tools = await rea.listTools();
console.log(`✓ connected in ${Date.now() - t0}ms, ${tools.length} tools, server ${rea.serverVersion}`);
assert.ok(tools.length > 10, "expected the full REA catalog");
assert.deepEqual(checkArgsAgainstCatalog(tools as any), [], "reaArgs.ts disagrees with tools.json");

const session = await rea.call("binary_session", {});
assert.ok(session.ok, "binary_session failed");
console.log("✓ binary_session:", session.summary);

const target = path.join(REPO_ROOT, "targets/build/inkwell/app.asar");
const a = await rea.call("analyze_javascript_application", reaArgs.analyzeApp(target));
assert.ok(a.ok, `analyze failed: ${a.summary}`);
assert.match(a.parentEvidenceId ?? "", /^ev_[0-9a-f]{64}$/, "summary reply must name the retained analysis");
console.log("✓ analyze:", a.summary, a.parentEvidenceId);

const t = await rea.call("trace_application_feature", reaArgs.traceFeature(a.parentEvidenceId!, { kind: "module", value: "src/graph/backlinks.js" }));
assert.ok(t.ok, `trace failed: ${t.summary}`);
console.log("✓ trace:", t.summary);

await rea.close();
console.log(`=== bridge OK in ${Date.now() - t0}ms ===`);
process.exit(0);
```

## 2. `src/scripts/testCollector.ts` — `npm run test:collector [feature_id]`

```ts
import assert from "node:assert/strict";
import { collectEvidence } from "../evidence/collector.js";
import { saveEvidence } from "../evidence/recorder.js";
import { loadPantry } from "../routes/step1/index.js";
import { rea } from "../rea/reaClient.js";

const only = process.argv[2];
const pantry = await loadPantry();
const rows: string[] = [];
for (const app of pantry.apps.filter((a) => a.live_supported)) {
  for (const f of app.features.filter((f) => !only || f.feature_id === only)) {
    const t0 = Date.now();
    const ev = await collectEvidence(app, f, { onStage() {}, onToolCall() {}, onToolResult() {} });
    for (const sym of f.symbols) assert.ok(ev.snippets.some((s) => s.code.includes(sym)), `${f.feature_id}: ${sym} not located`);
    assert.ok(ev.tool_calls.every((c) => c.ok || c.tool === "trace_javascript_semantics"), "required call failed");
    await saveEvidence(ev);
    rows.push(`${f.feature_id.padEnd(28)} calls=${ev.tool_calls.length} snippets=${ev.snippets.length} unknowns=${ev.unknowns.length} ${Date.now() - t0}ms`);
  }
}
console.table(rows);
await rea.close();
process.exit(0);
```

## 3. Unit tests — `npm run test:unit`

`src/rea/normalize.test.ts` runs against the real sample results saved at H1:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalize } from "./normalize.js";
import { REPO_ROOT } from "../config.js";

const sample = (tool: string) =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, `fixtures/rea/sample_${tool}.json`), "utf8"));

test("analyze result yields evidence id and summary", () => {
  const n = normalize("analyze_javascript_application", sample("analyze_javascript_application"));
  assert.ok(n.ok);
  assert.match(n.evidenceId!, /^ev_/);
  assert.ok(n.summary.length > 0 && n.summary.length <= 300);
});

test("error results are not ok and summarize the message", () => {
  const n = normalize("x", { content: [{ type: "text", text: "boom" }], isError: true } as any);
  assert.equal(n.ok, false);
  assert.match(n.summary, /boom/);
});
```

Also test `rankPaths`/`pathsMentioned` (export them for tests) with a fake archive list:
backslash paths, leading slashes, `./` relative requires, and `../` relative requires.

## 4. Step 1 acceptance gate (CP1 at H8, re-checked at CP2)

- [x] Catalog dumped to `fixtures/rea/tools.json` and the verified-arguments table in 03 filled in (2026-10-24)
- [ ] No `// VERIFY` left in `reaArgs.ts` (only `traceSemantics` / `inspectView` remain)
- [ ] `npm run test:bridge` passes; no orphaned REA/node processes afterwards (check on Windows)
- [ ] `npm run test:collector` passes for all 4 features; every `symbols` entry is located
- [ ] Warm collection takes < 15 s per feature
- [ ] `fixtures/evidence/<feature_id>.json` golden files exist for all 4 features and are committed; `_seed/` deleted at CP2
- [ ] `GET /api/health` shows `rea.connected: true` within 10 s of boot
- [ ] `GET /api/pantry` returns the manifest; a missing target flips `live_supported` to false
- [ ] Killing the REA child mid-run produces an `error` event, and `auto` mode replays recorded evidence (verified with Eng 2's `/api/extract`)
