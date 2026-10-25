// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/01_engine_implementation.md §5
// Conformance Oracle & Refinement Loop: Step 3
import {
  FeatureBlueprint,
  type FeatureSpec,
  type TestCaseResult,
} from "@splice/contracts";
import {
  ENGINE_SYSTEM,
  ENGINE_DRAFT_SCHEMA,
  EngineDraft,
  formatSpecForImplementer,
} from "./prompt.js";
import { evaluateEngineConformance } from "./oracle.js";
import type { ChatMessage, LlmPort, SandboxPort } from "./ports.js";
import { structuredCall, continueWith } from "../llm/llm.js";
import { runTests } from "../sandbox/runTests.js";

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

export interface ImplementOptions {
  timeoutMs?: number;
}

export const MAX_REPAIRS = 2;

const defaultDeps: ImplementDeps = {
  llm: { structuredCall, continueWith },
  sandbox: { runTests },
};

export async function implementEngine(
  spec: FeatureSpec,
  hooks: ImplementHooks,
  deps: ImplementDeps = defaultDeps,
  options?: ImplementOptions,
): Promise<FeatureBlueprint> {
  const t0 = Date.now();
  let messages: ChatMessage[] = [{ role: "user", content: formatSpecForImplementer(spec) }];

  let effectiveSignal = hooks.signal;
  let timer: NodeJS.Timeout | undefined;
  if (options?.timeoutMs && options.timeoutMs > 0) {
    const ac = new AbortController();
    timer = setTimeout(() => {
      ac.abort(new Error(`implementEngine timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    if (hooks.signal) {
      hooks.signal.addEventListener("abort", () => ac.abort(hooks.signal?.reason), { once: true });
    }
    effectiveSignal = ac.signal;
  }

  try {
    const call = (phase: "implementing" | "repairing_engine") => {
      effectiveSignal?.throwIfAborted();
      return deps.llm.structuredCall({
        role: "engine_writer",
        system: ENGINE_SYSTEM,
        messages,
        schema: ENGINE_DRAFT_SCHEMA,
        parse: (v) => EngineDraft.parse(v),
        effort: "high",
        maxTokens: 24_000,
        signal: effectiveSignal,
        onProgress: (n) => hooks.onProgress(phase, n),
      });
    };

    hooks.onStage(
      "implementing",
      `Implementing ${spec.interface.module_name} from ${spec.requirements.length} requirements (original source withheld)`,
    );
    let res = await call("implementing");

    for (let attempt = 0; ; attempt++) {
      effectiveSignal?.throwIfAborted();
      const code = res.value.portable_code;

      const report = await evaluateEngineConformance(spec, code, {
        sandbox: deps.sandbox,
        signal: effectiveSignal,
        timeoutMs: options?.timeoutMs,
        onTestResult: hooks.onTestResult,
        onStage: (stage, msg) => hooks.onStage(stage, msg),
      });

      if (report.passed || attempt >= MAX_REPAIRS) {
        return FeatureBlueprint.parse({
          schema_version: 1,
          feature_id: spec.feature_id,
          spec,
          implementation: {
            module_name: spec.interface.module_name,
            portable_code: code,
            notes: res.value.notes,
          },
          verification: {
            status: report.passed ? "passed" : "failed",
            tests: report.test_results,
            passed: report.test_results.filter((t) => t.passed).length,
            total: report.test_results.length,
            purity_violations: report.purity_violations,
            type_errors: report.type_errors,
            repair_attempts: attempt,
            duration_ms: Date.now() - t0,
            implemented_at: new Date().toISOString(),
            model: res.model,
            mode: "live",
          },
        });
      }

      hooks.onStage(
        "repairing_engine",
        `Repair ${attempt + 1}/${MAX_REPAIRS}: ${report.failures.length} failure(s), e.g. ${report.failures[0]?.message.slice(0, 140) ?? "unknown"}`,
      );
      if (!report.clean_room.passed) {
        // Do not replay a rejected candidate as assistant history: it may contain copied
        // target text. Restart from the clean spec and sanitized clean-room feedback.
        messages = [{
          role: "user",
          content: `${formatSpecForImplementer(spec)}\n\n${report.actionable_feedback}`,
        }];
      } else {
        messages = deps.llm.continueWith(messages, res.assistantContent, report.actionable_feedback);
      }
      res = await call("repairing_engine");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
