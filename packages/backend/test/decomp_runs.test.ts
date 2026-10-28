import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import express from "express";
import { DecompRunEvent } from "@splice/contracts";
import { buildPayload, selectPayloadFiles, TAR } from "../dist/decomp/payload.js";
import { parseProgress } from "../dist/decomp/progress.js";
import { importRunResults } from "../dist/decomp/importRun.js";
import { DecompRunService } from "../dist/decomp/runs.js";
import { decompRunsRouter } from "../dist/routes/decompRuns.js";

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "../../..");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A worker results.tgz with one spec artifact, a run summary and its handoff folder. */
async function fakeResults(dir: string, tamper = false): Promise<{ tgz: Buffer; artifact: string }> {
  const spec = Buffer.from(JSON.stringify({ schema: 2, kind: "native_subsystem_spec", status: "draft" }));
  const artifact = sha(spec);
  const state = path.join(dir, "state");
  await fs.mkdir(path.join(state, "artifacts", artifact.slice(0, 2)), { recursive: true });
  await fs.writeFile(path.join(state, "artifacts", artifact.slice(0, 2), artifact), tamper ? Buffer.from("changed") : spec);
  const runs = path.join(state, "lo_runs");
  await fs.mkdir(path.join(runs, "20261025T050000-handoff"), { recursive: true });
  await fs.writeFile(path.join(runs, "20261025T050000.json"), JSON.stringify({
    dossier: { readiness: "partial" }, spec: { artifact, status: "draft", writer: "amazon-bedrock/qwen" },
    scope: { included: 40 }, claims: { drafted: 38, reviewed: 37 },
    probes: { public: { agreement: 22 }, held_out: { agreement: 10 } } }));
  await fs.writeFile(path.join(runs, "20261025T050000-handoff", "README.md"), "# handoff\n");
  await fs.writeFile(path.join(runs, "20261025T050000-handoff", "evidence.json"),
    JSON.stringify({ claim_outcomes: { supported_static: 30, contradicted: 5 }, functions: [] }));
  const attempt = path.join(state, "attempts", "a1");
  await fs.mkdir(attempt, { recursive: true });
  await fs.writeFile(path.join(attempt, "result.json"), JSON.stringify({ state: "unreviewed", usage: { input: 1000, output: 100 } }));
  const tgz = path.join(dir, "results.tgz");
  await run(TAR, ["-czf", tgz, "-C", dir, "state"]);
  return { tgz: await fs.readFile(tgz), artifact };
}

