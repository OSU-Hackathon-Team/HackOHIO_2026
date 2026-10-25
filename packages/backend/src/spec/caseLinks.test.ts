import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeExtractionPayload, NativeExtractionRequest, SavedAnalysis } from "@splice/contracts";
import { adaptSavedEvidence, assembleSavedExtraction } from "./savedEvidence.js";
import { prepareDiscovery } from "./discovery.js";
import { adaptNativeSpecToFeatureSpec } from "../native/nativeAdapter.js";
import { runTests } from "../sandbox/runTests.js";
import type { NativeDraft } from "./nativeDraft.js";

const claim = (statement: string, case_links?: { case_id: string; agreement: boolean }[]) =>
  ({ statement, review: { outcome: "supported_static", reason: "compare" }, ...(case_links ? { case_links } : {}) });
const analysis = SavedAnalysis.parse({ id: "run-case-links-test", target_id: "libreoffice-calc", title: "LibreOffice Calc",
  created_at: 1, binary_sha256: "b".repeat(64), schema: 1, spec: null,
  result: { readiness: "partial", spec_artifact: null, spec_status: null, spec_writer: null, spec_error: null,
    claim_outcomes: { supported_static: 4 }, functions: { included: 2, drafted: 2, reviewed: 2 },
    oracle: { public_agreement: 2, held_out_agreement: 1 }, handoff_path: "docs/handoff", tokens: { input: 1, output: 1 } },
  functions: [
    { entry: "00100000", name: "ScGreater", draft_state: "drafted", review_state: "reviewed", decompilation: null, unknowns: [],
      claims: [claim("Returns true when the left number is greater than the right", [{ case_id: "gt_false", agreement: true }]),
               claim("Returns true when both numbers are equal", [{ case_id: "le_equal", agreement: false }]),
               claim("Linked to a held-out case only", [{ case_id: "secret_case", agreement: true }])] },
    { entry: "00200000", name: "ScLessEqual", draft_state: "drafted", review_state: "reviewed", decompilation: null, unknowns: [],
      claims: [claim("Returns true when the left number is less than or equal to the right", [{ case_id: "le_equal", agreement: true }]),
               claim("Handles text operands")] },
  ],
  observed_cases: [{ id: "gt_false", formula: "=1>2", cells: {}, observed: { value: 0 } },
                   { id: "le_equal", formula: "=2<=2", cells: {}, observed: { value: 1 } }] });
const request = NativeExtractionRequest.parse({ confirm_cost: true });
const draftFor = (ids: string[]): { draft: NativeDraft; model: string } => ({ model: "fixture-writer", draft: {
  title: "Numeric comparison", purpose: "Compare two numbers.",
  interface: { inputs: ["A comparison formula."], outputs: ["One for true and zero for false."], state: [] },
  requirements: ids.map((id, i) => ({ id: `REQ-${i + 1}`, statement: "Compare the numbers as stated.", claim_ids: [id] })),
  behavior_steps: ["Compare the operands."], acceptance_criteria: ["The result matches the rule."], deviations: [], exclusions: [] } });

test("contradicted facts are omitted and only agreeing public cases are attached", () => {
  const prepared = adaptSavedEvidence(analysis, request);
  assert.deepEqual(prepared.claim_sources.map(c => [c.id, c.case_ids ?? null]),
    [["C1_1", ["gt_false"]], ["C1_3", null], ["C2_1", ["le_equal"]], ["C2_2", null]]);
  assert.match(prepared.omitted_claims.find(c => c.claim_index === 1)!.reason, /Contradicted by an original case/);
  assert.equal(JSON.stringify(prepared.input).includes("secret_case"), false);
});

test("a capability whose every fact agreed with a case becomes ready for review with real examples", () => {
  const prepared = adaptSavedEvidence(analysis, request);
  const linked = { ...prepared, claim_sources: prepared.claim_sources.filter(c => c.case_ids) };
  const payload = assembleSavedExtraction(linked, request, draftFor(["C1_1", "C2_1"]), 5);
  assert.equal(payload.spec.status, "ready_for_review");
  assert.deepEqual(payload.spec.examples, [
    { name: "REQ-1 gt_false", input: { formula: "=1>2", cells: {} }, expected_output: { value: 0 } },
    { name: "REQ-2 le_equal", input: { formula: "=2<=2", cells: {} }, expected_output: { value: 1 } }]);
  assert.match(payload.limitations[0], /blind prediction matched the original program/);
  // One unlinked fact keeps the whole capability a draft without examples.
  const mixed = assembleSavedExtraction(prepared, request, draftFor(prepared.claim_sources.map(c => c.id)), 5);
  assert.equal(mixed.spec.status, "draft");
  assert.deepEqual(mixed.spec.examples, []);
});

test("the contract refuses a ready extraction that lacks case-backed facts or examples", () => {
  const prepared = adaptSavedEvidence(analysis, request);
  const linked = { ...prepared, claim_sources: prepared.claim_sources.filter(c => c.case_ids) };
  const payload = assembleSavedExtraction(linked, request, draftFor(["C1_1", "C2_1"]), 5);
  assert.ok(NativeExtractionPayload.safeParse(payload).success);
  const unbacked = structuredClone(payload); delete unbacked.claim_sources[0].case_ids;
  assert.equal(NativeExtractionPayload.safeParse(unbacked).success, false);
  const noExamples = structuredClone(payload); noExamples.spec.examples = [];
  assert.equal(NativeExtractionPayload.safeParse(noExamples).success, false);
  const invented = structuredClone(payload); invented.spec.examples[0].name = "REQ-1 invented_case";
  assert.equal(NativeExtractionPayload.safeParse(invented).success, false);
});

test("discovery marks case-backed facts without revealing cases or results", () => {
  const groups = prepareDiscovery(analysis).discovery_input.groups;
  assert.deepEqual(groups.flatMap(g => g.claims.filter(c => c.case_backed).map(c => c.id)), ["C1_1", "C2_1"]);
  for (const leak of ["gt_false", "=1>2", "value"]) assert.equal(JSON.stringify(groups).includes(leak), false, leak);
});

test("linked examples become real engine assertions that a wrong engine fails", async () => {
  const prepared = adaptSavedEvidence(analysis, request);
  const linked = { ...prepared, claim_sources: prepared.claim_sources.filter(c => c.case_ids) };
  const spec = assembleSavedExtraction(linked, request, draftFor(["C1_1", "C2_1"]), 5).spec;
  const feature = adaptNativeSpecToFeatureSpec(spec, { appId: "libreoffice" });
  const fn = feature.interface.exports[0].name;
  assert.match(feature.acceptance_tests, new RegExp(`assert\\.deepEqual\\(${fn}\\(\\{"formula":"=1>2","cells":\\{\\}\\}\\), \\{"value":0\\}\\)`));
  assert.equal(feature.acceptance_tests.includes("assert.ok(true"), false);
  const engine = (body: string) => `export function ${fn}(input: { formula: string }) { ${body} }`;
  const run = (code: string) => runTests({ kind: "acceptance", subject: { code, lang: "ts" }, tests: feature.acceptance_tests });
  const right = await run(engine(`const [a, op, b] = input.formula.slice(1).split(/(<=|>)/);
    const r = op === ">" ? Number(a) > Number(b) : Number(a) <= Number(b); return { value: r ? 1 : 0 };`));
  assert.equal(right.fatal, null); assert.equal(right.passed, right.total); assert.equal(right.total, 2);
  const wrong = await run(engine("return { value: 1 };"));
  assert.equal(wrong.passed, 1);
});
