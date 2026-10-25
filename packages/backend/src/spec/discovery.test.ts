import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { SavedAnalysis, NativeDiscoveryEvent, NativeExtractionRequest } from "@splice/contracts";
import { NativeLibraryStore } from "../decomp/library.js";
import { nativeLibraryRouter } from "../routes/nativeLibrary.js";
import { adaptSavedEvidence, assembleSavedExtraction } from "./savedEvidence.js";
import { discoveryProblems, prepareDiscovery, runDiscovery, tidyAnswer, MAX_DISCOVERY_CLAIMS, type DiscoveryAnswer, type DiscoveryDeps } from "./discovery.js";
import type { NativeDraft, writeNativeDraft } from "./nativeDraft.js";

const supported = (statement: string) => ({ statement, review: { outcome: "supported_static", reason: "SENTINEL_REVIEW" } });
const fn = (entry: string, claims: unknown[]) => ({ entry, name: `SENTINEL_NAME_${entry}`, draft_state: "drafted",
  review_state: "reviewed", decompilation: "SENTINEL_CODE", claims, unknowns: [] });
const analysis = SavedAnalysis.parse({ id: "run-discovery-test", target_id: "libreoffice-calc", title: "LibreOffice Calc",
  created_at: 1, binary_sha256: "b".repeat(64), schema: 1, spec: null,
  result: { readiness: "partial", spec_artifact: null, spec_status: null, spec_writer: null, spec_error: null,
    claim_outcomes: { supported_static: 4 }, functions: { included: 3, drafted: 3, reviewed: 3 },
    oracle: { public_agreement: 1, held_out_agreement: 1 }, handoff_path: "docs/handoff", tokens: { input: 1, output: 1 } },
  functions: [
    fn("00100000", [supported("Adds two numbers and returns the sum"), supported("Returns an error value when either input is text")]),
    fn("00200000", [supported("Subtracts the second number from the first"), supported("Calls _ZN8ScMatrix5SubOpEbdRKS_")]),
    fn("00300000", [supported("Rounds results to fifteen significant digits"),
      { statement: "Always returns zero", review: { outcome: "contradicted", reason: "wrong" } }]),
  ],
  observed_cases: [{ id: "public", formula: "=1+2", observed: 3 }] });
const eligible = ["C1_1", "C1_2", "C2_1", "C3_1"];

const goodAnswer: DiscoveryAnswer = { explanation: "Two arithmetic capabilities are supported.",
  capabilities: [
    { id: "CAP-1", name: "Spreadsheet addition", purpose: "Add numbers with spreadsheet error handling.", claim_ids: ["C1_1", "C1_2"] },
    { id: "CAP-2", name: "Spreadsheet subtraction", purpose: "Subtract numbers with spreadsheet error handling.", claim_ids: ["C2_1", "C1_2"] },
  ],
  unassigned: [{ claim_id: "C3_1", disposition: "deferred", reason: "Rounding is useful but outside these capabilities." }] };

function draftFor(input: { claims: { id: string }[]; feature?: unknown }): { draft: NativeDraft; model: string } {
  return { model: "fixture-writer", draft: { title: String(input.feature).split(".")[0], purpose: "Perform the described arithmetic.",
    interface: { inputs: ["Two numbers."], outputs: ["A number or an error value."], state: [] },
    requirements: input.claims.map((claim, i) => ({ id: `REQ-${i + 1}`, statement: "Follow the supported behavior.", claim_ids: [claim.id] })),
    behavior_steps: ["Compute the result."], acceptance_criteria: ["The result matches the rule."], deviations: [], exclusions: [] } };
}

function fakeStore() {
  const objects = new Map<string, string>();
  const client = { send: async (command: any) => {
    if (command instanceof PutObjectCommand) { objects.set(command.input.Key!, command.input.Body as string); return {}; }
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (body === undefined) throw Object.assign(new Error("not found"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => body } };
    }
    assert.ok(command instanceof ListObjectsV2Command);
    return { Contents: [...objects.keys()].filter(key => key.startsWith(command.input.Prefix ?? "")).map(Key => ({ Key })), IsTruncated: false };
  } } as unknown as Pick<S3Client, "send">;
  return { store: new NativeLibraryStore("private-bucket", client), client, objects };
}

