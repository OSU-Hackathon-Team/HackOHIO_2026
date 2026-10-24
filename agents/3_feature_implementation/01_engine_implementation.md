# 01 — Engine Implementation (`POST /api/implement`)

`FeatureSpec` → `FeatureBlueprint`. The model gets **only the spec**: requirements, interface,
acceptance tests and allowed deviations. **Never send `provenance.snippets` (the original
source) or `oracle.adapter_code` to this prompt.** That separation is what lets us say the
engine was built from the spec.

## 1. Output schema

```ts
// src/engine/prompt.ts
import { z } from "zod";

export const EngineDraft = z.object({
  portable_code: z.string().min(1),
  notes: z.array(z.string()).max(8),
});
export type EngineDraft = z.infer<typeof EngineDraft>;

export const ENGINE_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    portable_code: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["portable_code", "notes"],
  additionalProperties: false,
} as const;
```

## 2. System prompt

```ts
export const ENGINE_SYSTEM = `You implement TypeScript modules from a written specification. You have NOT seen any original implementation and must not guess at one beyond what the specification states.

Respond with JSON matching the provided schema:
- portable_code: one complete TypeScript module.
- notes: up to 8 short notes on non-obvious decisions (e.g. "rounding uses Math.round to 2 decimals per REQ-5").

Rules for portable_code:
1. It must satisfy the interface exactly: export every declared function with the same name and a compatible signature, and export every declared interface/type with the same name and the same shape. You may copy the interface declarations verbatim (dropping "declare").
2. Pure and deterministic: no imports, no require, no globals from the environment (process, window, document, localStorage, fetch, timers), no Date.now(), no new Date() without arguments, no Math.random(). Everything the function needs arrives through its parameters. new Date("<given string>") and Date.parse(<given string>) are fine.
3. No console output. Throw built-in errors (RangeError, TypeError, Error) where the requirements say to throw.
4. Implement every requirement. The acceptance tests are examples of the requirements, not the whole of them: do not special-case test inputs.
5. Small private helpers are fine; keep the module readable, under about 200 lines, with a one-line comment on each exported function naming the requirements it implements.
6. TypeScript strict mode must pass: no implicit any, no unused-variable errors that would fail compilation.`;
```

User message:

```ts
import type { FeatureSpec } from "@splice/contracts";

export function formatSpecForImplementer(spec: FeatureSpec): string {
  const reqs = spec.requirements.map((r) => `${r.id} [${r.kind}] ${r.statement}`).join("\n");
  return `<module name="${spec.interface.module_name}">
${spec.consumer_title}: ${spec.consumer_description}
</module>

<requirements>
${reqs}
</requirements>

<interface>
${spec.interface.types_code}
</interface>

<allowed_deviations>
${spec.allowed_deviations.join("\n") || "none"}
</allowed_deviations>

<acceptance_tests>
// Globals: test, assert (equal, deepEqual, ok, closeTo, throws) and every export of your module.
${spec.acceptance_tests}
</acceptance_tests>

Implement the module.`;
}
```

## 3. Purity scan — `src/engine/purity.ts`

```ts
const RULES: [RegExp, string][] = [
  [/\bimport\s[^;]*from\s|^\s*import\s*["']/m, "imports are not allowed"],
  [/\brequire\s*\(/, "require() is not allowed"],
  [/\bprocess\./, "process is not available"],
  [/\b(window|document|localStorage|sessionStorage|navigator)\b\s*\./, "browser globals are not allowed"],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, "network access is not allowed"],
  [/\bset(Timeout|Interval|Immediate)\s*\(/, "timers are not allowed"],
  [/\bMath\.random\s*\(/, "Math.random() makes the engine nondeterministic"],
  [/\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/, "reading the clock makes the engine nondeterministic; take the date as a parameter"],
  [/\bconsole\./, "console output is not allowed"],
  [/\beval\s*\(|\bnew\s+Function\s*\(/, "eval is not allowed"],
];

/** Strip comments and string/template contents so rules don't fire on text. Approximate but good enough. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

export function purityViolations(src: string): string[] {
  const code = codeOnly(src);
  return RULES.filter(([re]) => re.test(code)).map(([, msg]) => msg);
}
```

