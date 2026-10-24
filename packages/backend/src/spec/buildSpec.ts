// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/05_oracle_coverage_and_repair.md §3
import {
  FeatureSpec,
  type RawEvidence,
  type PantryApp,
  type PantryFeature,
  type TestCaseResult,
  type OracleCheck,
} from "@splice/contracts";
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

export async function buildSpec(
  ev: RawEvidence,
  app: PantryApp,
  feature: PantryFeature,
  hooks: SpecHooks,
): Promise<FeatureSpec> {
  const originals: SandboxModule[] = EXECUTABLE.has(ev.target.artifact_type)
    ? ev.snippets
        .filter((s) => s.full_module && s.language === "javascript")
        .map((s) => ({ path: snippetPath(s.location), code: s.code }))
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
      const testsCount = testNames(draft.acceptance_tests).length;
      const targetPath = originals[0]?.path ?? "target";
      hooks.onStage(
        "checking_oracle",
        `Running ${testsCount} acceptance tests against the ORIGINAL ${targetPath} via adapter`,
      );
      const r = await runTests({
        kind: "oracle",
        originals,
        subject: { code: draft.adapter_code, lang: "js" },
        tests: draft.acceptance_tests,
      });
      r.tests.forEach((t) =>
        hooks.onTestResult({
          name: t.name,
          kind: "oracle",
          passed: t.passed,
          error: t.error ?? null,
          duration_ms: t.duration_ms,
        }),
      );
      if (r.fatal) problems.push(`Sandbox: ${r.fatal}`);
      for (const t of r.tests.filter((t) => !t.passed)) {
        problems.push(`Test "${t.name}" FAILED against the original: ${t.error}`);
      }
      oracle = {
        status: !r.fatal && r.passed === r.total ? "passed" : "failed",
        adapter_code: draft.adapter_code,
        tests: r.tests.map((t) => ({ ...t, error: t.error ?? null })),
        passed: r.passed,
        total: r.total,
      };
    }

    if (problems.length === 0 || attempt >= MAX_REPAIRS) {
      return assemble(ev, app, feature, draft, oracle, problems, attempt, res.model);
    }

    hooks.onStage(
      "repairing_spec",
      `Repair ${attempt + 1}/${MAX_REPAIRS}: ${problems.length} problem(s), e.g. ${problems[0].slice(0, 140)}`,
    );
    messages = continueWith(messages, res.assistantContent, repairFeedback(problems));
    res = await call("repairing_spec");
  }
}

function assemble(
  ev: RawEvidence,
  app: PantryApp,
  feature: PantryFeature,
  d: SpecDraft,
  oracle: OracleCheck,
  problems: string[],
  repairs: number,
  model: string,
): FeatureSpec {
  const open_issues = [...problems];
  if (oracle.status === "not_executable") {
    open_issues.push("Requirements were not checked against the original (target is not executable JavaScript)");
  }
  return FeatureSpec.parse({
    schema_version: 1,
    feature_id: feature.feature_id,
    app_id: app.app_id,
    source_app: app.display_name,
    source_icon: app.icon || "Cpu",
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
