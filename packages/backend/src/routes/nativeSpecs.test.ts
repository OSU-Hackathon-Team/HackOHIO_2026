import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { nativeSpecsRouter } from "./nativeSpecs.js";

let state = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base = "";

async function put(value: object): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(value));
  const artifact = createHash("sha256").update(bytes).digest("hex");
  const folder = path.join(state, "artifacts", artifact.slice(0, 2));
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, artifact), bytes);
  return artifact;
}

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), "splice-native-spec-api-"));
  process.env.DECOMP_STATE_DIR = state;
  const app = express();
  app.use(express.json());
  app.use(nativeSpecsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DECOMP_STATE_DIR;
  await fs.rm(state, { recursive: true, force: true });
});

test("native API rejects a partial dossier and reads only public schema 2 specs", async () => {
  const scopeId = "a".repeat(64);
  const dossier = {
    schema: 1, campaign: "c".repeat(64), binary_sha256: "b".repeat(64),
    scope_id: scopeId, scope_revision: 1, scope_artifact: "d".repeat(64),
    revision: 1, readiness: "partial", draft_artifacts: [], review_artifacts: [],
    probe_report_artifacts: [], probe_link_artifacts: [],
    dependency_resolution_artifacts: [], gap_adjudication_artifacts: [],
    scope: { campaign: "c".repeat(64), scope_id: scopeId, revision: 1,
      request: { mode: "subsystem", query: "counter", expected_observables: [] },
      included: [], boundaries: [], exclusions: [], unresolved: [] },
    claims: [], functions: [], dependency_contracts: [], probes: [],
    independent_review_gaps: [], coverage: { claims: 0 },
    blockers: [{ kind: "missing_function_drafts" }],
  };
  const dossierArtifact = await put(dossier);
  const response = await fetch(`${base}/api/native-specs`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dossier_artifact: dossierArtifact }) });
  assert.equal(response.status, 409);
  const publicSpec = { schema: 2, kind: "native_subsystem_spec", status: "ready_for_review",
    title: "Counter behavior", purpose: "Count events.", boundary: "subsystem",
    interface: { inputs: ["An event."], outputs: ["The count."], state: ["A count."] },
    requirements: [{ id: "REQ-1", statement: "Each event increases the count." }],
    behavior_steps: ["Count each event."],
    examples: [{ name: "once", input: { value: 1 }, expected_output: { count: 1 } }],
    acceptance_criteria: ["One event yields one."], deviations: [], exclusions: [] };
  const artifact = await put(publicSpec);
  const fetched = await fetch(`${base}/api/native-specs/${artifact}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), publicSpec);
  const unsafeArtifact = await put({ ...publicSpec, behavior_steps: ["MOVAPS XMM0, 0x00100000"] });
  assert.equal((await fetch(`${base}/api/native-specs/${unsafeArtifact}`)).status, 500);
  const stored = path.join(state, "artifacts", artifact.slice(0, 2), artifact);
  await fs.writeFile(stored, "tampered");
  assert.equal((await fetch(`${base}/api/native-specs/${artifact}`)).status, 500);
});

test("native API rejects malformed artifact identities", async () => {
  const response = await fetch(`${base}/api/native-specs`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dossier_artifact: "../other" }) });
  assert.equal(response.status, 400);
  assert.equal((await fetch(`${base}/api/native-specs/bad`)).status, 400);
});