## 4. Type conformance — engine vs `types_code`

Uses `typecheckVirtual` from `03_bundle_validator.md`. For each exported **function**, the
engine's value must be assignable to the declared type. For each exported **type**, both
directions must be assignable (same shape).

```ts
import type { FeatureSpec } from "@splice/contracts";
import { typecheckVirtual } from "../typecheck/virtualTsc.js";

export function conformanceErrors(spec: FeatureSpec, engineCode: string): string[] {
  const fnNames = spec.interface.exports.filter((e) => e.kind === "function").map((e) => e.name);
  const typeNames = spec.interface.exports.filter((e) => e.kind === "type").map((e) => e.name);
  const check = [
    `import * as impl from "./engine";`,
    `import type * as S from "./interface";`,
    ...fnNames.map((n) => `const _f_${n}: typeof import("./interface").${n} = impl.${n};`),
    ...typeNames.flatMap((n) => [
      `declare const _a_${n}: import("./engine").${n};`,
      `const _b_${n}: S.${n} = _a_${n};`,
      `declare const _c_${n}: S.${n};`,
      `const _d_${n}: import("./engine").${n} = _c_${n};`,
    ]),
    `export {};`,
  ].join("\n");
  return typecheckVirtual(
    { "/engine.ts": engineCode, "/interface.ts": spec.interface.types_code, "/check.ts": check },
    { strict: true, jsx: false },
  );
}
```

> A missing export shows up as "Module './engine' has no exported member X" or "Property 'X'
> does not exist on type typeof import('./engine')". Both are clear enough to feed back to the
> model as they are.

## 5. `src/engine/implement.ts`

