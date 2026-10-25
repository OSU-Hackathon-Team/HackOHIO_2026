import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FeatureSpec, RawEvidence, type RawEvidence as RawEvidenceType } from "@splice/contracts";
import {
  evaluateEngineConformance,
  checkCleanRoomIndependence,
  formatActionableFeedback,
  ORACLE_LIMITATIONS,
  type ActionableFailure,
} from "../dist/engine/oracle.js";
import { implementEngine, MAX_REPAIRS, type ImplementHooks } from "../dist/engine/implement.js";
import {
  GOOD_ENGINE,
  makeSpec,
  fakeLlm,
  fakeSandbox,
  passAll,
} from "../dist/engine/testFixtures.js";

const spec = makeSpec();

function createHooks(signal?: AbortSignal) {
  const stages: string[] = [];
  const progress: { phase: string; chars: number }[] = [];
  const testResults: any[] = [];
  const h: ImplementHooks = {
    signal,
    onStage: (s) => stages.push(s),
    onProgress: (phase, chars) => progress.push({ phase, chars }),
    onTestResult: (t) => testResults.push(t),
  };
  return { h, stages, progress, testResults };
}

describe("Step 3: Conformance Oracle & Behavioral Checks", () => {
  test("valid conforming engine passes all oracle checks and acceptance tests", async () => {
    const sb = fakeSandbox(passAll);
    const report = await evaluateEngineConformance(spec, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, true);
    assert.equal(report.status, "passed");
    assert.equal(report.purity_violations.length, 0);
    assert.equal(report.type_errors.length, 0);
    assert.equal(report.failures.length, 0);
    assert.equal(report.clean_room.passed, true);
    assert.equal(report.test_results.length, 3);
    assert.ok(report.summary.includes("Engine conforms to specification"));
    assert.equal(report.requirement_coverage.total, 3);
    assert.equal(report.requirement_coverage.tested, 3);
    assert.equal(report.requirement_coverage.untested.length, 0);
    assert.ok(report.limitations.length >= 4);
  });

  test("strictly rejects candidate when code compiles cleanly but runtime behavior is incorrect", async () => {
    // Engine compiles with zero TypeScript errors and has zero purity violations,
    // but the calculation logic is flawed (returns ease 2.0 instead of 2.6).
    const flawedEngine = GOOD_ENGINE.replace(
      "ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))",
      "ease - 0.5",
    );

    const sb = fakeSandbox(() => ({
      fatal: null,
      tests: [
        {
          name: "REQ-1: perfect recall raises ease by 0.1",
          kind: "acceptance" as const,
          passed: false,
          error: "AssertionError: expected 2.6, got 2.0",
          duration_ms: 2,
        },
        {
          name: "REQ-2: ease never drops below MIN_EASE",
          kind: "acceptance" as const,
          passed: true,
          error: null,
          duration_ms: 1,
        },
        {
          name: "REQ-3: a lapse resets the interval to 1",
          kind: "acceptance" as const,
          passed: true,
          error: null,
          duration_ms: 1,
        },
      ],
      passed: 2,
      total: 3,
    }));

    const report = await evaluateEngineConformance(spec, flawedEngine, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.equal(report.purity_violations.length, 0);
    assert.equal(report.type_errors.length, 0);
    assert.equal(report.failures.length, 1);

    const failure = report.failures[0];
    assert.equal(failure.category, "runtime_assertion");
    assert.equal(failure.requirement_id, "REQ-1");
    assert.equal(failure.requirement_kind, "behavior");
    assert.equal(failure.expected, "2.6");
    assert.equal(failure.actual, "2.0");
    assert.ok(failure.suggestion?.includes("REQ-1"));
  });

  test("detects contract violation when candidate throws generic Error instead of specified error type", async () => {
    const errorSpec = makeSpec({
      requirements: [
        {
          id: "REQ-1",
          kind: "error",
          statement: "Throws RangeError if grade is not between 0 and 5 inclusive",
          source_refs: ["src/scheduler/sm2.js:L4-L8"],
        },
      ],
    });

    const sb = fakeSandbox(() => ({
      fatal: null,
      tests: [
        {
          name: "REQ-1: invalid grade throws RangeError",
          kind: "acceptance" as const,
          passed: false,
          error: "AssertionError: expected RangeError to be thrown, got Error: invalid grade",
          duration_ms: 1,
        },
      ],
      passed: 0,
      total: 1,
    }));

    const report = await evaluateEngineConformance(errorSpec, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, false);
    assert.equal(report.failures.length, 1);
    const failure = report.failures[0];
    assert.equal(failure.category, "contract_violation");
    assert.equal(failure.requirement_id, "REQ-1");
    assert.equal(failure.requirement_kind, "error");
    assert.equal(failure.expected, "to throw RangeError");
    assert.equal(failure.actual, "Error: invalid grade");
    assert.ok(failure.suggestion?.includes("RangeError"));
  });

  test("detects invariant violation when candidate breaches invariant bounds (MIN_EASE floor)", async () => {
    const invariantSpec = makeSpec({
      requirements: [
        {
          id: "REQ-2",
          kind: "invariant",
          statement: "Ease factor cannot drop below MIN_EASE (1.30)",
          source_refs: ["src/scheduler/sm2.js:L2-L2"],
        },
      ],
    });

    const sb = fakeSandbox(() => ({
      fatal: null,
      tests: [
        {
          name: "REQ-2: ease floor boundary check",
          kind: "acceptance" as const,
          passed: false,
          error: "AssertionError: expected 1.30, got 1.15",
          duration_ms: 1,
        },
      ],
      passed: 0,
      total: 1,
    }));

    const report = await evaluateEngineConformance(invariantSpec, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, false);
    const failure = report.failures[0];
    assert.equal(failure.category, "contract_violation");
    assert.equal(failure.requirement_id, "REQ-2");
    assert.equal(failure.requirement_kind, "invariant");
    assert.equal(failure.expected, "1.30");
    assert.equal(failure.actual, "1.15");
    assert.ok(failure.suggestion?.includes("invariant"));
  });

  test("identifies requirement coverage and flags untested requirements", async () => {
    const partialSpec = makeSpec({
      requirements: [
        { id: "REQ-1", kind: "behavior", statement: "req 1", source_refs: ["ref"] },
        { id: "REQ-2", kind: "behavior", statement: "req 2", source_refs: ["ref"] },
        { id: "REQ-99", kind: "behavior", statement: "untested requirement", source_refs: ["ref"] },
      ],
    });

    const sb = fakeSandbox(() => ({
      fatal: null,
      tests: [
        { name: "REQ-1: test 1", kind: "acceptance" as const, passed: true, error: null, duration_ms: 1 },
        { name: "REQ-2: test 2", kind: "acceptance" as const, passed: true, error: null, duration_ms: 1 },
      ],
      passed: 2,
      total: 2,
    }));

    const report = await evaluateEngineConformance(partialSpec, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.equal(report.requirement_coverage.total, 3);
    assert.equal(report.requirement_coverage.tested, 2);
    assert.deepEqual(report.requirement_coverage.untested, ["REQ-99"]);
  });

  test("enforces clean-room independence and rejects verbatim code copied from RawEvidence", async () => {
    const rawEvidence: RawEvidenceType = {
      app_id: "recall",
      feature_id: "recall.sm2_scheduler",
      target: { path: "targets/build/recall/app.asar", artifact_type: "electron_asar", sha256: "0".repeat(64) },
      rea_package_version: "6.7.0",
      mode: "live",
      tool_calls: [],
      snippets: [
        {
          location: "src/scheduler/sm2.js",
          symbol: "originalLogic",
          language: "javascript",
          code: `function originalInternalHelper() {
  const secretOriginalAlgorithmLine = "VERBATIM_ORIGINAL_LINE_FROM_TARGET_CODE_12345";
  return secretOriginalAlgorithmLine;
}`,
          full_module: true,
        },
      ],
      related_paths: [],
      limitations: [],
      unknowns: [],
      collected_at: "2026-10-24T00:00:00.000Z",
    };

    // Candidate copies the secret original code line directly
    const plagiarizedEngine =
      GOOD_ENGINE +
      `\nconst secretOriginalAlgorithmLine = "VERBATIM_ORIGINAL_LINE_FROM_TARGET_CODE_12345";\n`;

    const parsedEvidence = RawEvidence.parse(rawEvidence);
    const cleanRoomCheck = checkCleanRoomIndependence(plagiarizedEngine, parsedEvidence.snippets);
    assert.equal(cleanRoomCheck.passed, false);
    assert.ok(cleanRoomCheck.violations.length > 0);
    assert.equal(cleanRoomCheck.violations[0], "Candidate engine contains a verbatim line from target evidence.");
    assert.ok(!cleanRoomCheck.violations[0].includes("src/scheduler/sm2.js"));
    assert.ok(!cleanRoomCheck.violations[0].includes("VERBATIM_ORIGINAL_LINE_FROM_TARGET_CODE_12345"));

    const sb = fakeSandbox(passAll);
    const specWithTargetSnippet = makeSpec({
      provenance: { ...spec.provenance, snippets: rawEvidence.snippets },
    });
    const report = await evaluateEngineConformance(specWithTargetSnippet, plagiarizedEngine, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, false);
    assert.equal(report.status, "failed");
    assert.ok(report.failures.some((f) => f.category === "clean_room_violation"));
    assert.ok(!report.actionable_feedback.includes("src/scheduler/sm2.js"));
    assert.ok(!report.actionable_feedback.includes("VERBATIM_ORIGINAL_LINE_FROM_TARGET_CODE_12345"));
    assert.equal(sb.inputs.length, 0, "sandbox must not execute plagiarized candidate");
  });

  test("clean-room check safely treats absent or malformed evidence snippets as unavailable", async () => {
    const malformedEvidence = { ...spec.provenance, snippets: undefined };
    assert.equal(RawEvidence.safeParse({ ...spec.provenance, snippets: undefined }).success, false);
    assert.equal(RawEvidence.safeParse({ ...spec.provenance, snippets: [{ code: 42 }] }).success, false);
    const malformedSpec = { ...spec, provenance: malformedEvidence } as unknown as FeatureSpec;

    for (const snippets of [undefined, null, [{ code: 42 }]]) {
      const result = checkCleanRoomIndependence(GOOD_ENGINE, snippets);
      assert.equal(result.passed, false);
      assert.match(result.violations[0], /missing or malformed/);
    }
    const sb = fakeSandbox(passAll);
    const report = await evaluateEngineConformance(malformedSpec, GOOD_ENGINE, { sandbox: sb.port });
    assert.equal(report.passed, false);
    assert.ok(report.failures.some(f => f.category === "clean_room_violation"));
    assert.equal(sb.inputs.length, 0);
  });

  test("flags differential divergence when candidate fails test that passed against original target oracle", async () => {
    const specWithOracle = makeSpec({
      oracle: {
        status: "passed",
        adapter_code: "module.exports = {};",
        tests: [
          { name: "REQ-1: test 1", kind: "oracle" as const, passed: true, error: null, duration_ms: 1 },
          { name: "REQ-2: test 2", kind: "oracle" as const, passed: true, error: null, duration_ms: 1 },
        ],
        passed: 2,
        total: 2,
      },
    });

    const sb = fakeSandbox(() => ({
      fatal: null,
      tests: [
        { name: "REQ-1: test 1", kind: "acceptance" as const, passed: true, error: null, duration_ms: 1 },
        { name: "REQ-2: test 2", kind: "acceptance" as const, passed: false, error: "divergent value", duration_ms: 1 },
      ],
      passed: 1,
      total: 2,
    }));

    const report = await evaluateEngineConformance(specWithOracle, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, false);
    assert.ok(report.differential?.attempted);
    assert.equal(report.differential?.matched, false);
    assert.ok(report.differential?.divergences.length! > 0);
    assert.ok(report.failures.some((f) => f.category === "differential_divergence"));
  });

  test("detects infinite loop or execution timeout in acceptance sandbox", async () => {
    const sb = fakeSandbox(() => ({
      fatal: "timeout after 8000ms",
      tests: [],
      passed: 0,
      total: 0,
    }));

    const report = await evaluateEngineConformance(spec, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, false);
    assert.ok(report.failures.some((f) => f.category === "timeout"));
  });

  test("rejects candidate when zero acceptance tests were executed", async () => {
    const sb = fakeSandbox(() => ({
      fatal: null,
      tests: [],
      passed: 0,
      total: 0,
    }));

    const report = await evaluateEngineConformance(spec, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.equal(report.passed, false);
    assert.ok(report.failures.some((f) => f.category === "missing_tests"));
  });

  test("reports documented oracle limitations in the conformance report", async () => {
    const sb = fakeSandbox(passAll);
    const report = await evaluateEngineConformance(spec, GOOD_ENGINE, {
      sandbox: sb.port,
    });

    assert.ok(Array.isArray(report.limitations));
    assert.ok(report.limitations.length >= 4);
    assert.ok(report.limitations.some((l) => l.includes("Unexercised Code Paths")));
    assert.ok(report.limitations.some((l) => l.includes("Stripped Platform Glue")));
    assert.ok(report.limitations.some((l) => l.includes("Non-Deterministic")));
    assert.ok(report.limitations.some((l) => l.includes("Native Binary Inaccessibility")));
    assert.deepEqual(report.limitations, [...ORACLE_LIMITATIONS]);
  });
});

describe("Step 3: Refinement Loop & Actionable Failure Reports", () => {
  test("generates structured actionable report with exact requirement IDs, statements, and suggestions", () => {
    const failures: ActionableFailure[] = [
      {
        category: "contract_violation",
        requirement_id: "REQ-1",
        requirement_kind: "error",
        test_name: "REQ-1: RangeError on negative grade",
        message: 'Test "REQ-1: RangeError on negative grade" failed: expected RangeError, got Error',
        expected: "to throw RangeError",
        actual: "Error: invalid grade",
        suggestion: "Throw RangeError when grade < 0.",
      },
      {
        category: "contract_violation",
        requirement_id: "REQ-2",
        requirement_kind: "invariant",
        test_name: "REQ-2: ease floor",
        message: 'Test "REQ-2: ease floor" failed: expected 1.30, got 1.15',
        expected: "1.30",
        actual: "1.15",
        suggestion: "Clamp ease factor using Math.max(MIN_EASE, ease).",
      },
    ];

    const feedback = formatActionableFeedback(failures, spec);
    assert.ok(feedback.includes("Your module does not meet the specification yet:"));
    assert.ok(feedback.includes("<failures>"));
    assert.ok(feedback.includes("1. [contract_violation]"));
    assert.ok(feedback.includes("Requirement: REQ-1 [behavior]"));
    assert.ok(feedback.includes("Expected: to throw RangeError"));
    assert.ok(feedback.includes("Actual:   Error: invalid grade"));
    assert.ok(feedback.includes("Suggestion: Throw RangeError when grade < 0."));
    assert.ok(feedback.includes("2. [contract_violation]"));
    assert.ok(feedback.includes("Expected: 1.30"));
    assert.ok(feedback.includes("Actual:   1.15"));
    assert.ok(feedback.includes("</failures>"));
  });

  test("successfully guides repair turn via continueWith when initial attempt has behavioral failures", async () => {
    const draftInitial = { portable_code: GOOD_ENGINE.replace("0.1", "0.5"), notes: ["initial draft"] };
    const draftRepaired = { portable_code: GOOD_ENGINE, notes: ["fixed ease calculation per feedback"] };

    const llm = fakeLlm([draftInitial, draftRepaired]);
    let callIndex = 0;
    const sb = fakeSandbox(() => {
      callIndex++;
      if (callIndex === 1) {
        return {
          fatal: null,
          tests: [
            {
              name: "REQ-1: perfect recall raises ease by 0.1",
              kind: "acceptance" as const,
              passed: false,
              error: "expected 2.6, got 3.0",
              duration_ms: 1,
            },
          ],
          passed: 0,
          total: 1,
        };
      }
      return passAll();
    });

    const { h, stages } = createHooks();
    const bp = await implementEngine(spec, h, { llm: llm.port, sandbox: sb.port });

    assert.equal(bp.verification.status, "passed");
    assert.equal(bp.verification.repair_attempts, 1);
    assert.equal(llm.calls.length, 2);

    const repairPrompt = String(llm.calls[1].messages[2].content);
    assert.ok(repairPrompt.includes('Test "REQ-1: perfect recall raises ease by 0.1" failed: expected 2.6, got 3.0'));
    assert.ok(repairPrompt.includes("Expected: 2.6"));
    assert.ok(repairPrompt.includes("Actual:   3.0"));
    assert.deepEqual(stages, ["implementing", "testing", "repairing_engine", "testing"]);
  });

  test("strictly rejects candidates and terminates when MAX_REPAIRS is reached without passing", async () => {
    const draftBroken = { portable_code: GOOD_ENGINE.replace("0.1", "0.99"), notes: ["persistent bug"] };
    const llm = fakeLlm([draftBroken, draftBroken, draftBroken]);

    const sb = fakeSandbox(() => ({
      fatal: null,
      tests: [
        {
          name: "REQ-1: test fails repeatedly",
          kind: "acceptance" as const,
          passed: false,
          error: "expected 2.6, got 3.49",
          duration_ms: 1,
        },
      ],
      passed: 0,
      total: 1,
    }));

    const { h } = createHooks();
    const bp = await implementEngine(spec, h, { llm: llm.port, sandbox: sb.port });

    assert.equal(bp.verification.status, "failed");
    assert.equal(bp.verification.repair_attempts, MAX_REPAIRS);
    assert.equal(llm.calls.length, 1 + MAX_REPAIRS);
    assert.equal(bp.verification.passed, 0);
    assert.equal(bp.verification.total, 1);
  });

  test("supports explicit timeoutMs option and cleans up resources on timeout", async () => {
    const draftSlow = { portable_code: GOOD_ENGINE, notes: ["slow run"] };
    // LLM takes 50ms, but timeout is set to 10ms
    const llm = {
      structuredCall: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return {
          value: draftSlow,
          assistantContent: [{ type: "text" as const, text: JSON.stringify(draftSlow), citations: null }],
          model: "test-model",
        };
      },
      continueWith: () => [],
    };
    const sb = fakeSandbox(passAll);

    await assert.rejects(
      implementEngine(spec, createHooks().h, { llm, sandbox: sb.port }, { timeoutMs: 10 }),
      /timed out/i,
    );
  });

  test("aborts immediately when AbortSignal is triggered before execution", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user cancelled implementation"));

    const llm = fakeLlm([]);
    const sb = fakeSandbox(passAll);

    await assert.rejects(
      implementEngine(spec, createHooks(ac.signal).h, { llm: llm.port, sandbox: sb.port }),
      /user cancelled implementation/i,
    );
    assert.equal(llm.calls.length, 0);
    assert.equal(sb.inputs.length, 0);
  });
});
