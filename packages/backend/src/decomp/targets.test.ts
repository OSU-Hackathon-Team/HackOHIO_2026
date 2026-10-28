import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecompTargetSpec } from "@splice/contracts";
import { loadTargetRegistry, publicTarget } from "./targets.js";
import { DecompRunService, TARGET_REGISTRY } from "./runs.js";
import type { DecompWorker } from "./ec2.js";

test("the repository registry lists LibreOffice first and a command-line preset", () => {
  const targets = loadTargetRegistry(TARGET_REGISTRY);
  assert.deepEqual(targets.map(t => [t.id, t.driver]), [["libreoffice-calc", "uno"], ["gnu-bc-arith", "cli"], ["gnu-bc", "cli"], ["gnu-units", "cli"]]);
  for (const target of targets) assert.ok(fs.existsSync(path.join(TARGET_REGISTRY, "..", "..", "..", target.cases)), target.cases);
  // The public view never exposes install recipes, trace patterns or handoff folders.
  assert.deepEqual(Object.keys(publicTarget(targets[1])).sort(),
    ["description", "driver", "estimated_cost_usd", "function_budgets", "id", "library", "name"]);
});

test("malformed or mismatched registry entries fail loudly", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "targets-"));
  try {
    const good = JSON.parse(fs.readFileSync(path.join(TARGET_REGISTRY, "gnu-units.json"), "utf8"));
    fs.writeFileSync(path.join(folder, "other-name.json"), JSON.stringify(good));
    assert.throws(() => loadTargetRegistry(folder), /declares id gnu-units/);
    fs.rmSync(path.join(folder, "other-name.json"));
    fs.writeFileSync(path.join(folder, "gnu-units.json"), JSON.stringify({ ...good, install: undefined }));
    assert.throws(() => loadTargetRegistry(folder), /install recipe/);
    fs.writeFileSync(path.join(folder, "gnu-units.json"), JSON.stringify({ ...good, function_budgets: [20, 50] }));
    assert.throws(() => loadTargetRegistry(folder), /budget 50 needs a cost estimate/);
    fs.writeFileSync(path.join(folder, "gnu-units.json"), JSON.stringify({ ...good, install: { apt: "units", binary: "/tmp/evil" } }));
    assert.throws(() => loadTargetRegistry(folder));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  assert.deepEqual(loadTargetRegistry(path.join(os.tmpdir(), "no-such-registry")), []);
});

test("a run starts the worker with the selected target and its own budget rules", async () => {
  const targets = loadTargetRegistry(TARGET_REGISTRY);
  const started: unknown[] = [];
  const worker: DecompWorker = {
    instanceState: async () => "stopped",
    uploadPayload: async () => undefined,
    start: async (_runId: string, args: unknown) => { started.push(args); },
    readObject: async () => null,
  } as unknown as DecompWorker;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-run-"));
  try {
    const service = new DecompRunService({ worker, stateDir, repoRoot: stateDir, targets,
      runnerScript: async () => "#!/bin/bash", buildPayload: async () => undefined, pollMs: 60_000 });
    assert.deepEqual(service.targets().map(t => t.id), ["libreoffice-calc", "gnu-bc-arith", "gnu-bc", "gnu-units"]);
    await assert.rejects(service.start({ target_id: "gnu-units", max_functions: 40, confirm_cost: true }), /must be one of 20, 30/);
    await assert.rejects(service.start({ target_id: "not-registered", max_functions: 20, confirm_cost: true }), /unknown target/);
    await service.start({ target_id: "gnu-units", max_functions: 30, confirm_cost: true });
    for (let i = 0; i < 50 && !started.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(started, [{ maxFunctions: 30, maxDepth: 2, targetId: "gnu-units" }]);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test("the contract keeps install binaries inside system program directories", () => {
  const base = JSON.parse(fs.readFileSync(path.join(TARGET_REGISTRY, "gnu-units.json"), "utf8"));
  assert.ok(DecompTargetSpec.safeParse(base).success);
  assert.equal(DecompTargetSpec.safeParse({ ...base, install: { apt: "units", binary: "/usr/bin/../../etc/passwd" } }).success, false);
  assert.equal(DecompTargetSpec.safeParse({ ...base, cases: "../secrets.json" }).success, false);
  assert.equal(DecompTargetSpec.safeParse({ ...base, extra: 1 }).success, false);
});
