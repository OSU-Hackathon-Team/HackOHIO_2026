// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/01_engine_implementation.md §7
// npm run test:implement -w @splice/backend [feature_id]
// Implements an engine from each golden spec (fixtures/specs/<id>.json, else _seed/) and prints the
// verification. Exit 1 if any engine fails or upstream helpers aren't wired yet.
import fs from "node:fs/promises";
import path from "node:path";
import { FeatureSpec } from "@splice/contracts";
import { implementEngine } from "../engine/implement.js";
import { MISSING_UPSTREAM, REPO_ROOT, step3Deps } from "../routes/step3/deps.js";

const SPECS = path.join(REPO_ROOT, "fixtures/specs");
const only = process.argv[2];

async function loadSpecs(): Promise<{ spec: FeatureSpec; file: string }[]> {
  const out = new Map<string, { spec: FeatureSpec; file: string }>();
  for (const dir of [SPECS, path.join(SPECS, "_seed"), path.join(REPO_ROOT, "fixtures/hand-authored/specs")]) {
    let files: string[] = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files.filter((f) => f.endsWith(".json") && !f.endsWith(".latest.json"))) {
      const file = path.join(dir, f);
      const spec = FeatureSpec.parse(JSON.parse(await fs.readFile(file, "utf8")));
      if (!out.has(spec.feature_id)) out.set(spec.feature_id, { spec, file: path.relative(REPO_ROOT, file) });
    }
  }
  return [...out.values()].filter((s) => !only || s.spec.feature_id === only);
}

if (!step3Deps) {
  console.error(`test:implement cannot run yet. Wire these in src/routes/step3/deps.ts:\n  ${MISSING_UPSTREAM.join("\n  ")}`);
  process.exit(1);
}
const deps = step3Deps;

const specs = await loadSpecs();
if (specs.length === 0) {
  console.error(`No specs found${only ? ` for ${only}` : ""} in fixtures/specs or fixtures/specs/_seed`);
  process.exit(1);
}

let failed = 0;
for (const { spec, file } of specs) {
  console.log(`\n=== ${spec.feature_id}  (${file}, spec ${spec.status})`);
  const t0 = Date.now();
  const bp = await implementEngine(spec, {
    onStage: (stage, message) => console.log(`  [${stage}] ${message}`),
    onProgress: () => {},
    onTestResult: (t) => console.log(`    ${t.passed ? "✓" : "✗"} ${t.name}${t.error ? ` — ${t.error}` : ""}`),
  }, deps);
  const v = bp.verification;
  console.log(`  → ${v.status.toUpperCase()}  ${v.passed}/${v.total} tests · purity ${v.purity_violations.length} · type errors ${v.type_errors.length} · repairs ${v.repair_attempts} · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${v.model}`);
  for (const p of v.purity_violations) console.log(`    purity: ${p}`);
  for (const e of v.type_errors) console.log(`    type: ${e}`);
  await fs.mkdir(path.join(REPO_ROOT, "fixtures/blueprints"), { recursive: true });
  await fs.writeFile(path.join(REPO_ROOT, "fixtures/blueprints", `${spec.feature_id}.latest.json`), JSON.stringify(bp, null, 2));
  if (v.status !== "passed") failed++;
}

console.log(`\n${specs.length - failed}/${specs.length} engines passed`);
process.exit(failed ? 1 : 0);
