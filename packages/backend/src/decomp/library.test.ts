import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { SavedAnalysis, NativeExtractionRequest, NativeExtractionEvent, type DecompRun } from "@splice/contracts";
import { NativeLibraryStore, publishImportedAnalysis } from "./library.js";
import { nativeLibraryRouter } from "../routes/nativeLibrary.js";
import { makeBlueprint, makeSpec, GOOD_ENGINE } from "../engine/testFixtures.js";
import { adaptSavedEvidence, assembleSavedExtraction } from "../spec/savedEvidence.js";
import type { writeNativeDraft, NativeDraft } from "../spec/nativeDraft.js";

const summary = { id: "run-library-test", target_id: "libreoffice-calc", title: "LibreOffice Calc", created_at: 1,
  binary_sha256: "b".repeat(64), result: { readiness: "partial", spec_artifact: null, spec_status: null,
    spec_writer: null, spec_error: "spec rejected", claim_outcomes: { supported_static: 1 },
    functions: { included: 1, drafted: 1, reviewed: 1 }, oracle: { public_agreement: 1, held_out_agreement: 1 },
    handoff_path: "docs/handoff", tokens: { input: 2, output: 1 } } };
const analysis = SavedAnalysis.parse({ ...summary, schema: 1, spec: null,
  functions: [{ entry: "00100000", name: "f", draft_state: "unreviewed", review_state: "reviewed", decompilation: "int f() { return 1; }",
    claims: [{ statement: "Returns one", review: { outcome: "supported_static", reason: "constant return" } }], unknowns: [] }],
  observed_cases: [{ id: "public", formula: "=1", observed: 1 }] });

function fakeStore() {
  const objects = new Map<string, string>();
  const writes: string[] = [];
  const client = { send: async (command: any) => {
    if (command instanceof PutObjectCommand) { writes.push(command.input.Key!); objects.set(command.input.Key!, command.input.Body as string); return {}; }
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (body === undefined) throw Object.assign(new Error("not found"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => body } };
    }
    assert.ok(command instanceof ListObjectsV2Command);
    const keys = [...objects.keys()].filter(key => key.startsWith(command.input.Prefix ?? ""));
    // Force pagination, including unrelated files that must never reach the API.
    const offset = Number(command.input.ContinuationToken ?? 0);
    return { Contents: keys.slice(offset, offset + 1).map(Key => ({ Key })), IsTruncated: offset + 1 < keys.length,
      NextContinuationToken: offset + 1 < keys.length ? String(offset + 1) : undefined };
  } } as unknown as Pick<S3Client, "send">;
  return { store: new NativeLibraryStore("private-bucket", client), client, objects, writes };
}

test("S3 library survives service recreation, publishes summary last, and excludes private fields", async () => {
  const { store, client, objects, writes } = fakeStore();
  await store.saveAnalysis({ ...analysis, held_out_cases: [{ input: "SECRET" }], raw_transcript: "SECRET" });
  assert.ok(writes[0].endsWith("evidence.json")); assert.ok(writes[1].endsWith("manifest.json"));
  objects.set("results/private/results.tgz", "SECRET");
  assert.equal((await new NativeLibraryStore("private-bucket", client).list()).analyses.length, 1);
  assert.equal(JSON.stringify(await store.analysis(analysis.id)).includes("SECRET"), false);
  assert.equal((await store.analysis(analysis.id)).spec, null);
  await assert.rejects(store.analysis("../../secret"));
});

const extractionRequest = NativeExtractionRequest.parse({ confirm_cost: true });
const answer: { draft: NativeDraft; model: string } = { model: "test-writer", draft: {
  title: "Constant result", purpose: "Produce a fixed numeric result.",
  interface: { inputs: ["A request for a numeric result."], outputs: ["The number one."], state: [] },
  requirements: [{ id: "REQ-1", statement: "Always produce the number one.", claim_ids: ["C1_1"] }],
  behavior_steps: ["Produce the number one."], acceptance_criteria: ["The numeric result is one."], deviations: [], exclusions: [],
} };