function deps(overrides: Partial<DiscoveryDeps> = {}) {
  const events: NativeDiscoveryEvent[] = [];
  const { store } = fakeStore();
  const controller = new AbortController();
  const value: DiscoveryDeps = { discover: async () => ({ answer: goodAnswer, model: "fixture-discovery" }),
    writer: async input => draftFor(input as never), saveExtraction: (payload, snapshot) => store.saveExtraction(payload, snapshot),
    signal: controller.signal, cancelled: controller.signal, draftTimeoutMs: 1_000, emit: event => events.push(event), now: () => 7, ...overrides };
  return { deps: value, events, store, controller };
}

test("discovery input uses opaque groups and stable claim IDs, never names, code or review prose", () => {
  const prepared = prepareDiscovery(analysis);
  assert.deepEqual(prepared.discovery_input.groups.map(g => g.group), ["G1", "G2", "G3"]);
  assert.deepEqual(prepared.discovery_input.groups.flatMap(g => g.claims.map(c => c.id)), eligible);
  const text = JSON.stringify(prepared.discovery_input);
  for (const leak of ["SENTINEL", "00100000", "_ZN8", "Always returns zero"]) assert.equal(text.includes(leak), false, leak);
});

test("oversized evidence is rejected before model work instead of being truncated", () => {
  const big = structuredClone(analysis);
  big.functions[0].claims = Array.from({ length: MAX_DISCOVERY_CLAIMS + 1 }, (_, i) => supported(`Handles numeric case number ${i}`));
  assert.throws(() => prepareDiscovery(big), /at most 300.*Nothing was sent/);
});

test("validation enforces IDs, accounting, distinct candidates and source safety, but allows shared claims", () => {
  assert.deepEqual(discoveryProblems(goodAnswer, eligible), []);
  const change = (edit: (a: DiscoveryAnswer) => void) => { const a = structuredClone(goodAnswer); edit(a); return discoveryProblems(a, eligible).join("; "); };
  assert.match(change(a => { a.capabilities[0].claim_ids.push("C9_9"); }), /invented fact C9_9/);
  assert.match(change(a => { a.capabilities[1].id = "CAP-3"; }), /wrong ID/);
  assert.match(change(a => { a.capabilities[1].claim_ids = ["C1_2", "C1_1"]; a.unassigned.push({ claim_id: "C2_1", disposition: "insufficient", reason: "Too weak." }); }), /duplicates another/);
  assert.match(change(a => { a.capabilities[1].name = "spreadsheet ADDITION"; }), /repeats the name/);
  assert.match(change(a => { a.unassigned = []; }), /C3_1 is not accounted for/);
  assert.match(change(a => { a.unassigned.push({ claim_id: "C1_1", disposition: "deferred", reason: "Again." }); }), /both assigned and unassigned/);
  assert.match(change(a => { a.capabilities[0].purpose = "Calls ScMatrix::SubOp to add"; }), /source-like content/);
  // Live Qwen output joined prose clauses with semicolons; tidying keeps every other safety check.
  const prose = structuredClone(goodAnswer); prose.unassigned[0].reason = "Rounding is useful; it is outside these capabilities.";
  assert.deepEqual(discoveryProblems(tidyAnswer(prose), eligible), []);
  assert.equal(tidyAnswer(prose).unassigned[0].reason, "Rounding is useful, it is outside these capabilities.");
  const code = structuredClone(goodAnswer); code.unassigned[0].reason = "x = y; return z";
  assert.match(discoveryProblems(tidyAnswer(code), eligible).join(), /source-like content/);
  assert.match(change(a => { a.capabilities.push(...[3, 4, 5, 6].map(i => ({ id: `CAP-${i}`, name: `Cap ${i}`, purpose: "More.", claim_ids: [`C3_1`] }))); }), /at most 5/);
  const empty: DiscoveryAnswer = { explanation: "", capabilities: [],
    unassigned: eligible.map(claim_id => ({ claim_id, disposition: "insufficient" as const, reason: "Isolated fact." })) };
  assert.match(discoveryProblems(empty, eligible).join(), /explain why/);
  assert.deepEqual(discoveryProblems({ ...empty, explanation: "The facts are too isolated for a reusable feature." }, eligible), []);
});

