# 05 — Static Checks, Oracle, Coverage & Repair (`spec/buildSpec.ts`)

`buildSpec(evidence, app, feature, hooks)` → `FeatureSpec`. Loop: draft → check → oracle →
(repair ≤ 2) → assemble.

## 1. `src/spec/staticChecks.ts`

Cheap, deterministic checks that run before the oracle. Each returns a plain-English problem
that is fed straight back to the model.

```ts
import { transform } from "esbuild";
import type { RawEvidence } from "@splice/contracts";
import type { SpecDraft } from "./prompt.js";
import { snippetPath } from "./formatEvidence.js";

export function testNames(testsCode: string): string[] {
  return [...testsCode.matchAll(/\btest\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
}

export function reqIdsIn(name: string): string[] {
  return [...name.matchAll(/\bREQ-\d+\b/g)].map((m) => m[0]);
}

export function computeCoverage(draft: SpecDraft) {
  const names = testNames(draft.acceptance_tests);
  return draft.requirements.map((r) => ({
    requirement_id: r.id,
    test_names: names.filter((n) => reqIdsIn(n).includes(r.id)),
  }));
}

export async function staticChecks(draft: SpecDraft, ev: RawEvidence): Promise<string[]> {
  const problems: string[] = [];

  // requirement IDs: REQ-1..n, unique, no gaps
  draft.requirements.forEach((r, i) => {
    if (r.id !== `REQ-${i + 1}`) problems.push(`Requirement #${i + 1} has id ${r.id}; ids must be REQ-1..REQ-${draft.requirements.length} in order`);
  });

  // source refs point at real lines
  const lineCounts = new Map(ev.snippets.map((s) => [snippetPath(s.location), s.code.split(/\r?\n/).length]));
  for (const r of draft.requirements) {
    for (const ref of r.source_refs) {
      const m = ref.match(/^(.+):L(\d+)-L(\d+)$/);
      if (!m) { problems.push(`${r.id}: source ref "${ref}" must look like "path:L12-L18"`); continue; }
      const [, p, a, b] = m;
      const n = lineCounts.get(p);
      if (n === undefined) problems.push(`${r.id}: "${p}" is not one of the evidence files (${[...lineCounts.keys()].join(", ")})`);
      else if (+a < 1 || +b < +a || +b > n) problems.push(`${r.id}: lines L${a}-L${b} are outside ${p} (1-${n})`);
    }
  }

  // tests: every name tagged, tags exist, every requirement covered
  const ids = new Set(draft.requirements.map((r) => r.id));
  const names = testNames(draft.acceptance_tests);
  if (names.length === 0) problems.push("acceptance_tests registers no test(...) calls");
  for (const n of names) {
    const tags = reqIdsIn(n);
    if (tags.length === 0) problems.push(`Test "${n}" does not start with the REQ ids it covers`);
    for (const t of tags) if (!ids.has(t)) problems.push(`Test "${n}" references unknown ${t}`);
  }
  for (const c of computeCoverage(draft)) {
    if (c.test_names.length === 0) problems.push(`${c.requirement_id} is not covered by any test`);
  }

  // determinism
  if (/Date\.now\(|new Date\(\s*\)|Math\.random\(/.test(draft.acceptance_tests)) {
    problems.push("acceptance_tests use Date.now(), new Date() or Math.random(); tests must be deterministic");
  }

  // types_code: declarations only, declares every export
  if (/\bimport\s/.test(draft.types_code)) problems.push("types_code must not import anything");
  if (/export\s+function\s/.test(draft.types_code)) problems.push("types_code must use 'export declare function', not implementations");
  for (const e of draft.exports) {
    const re = new RegExp(`export\\s+(declare\\s+function|declare\\s+const|interface|type)\\s+${e.name}\\b`);
    if (!re.test(draft.types_code)) problems.push(`export "${e.name}" is listed but not declared in types_code`);
  }
  try {
    await transform(draft.types_code, { loader: "ts" });
  } catch (e) {
    problems.push(`types_code does not parse: ${(e as Error).message.split("\n")[0]}`);
  }

  // adapter delegates to the original
  if (!/\boriginal\(\s*["'`]/.test(draft.adapter_code)) problems.push("adapter_code never calls original(\"<path>\")");
  if (!/module\.exports\s*=/.test(draft.adapter_code)) problems.push("adapter_code must end with module.exports = { ... }");

  return problems;
}
```

## 2. Repair feedback (the exact text matters)

```ts
export function repairFeedback(problems: string[]): string {
  return `Your specification has problems. The ORIGINAL code is the ground truth.

<problems>
${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}
</problems>

For every test that FAILED against the original, decide which part is wrong:
- the test's expected value: re-trace the original code by hand, line by line, with that exact input; or
- the adapter's translation: field names, units, clock format, argument order.
Never change a requirement to describe behavior the original does not have. If a requirement is wrong, correct its statement to match what the original does.
Do not delete a test just because it fails; every requirement must stay covered.
Return the complete corrected specification with all fields, not a diff.`;
}
```

## 3. `src/spec/buildSpec.ts`

```ts
import { FeatureSpec, type RawEvidence, type PantryApp, type PantryFeature, type TestCaseResult, type OracleCheck } from "@splice/contracts";
import { structuredCall, continueWith } from "../llm/llm.js";
import { SPEC_DRAFT_SCHEMA } from "../llm/schemas.js";
import { runTests, type SandboxModule } from "../sandbox/runTests.js";
import { SPEC_SYSTEM, SpecDraft } from "./prompt.js";
import { formatEvidence, snippetPath } from "./formatEvidence.js";
import { staticChecks, computeCoverage, testNames, repairFeedback } from "./staticChecks.js";

export interface SpecHooks {
  signal?: AbortSignal;
  onStage(stage: "specifying" | "checking_oracle" | "repairing_spec", message: string): void;
  onProgress(phase: "specifying" | "repairing_spec", outputChars: number): void;
  onTestResult(t: TestCaseResult): void;
}

const MAX_REPAIRS = 2;
const EXECUTABLE = new Set(["electron_asar", "electron_dir", "javascript_bundle"]);

export async function buildSpec(ev: RawEvidence, app: PantryApp, feature: PantryFeature, hooks: SpecHooks): Promise<FeatureSpec> {
  const originals: SandboxModule[] = EXECUTABLE.has(ev.target.artifact_type)
    ? ev.snippets.filter((s) => s.full_module && s.language === "javascript").map((s) => ({ path: snippetPath(s.location), code: s.code }))
    : [];
  const executable = originals.length > 0;

  let messages: Parameters<typeof structuredCall>[0]["messages"] = [
    { role: "user", content: formatEvidence(ev, app, feature) },
  ];
  const call = (phase: "specifying" | "repairing_spec") =>
    structuredCall({
      role: "spec_writer",
      system: SPEC_SYSTEM,
      messages,
      schema: SPEC_DRAFT_SCHEMA,
      parse: (v) => SpecDraft.parse(v),
      effort: "high",
      maxTokens: 32_000,
      signal: hooks.signal,
      onProgress: (n) => hooks.onProgress(phase, n),
    });

  hooks.onStage("specifying", `Deriving requirements from ${ev.snippets.length} located modules`);
  let res = await call("specifying");

  for (let attempt = 0; ; attempt++) {
    const draft = res.value;
    const problems = await staticChecks(draft, ev);
    let oracle: OracleCheck;

    if (!executable) {
      oracle = { status: "not_executable", adapter_code: null, tests: [], passed: 0, total: 0 };
    } else if (problems.length > 0) {
      oracle = { status: "failed", adapter_code: draft.adapter_code, tests: [], passed: 0, total: 0 };
    } else {
      hooks.onStage("checking_oracle", `Running ${testNames(draft.acceptance_tests).length} acceptance tests against the ORIGINAL ${originals[0].path} via adapter`);
      const r = await runTests({
        kind: "oracle",
        originals,
        subject: { code: draft.adapter_code, lang: "js" },
        tests: draft.acceptance_tests,
      });
      r.tests.forEach(hooks.onTestResult);
      if (r.fatal) problems.push(`Sandbox: ${r.fatal}`);
      for (const t of r.tests.filter((t) => !t.passed)) problems.push(`Test "${t.name}" FAILED against the original: ${t.error}`);
      oracle = {
        status: !r.fatal && r.passed === r.total ? "passed" : "failed",
        adapter_code: draft.adapter_code,
        tests: r.tests,
        passed: r.passed,
        total: r.total,
      };
    }

    if (problems.length === 0 || attempt >= MAX_REPAIRS) {
      return assemble(ev, app, feature, draft, oracle, problems, attempt, res.model);
    }

    hooks.onStage("repairing_spec", `Repair ${attempt + 1}/${MAX_REPAIRS}: ${problems.length} problem(s), e.g. ${problems[0].slice(0, 140)}`);
    messages = continueWith(messages, res.assistantContent, repairFeedback(problems));
    res = await call("repairing_spec");
  }
}

function assemble(
  ev: RawEvidence, app: PantryApp, feature: PantryFeature, d: SpecDraft,
  oracle: OracleCheck, problems: string[], repairs: number, model: string,
): FeatureSpec {
  const open_issues = [...problems];
  if (oracle.status === "not_executable") open_issues.push("Requirements were not checked against the original (target is not executable JavaScript)");
  return FeatureSpec.parse({
    schema_version: 1,
    feature_id: feature.feature_id,
    app_id: app.app_id,
    source_app: app.display_name,
    source_icon: app.icon,
    artifact_type: ev.target.artifact_type,
    consumer_title: d.consumer_title,
    consumer_description: d.consumer_description,
    category: feature.category,
    requirements: d.requirements,
    interface: { module_name: d.module_name, exports: d.exports, types_code: d.types_code },
    inputs: d.inputs,
    outputs: d.outputs,
    acceptance_tests: d.acceptance_tests,
    coverage: computeCoverage(d),
    allowed_deviations: d.allowed_deviations,
    stripped_glue: d.stripped_glue,
    oracle,
    status: open_issues.length === 0 && oracle.status === "passed" ? "verified" : "unverified",
    open_issues,
    repair_attempts: repairs,
    provenance: {
      mode: ev.mode,
      target: ev.target,
      rea_package_version: ev.rea_package_version,
      tool_calls: ev.tool_calls,
      snippets: ev.snippets,
      limitations: ev.limitations,
      unknowns: ev.unknowns,
      collected_at: ev.collected_at,
      specified_at: new Date().toISOString(),
      model,
    },
  });
}
```

Design notes:
- **Unverified specs are still returned.** The card shows them amber with `open_issues`. Eng 3
  can still implement them, but the UI must never call them "verified".
- **Coverage is computed from test names, not claimed by the model.**
- **The call counter** (04) means an adapter that hard-codes answers can't pass. Every test
  must reach original code.
- **Repairs are append-only** (`continueWith`): the model sees its own previous answer plus
  the failures, which works better than starting over.
- Cost and latency: one spec call at `high` effort is roughly 20–60 s. A repair is another
  call. Worst case ≈ 3 calls. The UI shows `llm_progress` so the wait is visible.

## 4. What the oracle catches (talk track for judges)

| Invented requirement | What happens |
|---|---|
| "`nextEaseFactor` rejects grade 9" (original `updateEase` doesn't validate) | Test fails against the original → repair narrows REQ-8 to `reviewCard` |
| "Links are matched case-sensitively" (original lower-cases titles) | Fails → repaired to "case-insensitive, whitespace collapsed" |
| "Ties in search are broken by score only" (original also sorts by title) | Two-note tie test fails → requirement gains the tie-break |
| Adapter returns constants instead of calling the original | Call counter fails every test: "never called original code" |