test("saved evidence adapter excludes rejected facts and source mechanics, preserving stable provenance", () => {
  const input = structuredClone(analysis);
  input.functions[0].decompilation = "SENTINEL_ORIGINAL_CODE";
  input.functions[0].name = "SENTINEL_FUNCTION_NAME";
  input.functions[0].claims[0].review!.reason = "SENTINEL_REVIEW_CODE";
  input.functions[0].claims.push(
    { statement: "Contradicted behavior", review: { outcome: "contradicted", reason: "wrong" } },
    { statement: "Calls _ZN8ScMatrix5SubOpEbdRKS_", review: { outcome: "supported_static", reason: "call" } },
    { statement: "Sets the constructor vtable pointer", review: { outcome: "supported_static", reason: "store" } });
  const prepared = adaptSavedEvidence(input, extractionRequest);
  assert.equal(prepared.claim_sources.length, 1);
  assert.equal(prepared.claim_sources[0].id, "C1_1");
  assert.equal(prepared.omitted_claims.length, 3);
  assert.equal(JSON.stringify(prepared.input).includes("SENTINEL"), false);
  assert.equal(JSON.stringify(prepared.input).includes("Contradicted behavior"), false);
  assert.equal(prepared.claim_sources[0].function_entry, "00100000");
  const payload = assembleSavedExtraction(prepared, extractionRequest, answer, 123);
  assert.equal(payload.spec.status, "draft");
  assert.deepEqual(payload.spec.examples, []);
  assert.deepEqual(payload.requirement_sources[0].claim_ids, ["C1_1"]);
  assert.deepEqual(payload.spec.requirements[0], { id: "REQ-1", statement: "Always produce the number one." });
});

test("selection and output validation fail before unsupported facts can become requirements", () => {
  assert.throws(() => adaptSavedEvidence(analysis, { ...extractionRequest, function_entries: ["missing"] }), /not in this saved analysis/);
  const unsupported = structuredClone(analysis); unsupported.functions[0].claims[0].review = null;
  assert.throws(() => adaptSavedEvidence(unsupported, extractionRequest), /No reviewed behavioral claims/);
  const prepared = adaptSavedEvidence(analysis, extractionRequest);
  const bad = structuredClone(answer); bad.draft.requirements[0].claim_ids = ["invented"];
  assert.throws(() => assembleSavedExtraction(prepared, extractionRequest, bad), /invented claim/);
  const source = structuredClone(answer); source.draft.behavior_steps = ["MOVAPS XMM0, 0x00100000"];
  assert.throws(() => assembleSavedExtraction(prepared, extractionRequest, source), /failed validation/);
});

test("extraction records survive reload with hash-checked snapshots and cannot become ready specs", async () => {
  const { store, client, objects } = fakeStore();
  const prepared = adaptSavedEvidence(analysis, extractionRequest);
  const payload = assembleSavedExtraction(prepared, extractionRequest, answer, 123);
  const saved = await store.saveExtraction(payload, analysis);
  const reloaded = await new NativeLibraryStore("private-bucket", client).extractions(analysis.id);
  assert.deepEqual(reloaded, [saved]);
  assert.ok([...objects.keys()].some(key => key.includes(`/snapshots/${payload.analysis_sha256}.json`)));
  await assert.rejects(store.saveExtraction({ ...payload, spec: { ...payload.spec, status: "ready_for_review" } }, analysis));
  await assert.rejects(store.saveExtraction({ ...payload, analysis_sha256: "0".repeat(64) }, analysis), /snapshot/);
  const key = [...objects.keys()].find(key => key.includes("/extractions/"))!;
  const changed = JSON.parse(objects.get(key)!); changed.spec.title = "Tampered title";
  objects.set(key, JSON.stringify(changed));
  await assert.rejects(store.extractions(analysis.id), /hash or identity/);
});

test("App library membership is idempotent and retains the saved candidate's description and draft status", async () => {
  const { store, client, objects } = fakeStore();
  const payload = assembleSavedExtraction(adaptSavedEvidence(analysis, extractionRequest), extractionRequest, answer, 123);
  const record = await store.saveExtraction(payload, analysis);
  const request = { analysis_id: analysis.id, extraction_id: record.id };
  assert.equal((await store.features()).length, 0);
  assert.deepEqual(await store.addFeature(request), record);
  await store.addFeature(request);
  const reloaded = await new NativeLibraryStore("private-bucket", client).features();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].spec.purpose, answer.draft.purpose);
  assert.equal(reloaded[0].spec.status, "draft");
  assert.equal([...objects.keys()].filter(key => key.startsWith("library/features/")).length, 1);
  await assert.rejects(store.addFeature({ ...request, spec: { status: "ready_for_review" } }));
  await assert.rejects(store.addFeature({ ...request, analysis_id: "run-other-analysis" }), /not found/);
});