```ts
import { FeatureBlueprint, type FeatureSpec, type TestCaseResult } from "@splice/contracts";
import { structuredCall, continueWith } from "../llm/llm.js";
import { runTests } from "../sandbox/runTests.js";
import { ENGINE_SYSTEM, ENGINE_DRAFT_SCHEMA, EngineDraft, formatSpecForImplementer } from "./prompt.js";
import { purityViolations } from "./purity.js";
import { conformanceErrors } from "./conformance.js";

export interface ImplementHooks {
  signal?: AbortSignal;
  onStage(stage: "implementing" | "testing" | "repairing_engine", message: string): void;
  onProgress(phase: "implementing" | "repairing_engine", outputChars: number): void;
  onTestResult(t: TestCaseResult): void;
}

const MAX_REPAIRS = 2;

export async function implementEngine(spec: FeatureSpec, hooks: ImplementHooks): Promise<FeatureBlueprint> {
  const t0 = Date.now();
  let messages: Parameters<typeof structuredCall>[0]["messages"] = [
    { role: "user", content: formatSpecForImplementer(spec) },
  ];
  const call = (phase: "implementing" | "repairing_engine") =>
    structuredCall({
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

  hooks.onStage("implementing", `Implementing ${spec.interface.module_name} from ${spec.requirements.length} requirements (original source withheld)`);
  let res = await call("implementing");

  for (let attempt = 0; ; attempt++) {
    const code = res.value.portable_code;
    const purity = purityViolations(code);
    const typeErrors = purity.length ? [] : conformanceErrors(spec, code);

    let tests: TestCaseResult[] = [];
    let fatal: string | null = null;
    if (purity.length === 0 && typeErrors.length === 0) {
      hooks.onStage("testing", `Running ${spec.oracle.total || "the"} acceptance tests against the new engine`);
      const r = await runTests({ kind: "acceptance", subject: { code, lang: "ts" }, tests: spec.acceptance_tests });
      fatal = r.fatal;
      tests = r.tests;
      tests.forEach(hooks.onTestResult);
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
    messages = continueWith(messages, res.assistantContent,
      `Your module does not meet the specification yet:\n<failures>\n${failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n</failures>\n` +
      `Fix the implementation so it satisfies the requirements (not just these tests). Return the complete module.`);
    res = await call("repairing_engine");
  }
}
```

(`conformanceErrors` from §4 lives in `src/engine/conformance.ts`.)

## 6. Store & route — `src/routes/step3/index.ts` (implement part)

```ts
import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { ImplementRequest, FeatureBlueprint, type PipelineEvent, type PipelineStage } from "@splice/contracts";
import { config, REPO_ROOT } from "../../config.js";
import { openSse, newRunId } from "../../http/sse.js";
import { createTranscript } from "../../evidence/recorder.js";
import { replayTranscript } from "../../evidence/replay.js";
import { implementEngine } from "../../engine/implement.js";

export const step3Router = Router();
const BP_DIR = path.join(REPO_ROOT, "fixtures/blueprints");

step3Router.get("/api/blueprints", async (_req, res, next) => {
  try {
    const out = new Map<string, FeatureBlueprint>();
    for (const dir of [BP_DIR, path.join(BP_DIR, "_seed")]) {
      let files: string[] = [];
      try { files = await fs.readdir(dir); } catch { continue; }
      for (const f of files.filter((f) => f.endsWith(".json") && !f.endsWith(".latest.json"))) {
        const bp = FeatureBlueprint.parse(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
        if (!out.has(bp.feature_id)) out.set(bp.feature_id, bp);
      }
    }
    res.json([...out.values()]);
  } catch (e) { next(e); }
});

step3Router.post("/api/implement", async (req, res) => {
  const parsed = ImplementRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { spec, force_mode } = parsed.data;
  const feature_id = spec.feature_id;
  const sse = openSse(req, res);
  const run_id = newRunId();
  const base = () => ({ run_id, feature_id, ts: Date.now() });

  if ((force_mode ?? config.llmMode) === "replay") {
    const ok = await replayTranscript("implement", feature_id, sse, { runId: run_id });
    if (!ok) {
      sse.send({ type: "error", ...base(), message: `No recording for ${feature_id}`, fatal: true });
      sse.send({ type: "done", ...base(), ok: false, replayed: true });
    }
    return sse.close();
  }

  const transcript = createTranscript("implement", feature_id);
  const emit = (e: PipelineEvent) => { sse.send(e); transcript.push(e); };
  const stage = (stage: PipelineStage, message: string) => emit({ type: "stage", ...base(), stage, message });
  let ok = false;
  try {
    const bp = await implementEngine(spec, {
      signal: sse.signal,
      onStage: stage,
      onProgress: (phase, output_chars) => emit({ type: "llm_progress", ...base(), phase, output_chars }),
      onTestResult: (t) => emit({ type: "test_result", ...base(), name: t.name, kind: "acceptance", passed: t.passed, error: t.error }),
    });
    await fs.mkdir(BP_DIR, { recursive: true });
    await fs.writeFile(path.join(BP_DIR, `${feature_id}.latest.json`), JSON.stringify(bp, null, 2));
    emit({ type: "blueprint", ...base(), blueprint: bp });
    stage(bp.verification.status === "passed" ? "complete" : "failed",
      `Engine ${bp.implementation.module_name}: ${bp.verification.passed}/${bp.verification.total} acceptance tests passing`);
    ok = bp.verification.status === "passed";
  } catch (e) {
    if (!sse.signal.aborted) emit({ type: "error", ...base(), message: (e as Error).message, fatal: true });
  } finally {
    emit({ type: "done", ...base(), ok, replayed: false });
    await transcript.save(ok);
    sse.close();
  }
});
```

## 7. Test script — `npm run test:implement [feature_id]`

Loads `fixtures/specs/<id>.json` (or `_seed`), runs `implementEngine` with console hooks, and
prints `passed/total`, purity, type errors, repairs, seconds and model. Exit code 1 if any
engine fails. Run it for all 4 golden specs before CP2.