test("each capability is written from only its own facts and saved as a draft extraction", async () => {
  const seen: string[][] = [];
  const { deps: d, events, store } = deps({ writer: async input => { seen.push(input.claims.map(c => c.id)); return draftFor(input as never); } });
  const report = await runDiscovery(prepareDiscovery(analysis), d);
  assert.deepEqual(seen, [["C1_1", "C1_2"], ["C1_2", "C2_1"]]);
  assert.equal(report.status, "complete");
  assert.equal(report.model, "fixture-discovery");
  const saved = await store.extractions(analysis.id);
  assert.equal(saved.length, 2);
  assert.ok(saved.every(record => record.spec.status === "draft" && record.model === "fixture-writer"));
  assert.ok(saved.every(record => record.analysis_sha256 === report.analysis_sha256));
  assert.deepEqual(new Set(saved.flatMap(r => r.requirement_sources.flatMap(s => s.claim_ids))), new Set(["C1_1", "C1_2", "C2_1"]));
  assert.ok(events.some(e => e.type === "stage" && e.message === "Writing draft 2 of 2: Spreadsheet subtraction"));
  assert.equal(events.filter(e => e.type === "draft").length, 2);
});

test("a failed candidate leaves earlier and later drafts saved and the report partial", async () => {
  let call = 0;
  const { deps: d, events, store } = deps({ writer: async input => { if (call++ === 0) throw new Error("Writer unavailable"); return draftFor(input as never); } });
  const report = await runDiscovery(prepareDiscovery(analysis), d);
  assert.equal(report.status, "partial");
  assert.deepEqual(report.candidates.map(c => c.status), ["failed", "saved"]);
  assert.equal((await store.extractions(analysis.id)).length, 1);
  assert.ok(events.some(e => e.type === "candidate_failed" && e.message.includes("Writer unavailable")));
  const leaky = deps({ writer: async input => { const a = draftFor(input as never); a.draft.behavior_steps = ["MOVAPS XMM0, XMM1"]; return a; } });
  assert.equal((await runDiscovery(prepareDiscovery(analysis), leaky.deps)).status, "failed");
  assert.equal((await leaky.store.extractions(analysis.id)).length, 0);
  const storage = deps({ saveExtraction: async () => { throw new Error("S3 write denied"); } });
  const failed = await runDiscovery(prepareDiscovery(analysis), storage.deps);
  assert.equal(failed.status, "failed");
  assert.ok(failed.candidates.every(c => c.status === "failed" && c.error.includes("S3 write denied")));
});

test("zero capabilities produce an explained empty report without writing drafts", async () => {
  let writes = 0;
  const answer: DiscoveryAnswer = { explanation: "The facts are too isolated for a reusable feature.", capabilities: [],
    unassigned: eligible.map(claim_id => ({ claim_id, disposition: "insufficient" as const, reason: "Isolated fact." })) };
  const { deps: d } = deps({ discover: async () => ({ answer, model: "m" }), writer: async input => { writes++; return draftFor(input as never); } });
  const report = await runDiscovery(prepareDiscovery(analysis), d);
  assert.equal(report.status, "empty"); assert.equal(writes, 0); assert.equal(report.unassigned.length, 4);
});

test("cancellation stops further model work and per-draft timeouts are reported", async () => {
  const cancel = deps();
  let writes = 0;
  cancel.deps.writer = async input => { writes++; cancel.controller.abort(new Error("Discovery cancelled")); return draftFor(input as never); };
  const report = await runDiscovery(prepareDiscovery(analysis), cancel.deps);
  assert.equal(report.status, "cancelled"); assert.equal(writes, 1);
  assert.deepEqual(report.candidates.map(c => c.status), ["failed", "not_attempted"]);
  const slow = deps({ draftTimeoutMs: 10, writer: (_input, hooks) => new Promise((_resolve, reject) =>
    hooks!.signal!.addEventListener("abort", () => reject(hooks!.signal!.reason), { once: true })) });
  const timed = await runDiscovery(prepareDiscovery(analysis), slow.deps);
  assert.equal(timed.status, "failed");
  assert.ok(timed.candidates.every(c => c.status === "failed" && c.error === "Draft exceeded its three-minute limit"));
  const broken = deps({ discover: async () => { throw new Error("capability discovery failed validation: fact C3_1 is not accounted for"); } });
  const none = await runDiscovery(prepareDiscovery(analysis), broken.deps);
  assert.equal(none.status, "failed"); assert.match(none.error!, /not accounted for/);
});

