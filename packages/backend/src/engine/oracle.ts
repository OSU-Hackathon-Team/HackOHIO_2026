// Owner: Eng 3 (Implementation) — Step 3 Conformance Oracle & Behavioral Evaluation
import type { FeatureSpec, SourceSnippet, TestCaseResult, Requirement } from "@splice/contracts";
import type { SandboxPort } from "./ports.js";
import { purityViolations } from "./purity.js";
import { conformanceErrors } from "./conformance.js";

export type FailureCategory =
  | "purity"
  | "type"
  | "runtime_assertion"
  | "runtime_error"
  | "timeout"
  | "missing_tests"
  | "contract_violation"
  | "clean_room_violation"
  | "differential_divergence";

export interface ActionableFailure {
  category: FailureCategory;
  requirement_id?: string;
  requirement_kind?: "behavior" | "invariant" | "edge_case" | "error";
  test_name?: string;
  message: string;
  expected?: string;
  actual?: string;
  suggestion?: string;
}

export interface ConformanceOptions {
  sandbox: SandboxPort;
  signal?: AbortSignal;
  timeoutMs?: number;
  onTestResult?: (t: TestCaseResult) => void;
  onStage?: (stage: "testing", message: string) => void;
}

export interface ConformanceReport {
  passed: boolean;
  status: "passed" | "failed";
  summary: string;
  purity_violations: string[];
  type_errors: string[];
  test_results: TestCaseResult[];
  failures: ActionableFailure[];
  actionable_feedback: string;
  clean_room: {
    passed: boolean;
    violations: string[];
  };
  differential?: {
    attempted: boolean;
    matched: boolean;
    divergences: string[];
  };
  requirement_coverage: {
    total: number;
    tested: number;
    untested: string[];
  };
  limitations: string[];
  duration_ms: number;
}

/**
 * Documented limitations of the static and sandboxed conformance oracle.
 * Documents behavior that cannot be conclusively established from static target evidence alone.
 */
export const ORACLE_LIMITATIONS: readonly string[] = [
  "Unexercised Code Paths: The conformance oracle verifies candidate behavior only on test vectors executed in the acceptance test suite. Input edge cases not covered by the tests cannot be proven mathematically equivalent (general program equivalence is undecidable).",
  "Stripped Platform Glue: Host-specific glue (Electron IPC, OS window lifecycle, filesystem persistence, native platform dialogs) is deliberately stripped for clean-room portability and cannot be verified in isolation by the pure engine oracle.",
  "Non-Deterministic & Temporal Dynamics: Pure engines prohibit Date.now(), Math.random(), and async timers. Wall-clock timing or race conditions from the original host environment cannot be verified statically and must be controlled via parameter injection.",
  "Native Binary Inaccessibility: When reverse-engineering native compiled binaries without full decompiled JavaScript source (oracle status 'not_executable'), differential sandbox execution cannot be performed; conformance relies on static specification contracts.",
  "Runtime Isolation Environment: Sandboxed execution runs within a Node.js V8 VM context; platform-specific engine anomalies or browser-specific JavaScript engine bugs cannot be reproduced.",
] as const;

/**
 * Checks whether the clean-room candidate engine copied non-trivial source lines
 * directly from raw target evidence snippets (anti-plagiarism / clean-room check).
 */
