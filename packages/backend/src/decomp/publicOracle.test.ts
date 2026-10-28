import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DecompRunRequest, DecompTargetSpec, type PublicOracleReport } from "@splice/contracts";
import { validatePublicOracle } from "./publicOracle.js";
import { DecompRunService } from "./runs.js";

const target = DecompTargetSpec.parse({ schema: 1, id: "calc-fixture", name: "Fixture", description: "Synthetic fixture",
  driver: "uno", library: "calc", cases: "fixtures/decomp/libreoffice/fixture.json", trace_patterns: ["fixture"],
  function_budgets: [1], estimated_cost_usd: { "1": 0.01 }, depth_by_budget: { "1": 1 }, handoff: "calc-fixture" });
const report: PublicOracleReport = { schema: 1, target_id: target.id, application_version: "Fixture Calc",
  driver_sha256: "a".repeat(64), binary_sha256: "b".repeat(64), cases: [
    { id: "public-fixture", input: { formula: "=1+1", cells: {} }, observed: { value: 2 }, error: null, outcome: "observed" },
  ] };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "public-oracle-"));
  const file = path.join(root, target.cases);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ schema: 1, cases: [
    { id: "public-fixture", formula: "=1+1", held_out: false },
    { id: "sealed-fixture", formula: "=9+9", held_out: true },
  ] }));
  return root;
}

test("public oracle publication rejects sealed records, duplicate cases, changed inputs and false outcomes", async () => {
  const root = await fixture();
  try {
    assert.deepEqual(await validatePublicOracle(report, target, root), report);
    await assert.rejects(validatePublicOracle({ ...report, cases: [{ ...report.cases[0], id: "sealed-fixture" }] }, target, root), /outside the public suite/);
    await assert.rejects(validatePublicOracle({ ...report, cases: [...report.cases, ...report.cases] }, target, root), /does not match/);
    await assert.rejects(validatePublicOracle({ ...report, cases: [{ ...report.cases[0], input: { formula: "=3", cells: {} } }] }, target, root), /input differs/);
    await assert.rejects(validatePublicOracle({ ...report, cases: [{ ...report.cases[0], outcome: "execution_error" }] }, target, root), /contradicts/);
    await assert.rejects(validatePublicOracle({ ...report, target_id: "wrong" }, target, root), /target mismatch/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("public original jobs share the worker lock, carry no function budget, and publish no native analysis", async () => {
  const root = await fixture();
  const starts: unknown[] = [], reads: string[] = [];
  let published = false;
  const service = new DecompRunService({ stateDir: root, repoRoot: root, targets: [target], pollMs: 1,
    runnerScript: async () => "fixture runner", buildPayload: async () => undefined,
    publishAnalysis: async () => { published = true; }, worker: {
      instanceState: async () => "stopped", uploadPayload: async () => undefined,
      start: async (_id, args) => { starts.push(args); },
      readObject: async (_id, name) => { reads.push(name); return name === "exit.json" ? Buffer.from('{"exit":0}')
        : name === "public-oracle.json" ? Buffer.from(JSON.stringify(report)) : null; },
    } });
  try {
    assert.equal(DecompRunRequest.safeParse({ target_id: target.id, max_functions: 1, mode: "public_oracle", confirm_cost: true }).success, false);
    assert.equal(DecompRunRequest.safeParse({ target_id: target.id, max_functions: 0, confirm_cost: true }).success, false);
    const run = await service.start({ target_id: target.id, max_functions: 0, mode: "public_oracle", confirm_cost: true });
    await assert.rejects(service.start({ target_id: target.id, max_functions: 1, confirm_cost: true }), /still in progress/);
    for (let i = 0; i < 100 && service.get(run.run_id)!.run.finished_at === null; i++) await new Promise(r => setTimeout(r, 5));
    const finished = service.get(run.run_id)!.run;
    assert.equal(finished.ok, true);
    assert.equal(finished.result?.public_oracle?.cases.length, 1);
    assert.deepEqual(finished.result?.tokens, { input: 0, output: 0 });
    assert.equal(published, false);
    assert.equal(reads.includes("results.tgz"), false);
    assert.deepEqual(starts, [{ maxFunctions: 0, maxDepth: 2, targetId: target.id, mode: "public_oracle" }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