test("App library API loads stored candidate content and rejects caller-supplied feature descriptions", async () => {
  let writerCalls = 0;
  const service = await serveExtraction(async () => { writerCalls++; return answer; });
  try {
    const record = await service.store.saveExtraction(assembleSavedExtraction(adaptSavedEvidence(analysis, extractionRequest), extractionRequest, answer), analysis);
    const request = { analysis_id: analysis.id, extraction_id: record.id };
    const post = (body: unknown) => fetch(`${service.base}/api/library/features`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ ...request, title: "Injected title" })).status, 400);
    assert.equal((await post({ ...request, extraction_id: "0".repeat(64) })).status, 404);
    const response = await post(request); assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { feature: { spec: { status: string } } }).feature.spec.status, "draft");
    assert.equal(((await (await fetch(`${service.base}/api/library/features`)).json()) as { features: unknown[] }).features.length, 1);
    assert.equal(writerCalls, 0);
  } finally { await service.close(); }
});

async function serveExtraction(writer: typeof writeNativeDraft, timeoutMs?: number) {
  const { store } = fakeStore(); await store.saveAnalysis(analysis);
  const app = express(); app.use(express.json());
  app.use(nativeLibraryRouter(store, writer, { modelEnabled: true, timeoutMs }));
  const server = app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${base}/api/library/analyses/${analysis.id}/extract`;
  return { store, base, url, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const postExtraction = (url: string, body: unknown = { confirm_cost: true }, signal?: AbortSignal) => fetch(url, {
  method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body), signal });
const eventsFrom = (text: string) => text.split("\n").filter(line => line.startsWith("data: "))
  .map(line => NativeExtractionEvent.parse(JSON.parse(line.slice(6))));

test("extraction HTTP streams a saved draft and blocks duplicate or unapproved model work", async () => {
  let finish!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const service = await serveExtraction(async (input, hooks) => {
    calls++; assert.equal(JSON.stringify(input).includes("int f()"), false);
    hooks?.onProgress?.(42); started();
    await new Promise<void>(resolve => { finish = resolve; }); return answer;
  });
  try {
    assert.equal((await postExtraction(service.url, { confirm_cost: false })).status, 400);
    assert.equal((await postExtraction(service.url, { confirm_cost: true, claims: ["injected"] })).status, 400);
    assert.equal((await postExtraction(service.url, { confirm_cost: true, function_entries: ["missing"] })).status, 422);
    const first = await postExtraction(service.url); await entered;
    assert.equal((await postExtraction(service.url)).status, 409);
    finish();
    const events = eventsFrom(await first.text());
    assert.ok(events.some(event => event.type === "progress" && event.output_chars === 42));
    assert.ok(events.some(event => event.type === "extraction" && event.extraction.spec.status === "draft"));
    assert.deepEqual(events.at(-1), { type: "done", ok: true });
    assert.equal(calls, 1);
    assert.equal((await (await fetch(`${service.base}/api/library/analyses/${analysis.id}/extractions`)).json() as { extractions: unknown[] }).extractions.length, 1);
  } finally { finish?.(); await service.close(); }
});

test("model, timeout, cancellation and S3 failures never emit a successful extraction", async () => {
  for (const failure of ["model", "timeout", "cancel", "storage"]) {
    let aborted!: () => void;
    const observedAbort = new Promise<void>(resolve => { aborted = resolve; });
    const service = await serveExtraction(async (_input, hooks) => {
      if (failure === "model") throw new Error("Writer unavailable");
      if (failure === "storage") return answer;
      await new Promise<void>((_resolve, reject) => hooks!.signal!.addEventListener("abort", () => { aborted(); reject(hooks!.signal!.reason); }, { once: true }));
      return answer;
    }, failure === "timeout" ? 20 : undefined);
    if (failure === "storage") service.store.saveExtraction = async () => { throw new Error("S3 write denied"); };
    try {
      const controller = new AbortController();
      const response = await postExtraction(service.url, undefined, controller.signal);
      if (failure === "cancel") {
        controller.abort(); await observedAbort;
      } else {
        const events = eventsFrom(await response.text());
        assert.ok(events.some(event => event.type === "error"));
        assert.deepEqual(events.at(-1), { type: "done", ok: false });
        assert.equal(events.some(event => event.type === "extraction"), false);
      }
      assert.equal((await service.store.extractions(analysis.id)).length, 0);
    } finally { await service.close(); }
  }
});

test("only passing engine blocks are saved, and stored code hashes are checked", async () => {
  const { store, objects } = fakeStore();
  const block = makeBlueprint(makeSpec(), GOOD_ENGINE);
  block.verification.tests = [1, 2, 3].map(i => ({ name: `REQ-${i}`, kind: "acceptance", passed: true, error: null, duration_ms: 1 }));
  await store.saveBlock(block);
  assert.deepEqual((await store.list()).blocks[0].blueprint.implementation.portable_code, block.implementation.portable_code);
  const failed = structuredClone(block); failed.verification.status = "failed";
  await assert.rejects(store.saveBlock(failed));
  const key = [...objects.keys()][0], saved = JSON.parse(objects.get(key)!);
  saved.blueprint.implementation.portable_code += "\n// changed";
  objects.set(key, JSON.stringify(saved));
  await assert.rejects(store.list(), /hash mismatch/);
});

test("block identity verifies the stored representation before schema normalization", async () => {
  const { store, objects } = fakeStore();
  const blueprint = makeBlueprint(makeSpec(), GOOD_ENGINE);
  blueprint.verification.tests = [1, 2, 3].map(i => ({ name: `REQ-${i}`, kind: "acceptance", passed: true, error: null, duration_ms: 1 }));
  await store.saveBlock(blueprint);
  const key = [...objects.keys()][0];
  const saved = JSON.parse(objects.get(key)!);
  saved.blueprint = Object.fromEntries(Object.entries(saved.blueprint).reverse());
  saved.id = createHash("sha256").update(JSON.stringify(saved.blueprint)).digest("hex");
  objects.delete(key);
  objects.set(`library/blocks/${saved.id}.json`, JSON.stringify(saved));
  assert.equal((await store.list()).blocks.length, 1);
});

test("publishing imported evidence checks artifact hashes and selects only public handoff cases", async () => {
  const { store } = fakeStore();
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "s3-library-test-"));
  try {
    const bytes = Buffer.from(JSON.stringify({ decompilation: "int f() { return 1; }" }));
    const digest = createHash("sha256").update(bytes).digest("hex");
    await fs.mkdir(path.join(state, "artifacts", digest.slice(0, 2)), { recursive: true });
    const artifact = path.join(state, "artifacts", digest.slice(0, 2), digest);
    await fs.writeFile(artifact, bytes);
    await fs.writeFile(path.join(state, "evidence.json"), JSON.stringify({ source: { binary_sha256: summary.binary_sha256 },
      functions: analysis.functions, observed_cases: analysis.observed_cases, held_out_cases: ["SECRET"] }));
    const run: DecompRun = { run_id: analysis.id, target_id: summary.target_id, max_functions: 1,
      stage: "complete", started_at: 1, finished_at: 2, ok: true, result: summary.result };
    const progress = JSON.stringify({ stage: "function_cache_hit", address: "00100000", artifact: digest });
    await publishImportedAnalysis(store, run, summary.result, state, state, progress);
    assert.equal((await store.analysis(run.run_id)).functions[0].decompilation, "int f() { return 1; }");
    assert.equal(JSON.stringify(await store.analysis(run.run_id)).includes("SECRET"), false);
    await fs.writeFile(artifact, "tampered");
    await assert.rejects(publishImportedAnalysis(store, run, summary.result, state, state, progress), /hash mismatch/);
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test("library HTTP routes show storage errors and disabled state without demo fallback", async () => {
  const { store } = fakeStore();
  const app = express(); app.use(nativeLibraryRouter(store));
  const server = app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await store.saveAnalysis(analysis);
    const catalog = await (await fetch(base + "/api/library")).json() as { analyses: unknown[] };
    assert.equal(catalog.analyses.length, 1);
    assert.equal((await fetch(base + "/api/library/analyses/not-found-id")).status, 404);
    assert.equal((await fetch(base + "/api/library/analyses/bad")).status, 400);
    store.list = async () => { throw new Error("AccessDenied"); };
    assert.equal((await fetch(base + "/api/library")).status, 503);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const disabledApp = express(); disabledApp.use(nativeLibraryRouter(null));
  const disabled = disabledApp.listen(0); await new Promise<void>(resolve => disabled.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${(disabled.address() as { port: number }).port}/api/library`;
    assert.deepEqual(await (await fetch(url)).json(), { enabled: false, analyses: [], blocks: [] });
  } finally { await new Promise<void>(resolve => disabled.close(() => resolve())); }
});
