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
    const ev = await collectEvidence(app, f, {
      onStage() {},
      onToolCall() {},
      onToolResult() {},
    });
    for (const sym of f.symbols) {
      assert.ok(
        ev.snippets.some((s) => s.code.includes(sym)),
        `${f.feature_id}: ${sym} not located`,
      );
    }
    assert.ok(
      ev.tool_calls.every((c) => c.ok || c.tool === "trace_javascript_semantics"),
      "required call failed",
    );
    await saveEvidence(ev);
    rows.push(
      `${f.feature_id.padEnd(28)} calls=${ev.tool_calls.length} snippets=${ev.snippets.length} unknowns=${ev.unknowns.length} ${Date.now() - t0}ms`,
    );
  }
}
console.table(rows);
await rea.close();
process.exit(0);
