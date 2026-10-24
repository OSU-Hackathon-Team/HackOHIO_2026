import { Pantry } from "@splice/contracts";
import fs from "node:fs/promises";
import path from "node:path";
import { collectEvidence } from "../evidence/collector.js";
import { saveEvidence } from "../evidence/recorder.js";
import { rea } from "../rea/reaClient.js";
import { REPO_ROOT } from "../config.js";

const pantry = Pantry.parse(JSON.parse(await fs.readFile(path.join(REPO_ROOT, "targets/manifest.json"), "utf8")));
for (const app of pantry.apps.filter((a) => a.live_supported)) {
  for (const f of app.features) {
    const t0 = Date.now();
    const ev = await collectEvidence(app, f, {
      onStage: (s, m) => console.log(`  [${s}] ${m}`),
      onToolCall: (n, tool, a) => console.log(`  → #${n} ${tool} ${a}`),
      onToolResult: (r) => console.log(`  ← #${r.seq} ${r.ok ? "ok" : "FAIL"} ${r.duration_ms}ms ${r.summary}`),
    });
    await saveEvidence(ev);
    console.log(
      `✓ ${f.feature_id}: ${ev.tool_calls.length} calls, ${ev.snippets.length} snippets, ${ev.unknowns.length} unknowns, ${Date.now() - t0}ms\n`,
    );
  }
}
await rea.close();
