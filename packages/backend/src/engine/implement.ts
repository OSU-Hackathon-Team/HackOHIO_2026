// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/01_engine_implementation.md §5
// Implementation note: structuredCall/continueWith/runTests arrive as injected ports (./ports.ts)
// until Eng 2's llm.ts and sandbox/ land; routes/step3/deps.ts wires the real ones.
import { FeatureBlueprint, type FeatureSpec, type TestCaseResult } from "@splice/contracts";
import { ENGINE_SYSTEM, ENGINE_DRAFT_SCHEMA, EngineDraft, formatSpecForImplementer } from "./prompt.js";
import { purityViolations } from "./purity.js";
import { conformanceErrors } from "./conformance.js";
import type { ChatMessage, LlmPort, SandboxPort } from "./ports.js";

export interface ImplementHooks {
  signal?: AbortSignal;
  onStage(stage: "implementing" | "testing" | "repairing_engine", message: string): void;
  onProgress(phase: "implementing" | "repairing_engine", outputChars: number): void;
  onTestResult(t: TestCaseResult): void;
}

export interface ImplementDeps {
  llm: LlmPort;
  sandbox: SandboxPort;
}

export const MAX_REPAIRS = 2;

export async function implementEngine(spec: FeatureSpec, hooks: ImplementHooks, deps: ImplementDeps): Promise<FeatureBlueprint> {
  const t0 = Date.now();
  let messages: ChatMessage[] = [{ role: "user", content: formatSpecForImplementer(spec) }];
  const call = (phase: "implementing" | "repairing_engine") => {
    hooks.signal?.throwIfAborted();
    return deps.llm.structuredCall({
      role: "engine_writer",
      system: ENGINE_SYSTEM,
      messages,
      schema: ENGINE_DRAFT_SCHEMA,
      parse: (v) => EngineDraft.parse(v),
      effort: "high",
      maxTokens: 24_000,
      signal: hooks.signal,
      onProgress: (n) => hooks.onProgress(phase, n),
    });
  };

  hooks.onStage("implementing", `Implementing ${spec.interface.module_name} from ${spec.requirements.length} requirements (original source withheld)`);
  let res = await call("implementing");

  for (let attempt = 0; ; attempt++) {
    const code = res.value.portable_code;
    const purity = purityViolations(code);
    const typeErrors = purity.length ? [] : conformanceErrors(spec, code);

    let tests: TestCaseResult[] = [];
    let fatal: string | null = null;
    if (purity.length === 0 && typeErrors.length === 0) {
      hooks.signal?.throwIfAborted();
      hooks.onStage("testing", `Running ${spec.oracle.total || "the"} acceptance tests against the new engine`);
      const r = await deps.sandbox.runTests({ kind: "acceptance", subject: { code, lang: "ts" }, tests: spec.acceptance_tests });
      fatal = r.fatal;
      tests = r.tests;
      tests.forEach(hooks.onTestResult);
      if (!fatal && tests.length === 0) fatal = "no acceptance tests were executed";
    }

    const failures = [
      ...purity.map((p) => `Purity: ${p}`),
      ...typeErrors.map((e) => `Type: ${e}`),
      ...(fatal ? [`Sandbox: ${fatal}`] : []),
      ...tests.filter((t) => !t.passed).map((t) => `Test "${t.name}" failed: ${t.error}`),
    ];
    const passed = failures.length === 0 && tests.length > 0;

    if (passed || attempt >= MAX_REPAIRS) {
      return FeatureBlueprint.parse({
        schema_version: 1,
        feature_id: spec.feature_id,
        spec,
        implementation: { module_name: spec.interface.module_name, portable_code: code, notes: res.value.notes },
        verification: {
          status: passed ? "passed" : "failed",
          tests,
          passed: tests.filter((t) => t.passed).length,
          total: tests.length,
          purity_violations: purity,
          type_errors: typeErrors,
          repair_attempts: attempt,
          duration_ms: Date.now() - t0,
          implemented_at: new Date().toISOString(),
          model: res.model,
          mode: "live",
        },
      });
    }

    hooks.onStage("repairing_engine", `Repair ${attempt + 1}/${MAX_REPAIRS}: ${failures.length} failure(s), e.g. ${failures[0].slice(0, 140)}`);
    messages = deps.llm.continueWith(messages, res.assistantContent,
      `Your module does not meet the specification yet:\n<failures>\n${failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n</failures>\n` +
      `Fix the implementation so it satisfies the requirements (not just these tests). Return the complete module.`);
    res = await call("repairing_engine");
  }
}
