// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/06_testing_and_acceptance.md §1
import { loadPantry } from "../routes/step1/index.js";
import { loadRecordedEvidence } from "../evidence/replay.js";
import { buildSpec } from "../spec/buildSpec.js";
import { saveSpec } from "../spec/store.js";

const featureId = process.argv[2] ?? "recall.sm2_scheduler";
const pantry = await loadPantry();
const app = pantry.apps.find((a) => a.features.some((f) => f.feature_id === featureId));
if (!app) throw new Error(`App not found for feature ${featureId}`);
const feature = app.features.find((f) => f.feature_id === featureId);
if (!feature) throw new Error(`Feature ${featureId} not found`);
const ev = await loadRecordedEvidence(featureId);
if (!ev) throw new Error(`no evidence for ${featureId} (run npm run seed:evidence)`);

const t0 = Date.now();
const spec = await buildSpec({ ...ev, mode: "live" }, app, feature, {
  onStage: (s, m) => console.log(`[${s}] ${m}`),
  onProgress: () => {},
  onTestResult: (t) => console.log(`  ${t.passed ? "✓" : "✗"} ${t.name}${t.error ? "  — " + t.error : ""}`),
});

console.log(
  `\n${spec.consumer_title} — ${spec.status.toUpperCase()} in ${Date.now() - t0}ms, ${spec.repair_attempts} repair(s), model ${spec.provenance.model}`,
);
console.table(
  spec.requirements.map((r) => ({
    id: r.id,
    kind: r.kind,
    statement: r.statement.slice(0, 90),
    refs: r.source_refs.join(" "),
  })),
);
console.log(
  "interface:",
  spec.interface.exports.map((e) => `${e.name}${e.kind === "function" ? e.signature : ""}`).join("\n           "),
);
console.log("oracle:", spec.oracle.status, `${spec.oracle.passed}/${spec.oracle.total}`);
console.log("stripped glue:", spec.stripped_glue.join("; "));
if (spec.open_issues.length) console.log("OPEN ISSUES:\n - " + spec.open_issues.join("\n - "));
await saveSpec(spec);