describe("decomp runs: payload", () => {
  it("ships tracked engine and writer files but never .env, tests or the frontend source", () => {
    const picked = selectPayloadFiles([
      "engine/behavior.py", "engine/analysis/scoped.py", "engine/s3_cache.py", "scripts/lo_pipeline.py", "scripts/other.py",
      "packages/backend/src/llm/llm.ts", "packages/backend/src/x.test.ts", "packages/backend/.env",
      "packages/frontend/package.json", "packages/frontend/src/App.tsx", "docs/notes.md",
      "infra/decomp-ec2/run-scoped-pipeline.sh", "package-lock.json"]);
    assert.deepEqual(picked, ["engine/analysis/scoped.py", "engine/behavior.py", "engine/s3_cache.py",
      "infra/decomp-ec2/run-scoped-pipeline.sh", "package-lock.json", "packages/backend/src/llm/llm.ts",
      "packages/frontend/package.json", "scripts/lo_pipeline.py"]);
  });

  it("builds a real archive from git-tracked files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "payload-test-"));
    try {
      const { files } = await buildPayload(REPO, path.join(dir, "p.tgz"));
      assert.ok(files.includes("engine/lo_pipeline.py"));
      assert.ok(!files.some((f) => /\.env$/.test(f)));
      const { stdout } = await run(TAR, ["-tzf", path.join(dir, "p.tgz")], { maxBuffer: 16 * 1024 * 1024 });
      assert.ok(stdout.includes("scripts/lo_pipeline.py"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("decomp runs: progress", () => {
  it("maps console stage lines and counts drafted and reviewed functions once each", () => {
    const consoleLog = "noise\n[triage] Frida via REA\n[scope] 40 functions from 12 seeds\n[claims] 40 functions, 2 workers\n";
    const progress = [
      { stage: "semantic_finished", subject: "a" }, { stage: "semantic_finished", subject: "a" },
      { stage: "semantic_finished", subject: "b" }, { stage: "review_finished", subject: "a" },
    ].map((e) => JSON.stringify(e)).join("\n");
    const snapshot = parseProgress(progress, consoleLog);
    assert.equal(snapshot.stage, "claims");
    assert.deepEqual(snapshot.claims, { total: 40, drafted: 2, reviewed: 1 });
    assert.equal(snapshot.lines.length, 3);
  });

  it("reports scoped preparation as the analyze stage", () => {
    const snapshot = parseProgress(JSON.stringify({ stage: "scoped_prepare_started" }), "[triage] Frida\n");
    assert.equal(snapshot.stage, "analyze");
  });

  it("counts reused semantic and review records as completed progress", () => {
    const progress = [
      { stage: "semantic_cache_hit", subject: "a" },
      { stage: "review_cache_hit", subject: "a" },
      { stage: "semantic_finished", subject: "b" },
    ].map(event => JSON.stringify(event)).join("\n");
    assert.deepEqual(parseProgress(progress, "[claims] 2 functions, 2 workers\n").claims,
      { total: 2, drafted: 2, reviewed: 1 });
  });
});

describe("decomp runs: import", () => {
  it("copies verified artifacts and the handoff, and summarises the run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "import-test-"));
    try {
      const { tgz, artifact } = await fakeResults(path.join(dir, "src"));
      const stateDir = path.join(dir, "state"), handoffDir = path.join(dir, "repo", "docs", "handoffs", "lo");
      const result = await importRunResults(tgz, { stateDir, handoffDir, repoRoot: path.join(dir, "repo") });
      assert.equal(result.spec_artifact, artifact);
      assert.equal(result.spec_status, "draft");
      assert.equal(result.readiness, "partial");
      assert.deepEqual(result.functions, { included: 40, drafted: 38, reviewed: 37 });
      assert.deepEqual(result.oracle, { public_agreement: 22, held_out_agreement: 10,
        public_observed: 0, held_out_observed: 0 });
      assert.deepEqual(result.tokens, { input: 1000, output: 100 });
      assert.equal(result.handoff_path, "docs/handoffs/lo");
      await fs.access(path.join(stateDir, "artifacts", artifact.slice(0, 2), artifact));
      await fs.access(path.join(handoffDir, "README.md"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an artifact whose bytes do not match its name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "import-tamper-"));
    try {
      const { tgz } = await fakeResults(path.join(dir, "src"), true);
      await assert.rejects(importRunResults(tgz, { stateDir: path.join(dir, "state"),
        handoffDir: path.join(dir, "h"), repoRoot: dir }), /content hash/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("decomp runs: API", () => {
  let dir = "";
  let results: Buffer;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "decomp-api-"));
    results = (await fakeResults(path.join(dir, "src"))).tgz;
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function serve(service: DecompRunService) {
    const app = express();
    app.use(express.json());
    app.use(decompRunsRouter(service));
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as { port: number };
    return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  it("is disabled without a worker", async () => {
    const service = new DecompRunService({ worker: null, stateDir: path.join(dir, "off"), repoRoot: dir,
      runnerScript: async () => "", buildPayload: async () => undefined });
    const { base, close } = await serve(service);
    try {
      const targets = await (await fetch(`${base}/api/decomp/targets`)).json();
      assert.equal(targets.enabled, false);
      const res = await fetch(`${base}/api/decomp/runs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "libreoffice-calc", max_functions: 20, confirm_cost: true }) });
      assert.equal(res.status, 403);
    } finally { close(); }
  });

  it("fails fast when the worker stops without finishing", async () => {
    // The runner died at once: the instance is back to stopped and nothing was uploaded.
    const worker = {
      instanceState: async () => "stopped",
      uploadPayload: async () => undefined,
      start: async () => undefined,
      readObject: async () => null,
    };
    const service = new DecompRunService({ worker, stateDir: path.join(dir, "dead"), repoRoot: dir,
      runnerScript: async () => "", buildPayload: async () => undefined, pollMs: 5 });
    const { base, close } = await serve(service);
    try {
      const res = await fetch(`${base}/api/decomp/runs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "libreoffice-calc", max_functions: 20, confirm_cost: true }) });
      const { run } = await res.json();
      const text = await (await fetch(`${base}/api/decomp/runs/${run.run_id}/events`)).text();
      const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => DecompRunEvent.parse(JSON.parse(l.slice(5))));
      const error = events.find((e) => e.type === "error");
      assert.match(error?.type === "error" ? error.message : "", /never finished/);
      assert.equal(events.at(-1)?.type === "done" && events.at(-1)?.type, "done");
    } finally { close(); }
  });

  it("runs to done, streams the history, and refuses a second run meanwhile", async () => {
    let polls = 0;
    const started: unknown[] = [];
    const worker = {
      instanceState: async () => (started.length ? "running" : "stopped"),
      uploadPayload: async () => undefined,
      start: async (id: string, args: unknown) => { started.push({ id, args }); },
      readObject: async (_id: string, name: string) => {
        if (name === "console.log") return Buffer.from("[claims] 40 functions, 2 workers\n");
        if (name === "progress.jsonl") return Buffer.from(JSON.stringify({ stage: "semantic_finished", subject: "a" }));
        if (name === "exit.json") return ++polls > 2 ? Buffer.from('{"exit":0}') : null;
        if (name === "results.tgz") return results;
        return null;
      },
    };
    const service = new DecompRunService({ worker, stateDir: path.join(dir, "on"), repoRoot: path.join(dir, "repo"),
      runnerScript: async () => "#!/bin/bash", buildPayload: async () => undefined, pollMs: 5 });
    const { base, close } = await serve(service);
    try {
      const bad = await fetch(`${base}/api/decomp/runs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "libreoffice-calc", max_functions: 33, confirm_cost: true }) });
      assert.equal(bad.status, 400);
      const res = await fetch(`${base}/api/decomp/runs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "libreoffice-calc", max_functions: 40, confirm_cost: true }) });
      assert.equal(res.status, 202);
      const { run } = await res.json();
      const second = await fetch(`${base}/api/decomp/runs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_id: "libreoffice-calc", max_functions: 20, confirm_cost: true }) });
      assert.equal(second.status, 409);

      const text = await (await fetch(`${base}/api/decomp/runs/${run.run_id}/events`)).text();
      const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => DecompRunEvent.parse(JSON.parse(l.slice(5))));
      const last = events.at(-1)!;
      assert.equal(last.type, "done");
      assert.equal(last.type === "done" && last.ok, true);
      assert.ok(events.some((e) => e.type === "stage" && e.stage === "claims"));
      assert.ok(events.some((e) => e.type === "progress" && e.label === "drafted" && e.done === 1 && e.total === 40));
      const result = events.find((e) => e.type === "result");
      assert.equal(result?.type === "result" && result.result.spec_status, "draft");
      assert.deepEqual(started, [{ id: run.run_id, args: { maxFunctions: 40, maxDepth: 3, targetId: "libreoffice-calc" } }]);

      // A finished run replays from disk for a fresh service (e.g. after a backend restart).
      const reloaded = new DecompRunService({ worker: null, stateDir: path.join(dir, "on"), repoRoot: dir,
        runnerScript: async () => "", buildPayload: async () => undefined });
      await reloaded.init();
      assert.equal(reloaded.get(run.run_id)?.run.ok, true);
    } finally { close(); }
  });
});