async function serve(options: Parameters<typeof nativeLibraryRouter>[2] = {}, writer: typeof writeNativeDraft = async input => draftFor(input as never)) {
  const { store, objects } = fakeStore(); await store.saveAnalysis(analysis);
  const app = express(); app.use(express.json());
  app.use(nativeLibraryRouter(store, writer, { modelEnabled: true,
    discover: async () => ({ answer: goodAnswer, model: "fixture-discovery" }), ...options }));
  const server = app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/library/analyses/${analysis.id}`;
  return { store, objects, base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const post = (url: string, body: unknown = { confirm_cost: true }) => fetch(url, { method: "POST",
  headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify(body) });
const eventsFrom = (text: string) => text.split("\n").filter(line => line.startsWith("data: "))
  .map(line => NativeDiscoveryEvent.parse(JSON.parse(line.slice(6))));

test("discover HTTP streams drafts, persists a reloadable report and keeps library membership explicit", async () => {
  const service = await serve();
  try {
    assert.equal((await post(`${service.base}/discover`, { confirm_cost: false })).status, 400);
    assert.equal((await post(`${service.base}/discover`, { confirm_cost: true, intent: "injected" })).status, 400);
    const events = eventsFrom(await (await post(`${service.base}/discover`)).text());
    assert.equal(events.filter(e => e.type === "draft").length, 2);
    const report = events.find(e => e.type === "report");
    assert.ok(report && report.type === "report" && report.report.status === "complete");
    assert.deepEqual(events.at(-1), { type: "done", ok: true });
    const listed = await (await fetch(`${service.base}/discoveries`)).json() as { discoveries: { id: string }[] };
    assert.deepEqual(listed.discoveries.map(d => d.id), [report.report.id]);
    assert.equal(((await (await fetch(`${service.base}/extractions`)).json()) as { extractions: unknown[] }).extractions.length, 2);
    assert.equal([...service.objects.keys()].filter(key => key.startsWith("library/features/")).length, 0);
    const key = [...service.objects.keys()].find(k => k.includes("/discoveries/"))!;
    const tampered = JSON.parse(service.objects.get(key)!); tampered.status = "empty";
    service.objects.set(key, JSON.stringify(tampered));
    assert.equal((await fetch(`${service.base}/discoveries`)).status, 503);
  } finally { await service.close(); }
});

test("discovery shares the paid-operation lock with extraction and refuses replay mode", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = await serve({ discover: async () => { entered(); await new Promise<void>(r => { release = r; }); return { answer: goodAnswer, model: "m" }; } });
  try {
    const first = post(`${service.base}/discover`); await started;
    assert.equal((await post(`${service.base}/extract`)).status, 409);
    assert.equal((await post(`${service.base}/discover`)).status, 409);
    release(); await (await first).text();
  } finally { release?.(); await service.close(); }
  const replay = await serve({ modelEnabled: false });
  try { assert.equal((await post(`${replay.base}/discover`)).status, 503); } finally { await replay.close(); }
});

test("discovery reports failures, and existing extraction records stay compatible", async () => {
  const service = await serve({ discover: async () => { throw new Error("Bedrock throttled"); } });
  try {
    const events = eventsFrom(await (await post(`${service.base}/discover`)).text());
    assert.ok(events.some(e => e.type === "report" && e.report.status === "failed"));
    assert.ok(events.some(e => e.type === "error" && e.message.includes("throttled")));
    assert.deepEqual(events.at(-1), { type: "done", ok: false });
    // A legacy prompt-driven extraction still loads beside discovery drafts.
    const request = NativeExtractionRequest.parse({ confirm_cost: true, intent: "Legacy" });
    const prepared = adaptSavedEvidence(analysis, request);
    await service.store.saveExtraction(assembleSavedExtraction(prepared, request, draftFor(prepared.input)), analysis);
    assert.equal((await service.store.extractions(analysis.id)).length, 1);
    service.store.saveDiscovery = async () => { throw new Error("S3 write denied"); };
    const storage = eventsFrom(await (await post(`${service.base}/discover`)).text());
    assert.ok(storage.some(e => e.type === "error" && e.message.includes("S3 write denied")));
    assert.deepEqual(storage.at(-1), { type: "done", ok: false });
  } finally { await service.close(); }
});