export function checkCleanRoomIndependence(
  candidateCode: string,
  snippets: unknown,
): { passed: boolean; violations: string[] } {
  if (!Array.isArray(snippets)) {
    return { passed: false, violations: ["Target evidence snippets are missing or malformed; clean-room verification is unavailable."] };
  }
  if (snippets.length === 0) {
    return { passed: true, violations: [] };
  }

  const violations: string[] = [];
  const candidateLines = candidateCode
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 25 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("export type") && !l.startsWith("export interface"));

  for (const snippet of snippets as SourceSnippet[]) {
    if (!snippet || typeof snippet.code !== "string") {
      return { passed: false, violations: ["Target evidence snippets are missing or malformed; clean-room verification is unavailable."] };
    }
    const snippetLines = new Set(
      snippet.code
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 25 && !l.startsWith("//") && !l.startsWith("/*")),
    );

    for (const candLine of candidateLines) {
      if (snippetLines.has(candLine)) {
        violations.push("Candidate engine contains a verbatim line from target evidence.");
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * Extracts requirement IDs mentioned in a test name (e.g. "REQ-1 REQ-2: test case").
 */
export function extractRequirementIds(testName: string): string[] {
  const matches = testName.matchAll(/\b(REQ-\d+)\b/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

/**
 * Attempts to parse expected and actual values from an assertion failure message.
 */
function parseAssertionDetails(errorMsg: string): { expected?: string; actual?: string } {
  // Format: "expected <X> to be thrown, got <Y>"
  const mThrow = errorMsg.match(/expected\s+(.+?)\s+to be thrown(?:,\s*got\s+(.+))?$/i);
  if (mThrow) {
    return { expected: `to throw ${mThrow[1].trim()}`, actual: mThrow[2]?.trim() ?? "not thrown" };
  }

  if (/expected function to throw/i.test(errorMsg)) {
    return { expected: "function to throw an error", actual: "no error was thrown (returned normally)" };
  }

  // Format: "expected <expected>, got <actual>"
  const m1 = errorMsg.match(/expected\s+(.+?),\s*got\s+(.+)$/i);
  if (m1) {
    return { expected: m1[1].trim(), actual: m1[2].trim() };
  }

  return {};
}

/**
 * Generates actionable suggestions based on the failing requirement's kind and statement.
 */
function deriveSuggestion(req: Requirement | undefined, errorMsg: string): string {
  if (!req) {
    if (/timeout/i.test(errorMsg)) {
      return "Check loop termination conditions and recursion depth to avoid infinite execution.";
    }
    return "Ensure the implementation matches the expected value and satisfies all test assertions.";
  }

  switch (req.kind) {
    case "error":
      return `Requirement ${req.id} mandates throwing on invalid inputs: "${req.statement}". Ensure the function validates input parameters and throws the exact specified Error class (e.g. RangeError or TypeError).`;
    case "invariant":
      return `Requirement ${req.id} specifies an invariant: "${req.statement}". Ensure calculations enforce boundary constraints (e.g. using Math.max / Math.min or clamping).`;
    case "edge_case":
      return `Requirement ${req.id} defines edge-case handling: "${req.statement}". Check edge cases such as empty collections, boundary scores (e.g. 0 or max), and zero values.`;
    case "behavior":
    default:
      return `Review ${req.id} specification: "${req.statement}". Verify that the algorithm follows the exact formulas, state transitions, and return shapes.`;
  }
}

/**
 * Formats actionable failure feedback for the LLM repair turn.
 */
export function formatActionableFeedback(failures: ActionableFailure[], spec: FeatureSpec): string {
  const lines: string[] = [
    "Your module does not meet the specification yet:",
    "<failures>",
  ];

  failures.forEach((f, idx) => {
    const num = idx + 1;
    let block = `${num}. [${f.category}] ${f.message}`;
    if (f.requirement_id) {
      const req = spec.requirements.find((r) => r.id === f.requirement_id);
      if (req) {
        block += `\n   - Requirement: ${req.id} [${req.kind}] "${req.statement}"`;
      }
    }
    if (f.expected || f.actual) {
      block += `\n   - Expected: ${f.expected ?? "n/a"}`;
      block += `\n   - Actual:   ${f.actual ?? "n/a"}`;
    }
    if (f.suggestion) {
      block += `\n   - Suggestion: ${f.suggestion}`;
    }
    lines.push(block);
  });

  lines.push("</failures>");
  lines.push(
    "Fix the implementation so it satisfies all requirements and contracts (not just these specific test values). Return the complete TypeScript module matching the schema.",
  );

  return lines.join("\n");
}

/**
 * Evaluates candidate engine code against the FeatureSpec and runtime acceptance tests.
 * Performs purity scans, strict type conformance, clean-room checks, sandbox execution,
 * contract/invariant checks, and differential comparison against original target oracle results.
 */
export async function evaluateEngineConformance(
  spec: FeatureSpec,
  candidateCode: string,
  opts: ConformanceOptions,
): Promise<ConformanceReport> {
  const t0 = Date.now();
  opts.signal?.throwIfAborted();

  const failures: ActionableFailure[] = [];

  // 1. Run the clean-room gate first. Copied source text must not reach diagnostics
  // that are later used as feedback to the repair model.
  const cleanRoom = checkCleanRoomIndependence(candidateCode, spec.provenance.snippets);
  if (!cleanRoom.passed) {
    for (const v of cleanRoom.violations) {
      failures.push({
        category: "clean_room_violation",
        message: v,
        suggestion:
          "Rewrite the clean-room engine implementation independently from first principles. Do not copy verbatim source lines from the target application.",
      });
    }
  }

  // 2. Purity and type diagnostics run only when the source-copy gate passes.
  const purity = cleanRoom.passed ? purityViolations(candidateCode) : [];
  for (const p of purity) {
    failures.push({
      category: "purity",
      message: `Purity: ${p}`,
      suggestion:
        "Remove all external imports, environment globals (process/window/localStorage), console calls, and nondeterministic functions (Math.random, Date.now). Pure modules must be completely self-contained and deterministic.",
    });
  }

  let typeErrors: string[] = [];
  if (cleanRoom.passed && purity.length === 0) {
    typeErrors = conformanceErrors(spec, candidateCode);
    for (const e of typeErrors) {
      failures.push({
        category: "type",
        message: `Type: ${e}`,
        suggestion:
          "Ensure all declared functions, types, and consts in spec.interface are exported with matching signatures and bidirectional type assignability under TypeScript strict mode.",
      });
    }
  }

  // 3. Sandbox Acceptance Testing
  let testResults: TestCaseResult[] = [];
  let fatalError: string | null = null;

  if (purity.length === 0 && typeErrors.length === 0 && cleanRoom.passed) {
    opts.signal?.throwIfAborted();
    opts.onStage?.("testing", `Running ${spec.oracle.total || "the"} acceptance tests against the new engine`);
    const r = await opts.sandbox.runTests({
      kind: "acceptance",
      subject: { code: candidateCode, lang: "ts" },
      tests: spec.acceptance_tests,
      totalTimeoutMs: opts.timeoutMs,
    });

    fatalError = r.fatal;
    testResults = r.tests;
    testResults.forEach((t) => opts.onTestResult?.(t));

    if (fatalError) {
      const isTimeout = /timeout/i.test(fatalError);
      failures.push({
        category: isTimeout ? "timeout" : "runtime_error",
        message: `Sandbox: ${fatalError}`,
        suggestion: isTimeout
          ? "Execution timed out. Ensure loop termination conditions and recursive calls terminate properly."
          : "Execution encountered a fatal runtime error. Check for unhandled exceptions during module load.",
      });
    } else if (testResults.length === 0) {
      failures.push({
        category: "missing_tests",
        message: "Sandbox: no acceptance tests were executed",
        suggestion: "Verify that the acceptance test suite registers executable tests via test('name', ...).",
      });
    } else {
      // Analyze failed test cases
      for (const t of testResults.filter((t) => !t.passed)) {
        const errorText = t.error ?? "unknown test failure";
        const reqIds = extractRequirementIds(t.name);
        const primaryReqId = reqIds[0];
        const req = spec.requirements.find((r) => r.id === primaryReqId);

        const { expected, actual } = parseAssertionDetails(errorText);
        const isContract = req?.kind === "error" || req?.kind === "invariant";

        failures.push({
          category: isContract ? "contract_violation" : "runtime_assertion",
          requirement_id: primaryReqId,
          requirement_kind: req?.kind,
          test_name: t.name,
          message: `Test "${t.name}" failed: ${errorText}`,
          expected,
          actual,
          suggestion: deriveSuggestion(req, errorText),
        });
      }
    }
  }

  // 5. Differential Comparison against original target Oracle baseline
  let differential: { attempted: boolean; matched: boolean; divergences: string[] } | undefined;
  if (spec.oracle.status === "passed" && spec.oracle.tests.length > 0 && testResults.length > 0) {
    const divergences: string[] = [];
    for (const origTest of spec.oracle.tests) {
      const candTest = testResults.find((t) => t.name === origTest.name);
      if (candTest && origTest.passed && !candTest.passed) {
        divergences.push(
          `Test "${origTest.name}" passed against original target code but failed in clean-room candidate: ${candTest.error}`,
        );
      }
    }
    differential = {
      attempted: true,
      matched: divergences.length === 0,
      divergences,
    };
    for (const div of divergences) {
      failures.push({
        category: "differential_divergence",
        message: div,
        suggestion:
          "The candidate engine behavior diverged from the baseline behavior recorded against the original target code. Re-check the expected logic.",
      });
    }
  }

  // 6. Requirement Coverage Computation
  const testedReqIds = new Set<string>();
  for (const t of testResults) {
    const ids = extractRequirementIds(t.name);
    ids.forEach((id) => testedReqIds.add(id));
  }
  const untested = spec.requirements.map((r) => r.id).filter((id) => !testedReqIds.has(id));

  // 7. Strict Pass/Fail Determination
  const passed =
    failures.length === 0 &&
    purity.length === 0 &&
    typeErrors.length === 0 &&
    cleanRoom.passed &&
    !fatalError &&
    testResults.length > 0 &&
    testResults.every((t) => t.passed);

  const status: "passed" | "failed" = passed ? "passed" : "failed";
  const passedTestsCount = testResults.filter((t) => t.passed).length;
  const summary = passed
    ? `Engine conforms to specification: all ${passedTestsCount}/${testResults.length} acceptance tests passed with 0 purity and 0 type errors.`
    : `Engine failed conformance: ${failures.length} issue(s) detected (${purity.length} purity, ${typeErrors.length} type, ${testResults.filter((t) => !t.passed).length} test failures).`;

  const actionable_feedback = formatActionableFeedback(failures, spec);

  return {
    passed,
    status,
    summary,
    purity_violations: purity,
    type_errors: typeErrors,
    test_results: testResults,
    failures,
    actionable_feedback,
    clean_room: cleanRoom,
    differential,
    requirement_coverage: {
      total: spec.requirements.length,
      tested: testedReqIds.size,
      untested,
    },
    limitations: [...ORACLE_LIMITATIONS],
    duration_ms: Date.now() - t0,
  };
}
