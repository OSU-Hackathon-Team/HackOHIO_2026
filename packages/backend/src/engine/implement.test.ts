import { test } from "node:test";
import assert from "node:assert/strict";
import { implementEngine, MAX_REPAIRS, type ImplementHooks } from "./implement.js";
import { ADAPTER_SENTINEL, GOOD_ENGINE, SOURCE_SENTINEL, TARGET_LINE_SENTINEL, TARGET_PATH_SENTINEL, fakeLlm, fakeSandbox, makeSpec, passAll } from "./testFixtures.js";
const spec = makeSpec();
const draft = (portable_code: string) => ({ portable_code, notes: ["note"] });

function hooks(signal?: AbortSignal) {
  const stages: string[] = [];
  const h: ImplementHooks = { signal, onStage: (s) => stages.push(s), onProgress: () => {}, onTestResult: () => {} };
  return { h, stages };
}

const failOne = () => ({
  fatal: null,
  tests: [
    { name: "REQ-1: perfect recall", kind: "acceptance" as const, passed: false, error: "expected 2.6, got 2.5", duration_ms: 1 },
    { name: "REQ-2", kind: "acceptance" as const, passed: true, error: null, duration_ms: 1 },
  ],
  passed: 1,
  total: 2,
});

test("a passing engine is verified on the first attempt", async () => {
  const llm = fakeLlm([draft(GOOD_ENGINE)], "anthropic.claude-test");
  const sb = fakeSandbox(passAll);
  const { h, stages } = hooks();
  const bp = await implementEngine(spec, h, { llm: llm.port, sandbox: sb.port });

  assert.equal(bp.verification.status, "passed");
  assert.equal(bp.verification.repair_attempts, 0);
  assert.equal(bp.verification.passed, 3);
  assert.equal(bp.verification.total, 3);
  assert.equal(bp.verification.model, "anthropic.claude-test");
  assert.equal(bp.implementation.portable_code, GOOD_ENGINE);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].role, "engine_writer");
  assert.deepEqual(sb.inputs.map((i) => [i.kind, i.subject.lang, i.tests]), [["acceptance", "ts", spec.acceptance_tests]]);
  assert.deepEqual(stages, ["implementing", "testing"]);
});

test("original source, identifiers, paths and adapter code never reach prompts or repair feedback", async () => {
  const copiedEngine = `${GOOD_ENGINE}\n${TARGET_LINE_SENTINEL}`;
  const llm = fakeLlm([draft(copiedEngine), draft(copiedEngine), draft(copiedEngine)]);
  const sb = fakeSandbox(passAll);
  const specWithTargetSnippet = makeSpec({
    provenance: {
      ...spec.provenance,
      snippets: [{
        location: `app.asar:${TARGET_PATH_SENTINEL}`,
        symbol: "scheduleReview",
        language: "javascript",
        code: `${SOURCE_SENTINEL}\n${TARGET_LINE_SENTINEL}`,
        full_module: true,
      }],
    },
    oracle: { ...spec.oracle, adapter_code: `module.exports = require("${ADAPTER_SENTINEL}");` },
  });
  await implementEngine(specWithTargetSnippet, hooks().h, { llm: llm.port, sandbox: sb.port });

  assert.equal(llm.calls.length, 1 + MAX_REPAIRS);
  assert.equal(sb.inputs.length, 0, "copied candidates must not reach sandbox execution");
  const sent = JSON.stringify(llm.calls.map((call) => [call.system, call.messages]));
  for (const sentinel of [SOURCE_SENTINEL, ADAPTER_SENTINEL, TARGET_PATH_SENTINEL, TARGET_LINE_SENTINEL, "scheduleReview"]) {
    assert.ok(!sent.includes(sentinel), `${sentinel} leaked into an implementation prompt or repair feedback`);
  }
  assert.match(sent, /verbatim line from target evidence/);
  assert.ok(sent.includes("REQ-1"), "requirements must be sent");
});

test("repair history is append-only and carries the failures", async () => {
  const llm = fakeLlm([draft(GOOD_ENGINE.replace("0.1", "0.2")), draft(GOOD_ENGINE)]);
  let run = 0;
  const sb = fakeSandbox(() => (++run === 1 ? failOne() : passAll()));
  const { h, stages } = hooks();
  const bp = await implementEngine(spec, h, { llm: llm.port, sandbox: sb.port });

  assert.equal(bp.verification.status, "passed");
  assert.equal(bp.verification.repair_attempts, 1);
  const [first, second] = llm.calls;
  assert.equal(second.messages.length, 3);
  assert.deepEqual(second.messages[0], first.messages[0]);
  assert.equal(second.messages[1].role, "assistant");
  assert.deepEqual(second.messages[1].content, [{ type: "text", text: JSON.stringify(draft(GOOD_ENGINE.replace("0.1", "0.2"))), citations: null }]);
  assert.match(String(second.messages[2].content), /Test "REQ-1: perfect recall" failed: expected 2\.6, got 2\.5/);
  assert.deepEqual(stages, ["implementing", "testing", "repairing_engine", "testing"]);
});

test("impure code never passes and stops after the repair limit", async () => {
  const impure = draft(GOOD_ENGINE + "\nexport const seed = Math.random();\n");
  const llm = fakeLlm([impure, impure, impure]);
  const sb = fakeSandbox(passAll);
  const bp = await implementEngine(spec, hooks().h, { llm: llm.port, sandbox: sb.port });

  assert.equal(bp.verification.status, "failed");
  assert.equal(bp.verification.repair_attempts, MAX_REPAIRS);
  assert.equal(llm.calls.length, 1 + MAX_REPAIRS);
  assert.equal(sb.inputs.length, 0, "impure code must not be executed");
  assert.match(bp.verification.purity_violations[0], /Math\.random/);
});

test("type errors never pass", async () => {
  const wrong = draft(GOOD_ENGINE.replace("export function review", "function review"));
  const llm = fakeLlm([wrong, wrong, wrong]);
  const bp = await implementEngine(spec, hooks().h, { llm: llm.port, sandbox: fakeSandbox(passAll).port });
  assert.equal(bp.verification.status, "failed");
  assert.ok(bp.verification.type_errors.some((e) => /review/.test(e)));
});

test("zero executed tests is a failure, not a pass", async () => {
  const llm = fakeLlm([draft(GOOD_ENGINE), draft(GOOD_ENGINE), draft(GOOD_ENGINE)]);
  const sb = fakeSandbox(() => ({ fatal: null, tests: [], passed: 0, total: 0 }));
  const bp = await implementEngine(spec, hooks().h, { llm: llm.port, sandbox: sb.port });
  assert.equal(bp.verification.status, "failed");
  assert.match(String(llm.calls[1].messages[2].content), /no acceptance tests were executed/);
});

test("a sandbox fatal error is a failure", async () => {
  const llm = fakeLlm([draft(GOOD_ENGINE), draft(GOOD_ENGINE), draft(GOOD_ENGINE)]);
  const sb = fakeSandbox(() => ({ fatal: "timeout after 8000ms", tests: [], passed: 0, total: 0 }));
  const bp = await implementEngine(spec, hooks().h, { llm: llm.port, sandbox: sb.port });
  assert.equal(bp.verification.status, "failed");
  assert.match(String(llm.calls[1].messages[2].content), /Sandbox: timeout after 8000ms/);
});

test("an aborted request stops before calling the model", async () => {
  const llm = fakeLlm([draft(GOOD_ENGINE)]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(implementEngine(spec, hooks(ac.signal).h, { llm: llm.port, sandbox: fakeSandbox(passAll).port }));
  assert.equal(llm.calls.length, 0);
});
