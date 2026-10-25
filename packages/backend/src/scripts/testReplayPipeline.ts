// Autonomous Pipeline Replay Verification CLI Script
// Programmatically executes end-to-end extraction and synthesis using fixtures/test-run/mock_decompiled_evidence.json
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import { RawEvidence, FeatureSpec, FeatureBlueprint } from "@splice/contracts";
import { loadRecordedEvidence, loadRecordedBlueprint } from "../evidence/replay.js";
import { loadRecordedSpec } from "../spec/store.js";
import { purityViolations } from "../engine/purity.js";
import { conformanceErrors } from "../engine/conformance.js";
import { assembleBundle } from "../synthesis/assemble.js";
import { validateBundle } from "../synthesis/validateBundle.js";

async function main() {
  console.log("================================================================================");
  console.log("  SPLICE AUTONOMOUS PIPELINE REPLAY VERIFICATION");
  console.log("================================================================================");
  const t0 = Date.now();

  // 1. Evidence Ingestion
  console.log("\n[1/4] Loading offline evidence: fixtures/test-run/mock_decompiled_evidence.json...");
  const evidence = await loadRecordedEvidence("mockpriority.priority_score");
  if (!evidence) {
    console.error("FAILED: Could not load mock_decompiled_evidence.json");
    process.exit(1);
  }
  const parsedEvidence = RawEvidence.parse(evidence);
  console.log(`  ✓ Evidence parsed: ${parsedEvidence.feature_id} (mode: ${parsedEvidence.mode})`);
  console.log(`  ✓ Target artifact: ${parsedEvidence.target.path} (${parsedEvidence.target.artifact_type})`);
  console.log(`  ✓ Symbol snippets: ${parsedEvidence.snippets.length} recovered function(s)`);

  // 2. Specification Synthesis
  console.log("\n[2/4] Verifying FeatureSpec synthesis contracts...");
  const spec = await loadRecordedSpec("mockpriority.priority_score");
  if (!spec) {
    console.error("FAILED: Could not load FeatureSpec for mockpriority.priority_score");
    process.exit(1);
  }
  const parsedSpec = FeatureSpec.parse(spec);
  console.log(`  ✓ FeatureSpec schema v${parsedSpec.schema_version}: ${parsedSpec.consumer_title}`);
  console.log(`  ✓ Requirements: ${parsedSpec.requirements.length} formal statements (REQ-1..REQ-${parsedSpec.requirements.length})`);
  console.log(`  ✓ Interface export: module ${parsedSpec.interface.module_name}`);

  // 3. Clean-Room Implementation & Conformance Oracle
  console.log("\n[3/4] Verifying clean-room engine implementation & conformance oracle...");
  const blueprint = await loadRecordedBlueprint("mockpriority.priority_score");
  if (!blueprint) {
    console.error("FAILED: Could not load FeatureBlueprint for mockpriority.priority_score");
    process.exit(1);
  }
  const parsedBp = FeatureBlueprint.parse(blueprint);
  const violations = purityViolations(parsedBp.implementation.portable_code);
  assert.equal(violations.length, 0, `Purity violations detected: ${violations.join(", ")}`);
  console.log("  ✓ AST Purity: 0 violations (no I/O, no node globals, no network)");

  const conformance = conformanceErrors(parsedSpec, parsedBp.implementation.portable_code);
  assert.equal(conformance.length, 0, `Conformance errors: ${conformance.join(", ")}`);
  console.log("  ✓ Interface Conformance: 100% matched to FeatureSpec");

  // Run acceptance test suite in VM context
  const testResults: { name: string; passed: boolean }[] = [];
  const testContext = vm.createContext({
    exports: {},
    assert,
    test: (name: string, fn: () => void) => {
      fn();
      testResults.push({ name, passed: true });
    },
    expect: (val: any) => ({
      toBe: (expected: any) => assert.equal(val, expected),
      toEqual: (expected: any) => assert.deepEqual(val, expected),
    }),
  });

  const js = ts.transpileModule(parsedBp.implementation.portable_code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInContext(js, testContext, { timeout: 1000 });
  Object.assign(testContext, testContext.exports);

  const vmTests = parsedSpec.acceptance_tests.replace(/import\s+[^;]+;\s*/g, "").trim();
  vm.runInContext(vmTests, testContext, { timeout: 1000 });
  console.log(`  ✓ Conformance Oracle: ${testResults.length}/${testResults.length} acceptance tests passed`);
  for (const r of testResults) {
    console.log(`    - ${r.name}`);
  }

  // 4. UI Synthesis & Virtual TypeScript Typecheck
  console.log("\n[4/4] Verifying UI synthesis and virtual TypeScript compilation...");
  const appCode = `import { useState } from "react";
import { score_task_priority, urgency_bucket, type TaskView } from "./engines/priorityScore";

export default function App() {
  const [importance, setImportance] = useState(3);
  const task: TaskView = { completed: false, importance, due_epoch: 1000000 };
  const score = score_task_priority(task, 0);
  const urgency = urgency_bucket(1000000, 0);
  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Task Priority Dashboard</h1>
      <p>Score: {score}</p>
      <p>Urgency: {urgency}</p>
      <button onClick={() => setImportance((i) => Math.min(5, i + 1))}>Inc</button>
    </div>
  );
}
`;
  const bundle = assembleBundle([parsedBp], [{ path: "/App.tsx", content: appCode }], {
    bundle_id: "bundle_autonomous_mockpriority",
    app_title: "Task Priority Dashboard",
    app_description: "Offline verification bundle",
    revision: 0,
    mode: "replay",
  });

  const validation = validateBundle(bundle, [parsedBp]);
  if (!validation.ok) {
    console.error(`FAILED: Bundle validation errors:\n  ${validation.errors.join("\n  ")}`);
    process.exit(1);
  }
  console.log("  ✓ Virtual TypeScript Compiler: 0 syntax or type errors in synthesized bundle");
  console.log("  ✓ Bundle integrity verified: immutability, exports, import allowlists OK");

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log("\n================================================================================");
  console.log(`  AUTONOMOUS REPLAY SUCCESS: ${elapsed}s (Exit code: 0, Prompts: 0, Charges: $0)`);
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("FATAL ERROR in autonomous pipeline replay:", err);
  process.exit(1);
});
