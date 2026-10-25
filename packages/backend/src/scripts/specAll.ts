// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/06_testing_and_acceptance.md §1
import { loadPantry } from "../routes/step1/index.js";
import { loadRecordedEvidence } from "../evidence/replay.js";
import { buildSpec } from "../spec/buildSpec.js";
import { saveSpec } from "../spec/store.js";

const pantry = await loadPantry();
const rows: Array<{
  feature: string;
  status: string;
  reqs: number;
  oracle: string;
  repairs: number;
  seconds: string;
}> = [];

for (const app of pantry.apps) {
  for (const feature of app.features) {
    const ev = await loadRecordedEvidence(feature.feature_id);
    if (!ev) {
      console.warn(`[spec:all] Skipping ${feature.feature_id}: no evidence recorded`);
      continue;
    }
    const t0 = Date.now();
    try {
      console.log(`\n--- Processing ${feature.feature_id} ---`);
      const spec = await buildSpec({ ...ev, mode: "live" }, app, feature, {
        onStage: (s, m) => console.log(`[${s}] ${m}`),
        onProgress: () => {},
        onTestResult: (t) => console.log(`  ${t.passed ? "✓" : "✗"} ${t.name}${t.error ? "  — " + t.error : ""}`),
      });
      await saveSpec(spec);
      rows.push({
        feature: feature.feature_id,
        status: spec.status.toUpperCase(),
        reqs: spec.requirements.length,
        oracle: `${spec.oracle.passed}/${spec.oracle.total}`,
        repairs: spec.repair_attempts,
        seconds: ((Date.now() - t0) / 1000).toFixed(1),
      });
    } catch (e) {
      console.error(`[spec:all] Failed ${feature.feature_id}:`, (e as Error).message);
      rows.push({
        feature: feature.feature_id,
        status: "FAILED",
        reqs: 0,
        oracle: "0/0",
        repairs: 0,
        seconds: ((Date.now() - t0) / 1000).toFixed(1),
      });
    }
  }
}

console.log("\n=== SPEC:ALL SUMMARY TABLE ===");
console.table(rows);
