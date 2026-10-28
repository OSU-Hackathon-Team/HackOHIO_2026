import ts from "typescript";
import {
  CapabilityDefinition,
  CapabilityIntakeRequest,
  ElectronContractSpec,
  FeatureSpec,
  NativeSubsystemSpec,
  WireObjectSchema,
  encodeWireValue,
  wireSchemaProblems,
  type CapabilityIntakeRecord,
  type CapabilityOrigin,
  type IntakeBlocker,
  type OperationSpec,
  type PublicTestCase,
} from "@splice/contracts";
import { hashJson } from "./identity.js";

const timestamp = (date: Date) => date.toISOString();

export interface IntakeAssessment {
  record: CapabilityIntakeRecord;
  originArtifact: unknown;
}

const blocker = (
  code: string,
  message: string,
  owner: IntakeBlocker["owner"],
  question: string | null,
): IntakeBlocker => ({ code, message, owner, question });

function operationMap(definition: CapabilityDefinition): Map<string, OperationSpec> {
  return new Map(definition.operations.map((operation) => [operation.name, operation]));
}

function tsTestProblems(test: PublicTestCase, operations: Map<string, OperationSpec>): string[] {
  const source = ts.createSourceFile(`${test.name}.test.ts`, test.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const syntax = ts.transpileModule(test.code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics ?? [];
  if (syntax.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) problems.push("test body has TypeScript syntax errors");
  if (source.statements.some((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) {
    problems.push("test body may not import or export code");
  }

  let calls = 0;
  let assertions = 0;
  const calledOperations = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "call" &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "ctx"
      ) {
        calls += 1;
        const operationName = node.arguments[0];
        if (!operationName || !ts.isStringLiteral(operationName)) {
          problems.push("ctx.call must name an operation with a string literal");
        } else if (!operations.has(operationName.text)) {
          problems.push(`ctx.call references unknown operation ${operationName.text}`);
        } else {
          calledOperations.add(operationName.text);
        }
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === "ctx" &&
        expression.expression.name.text === "assert"
      ) {
        assertions += 1;
        if (expression.name.text === "ok" && node.arguments.length === 1 && node.arguments[0].kind === ts.SyntaxKind.TrueKeyword) {
          problems.push("assert.ok(true) is not an executable behavior assertion");
        }
      }
      if (ts.isIdentifier(expression) && ["eval", "Function", "require"].includes(expression.text)) {
        problems.push(`${expression.text} is not allowed in a test body`);
      }
    }
    if (ts.isImportDeclaration(node) || ts.isImportTypeNode(node)) problems.push("dynamic or static imports are not allowed in a test body");
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (calls === 0) problems.push("test does not call a declared capability operation");
  if (assertions === 0) problems.push("test does not make an assertion through ctx.assert");
  if (calledOperations.size === 0) problems.push("test has no checked operation call");
  return [...new Set(problems)];
}

interface NativeCase {
  op: string;
  args: Record<string, unknown>;
  expect?: Record<string, unknown>;
  expect_error?: { code: string };
}

function cTestProblems(test: PublicTestCase, operations: Map<string, OperationSpec>): string[] {
  const problems: string[] = [];
  let cases: unknown;
  try {
    cases = JSON.parse(test.code);
  } catch {
    return ["C harness must be a JSON array of operation cases"];
  }
  if (!Array.isArray(cases) || cases.length === 0) return ["C test has no executable cases"];
  for (const [index, raw] of cases.entries()) {
    const prefix = `case ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${prefix} must be an object`);
      continue;
    }
    const item = raw as Partial<NativeCase>;
    if (typeof item.op !== "string" || !operations.has(item.op)) {
      problems.push(`${prefix} references an unknown operation`);
      continue;
    }
    const operation = operations.get(item.op)!;
    if (!item.args || typeof item.args !== "object" || Array.isArray(item.args)) {
      problems.push(`${prefix} needs an args object`);
      continue;
    }
    try {
      encodeWireValue(operation.request, item.args);
    } catch (error) {
      problems.push(`${prefix} args: ${error instanceof Error ? error.message : String(error)}`);
    }
    const hasValue = item.expect !== undefined;
    const hasError = item.expect_error !== undefined;
    if (hasValue === hasError) {
      problems.push(`${prefix} must have exactly one of expect or expect_error`);
    } else if (hasValue) {
      try {
        encodeWireValue(operation.result, item.expect);
      } catch (error) {
        problems.push(`${prefix} expected result: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (hasError) {
      const codeField = operation.error.fields.find((field) => field.name === "code");
      if (typeof item.expect_error?.code !== "string") problems.push(`${prefix} error needs a code`);
      else if (codeField?.type.kind === "enum" && !codeField.type.values.includes(item.expect_error.code)) {
        problems.push(`${prefix} expects undeclared error code ${item.expect_error.code}`);
      }
    }
  }
  return problems;
}

function validateOrigin(
  origin: CapabilityOrigin,
  artifact: unknown,
  attestation: CapabilityIntakeRequest["review_attestation"],
  blockers: IntakeBlocker[],
): "passed" | "unknown" | "not_applicable" {
  const artifactHash = hashJson(artifact);
  if (origin.artifact_hash !== artifactHash) {
    blockers.push(blocker("origin_hash_mismatch", "Capability origin hash does not match the supplied public artifact", "upstream", "Provide the immutable public artifact whose canonical SHA-256 is recorded in the definition."));
  }
  switch (origin.kind) {
    case "authored":
      if (origin.stage !== "downstream_authored") blockers.push(blocker("origin_stage_mismatch", "Authored capabilities must use downstream_authored stage", "downstream", null));
      return "not_applicable";
    case "feature_spec": {
      const parsed = FeatureSpec.safeParse(artifact);
      if (!parsed.success) {
        blockers.push(blocker("feature_spec_invalid", "The origin artifact is not a valid FeatureSpec", "upstream", "Supply an immutable FeatureSpec produced by the requirements pipeline."));
        return "unknown";
      }
      if (origin.stage !== "requirements" || origin.source_app !== parsed.data.source_app) {
        blockers.push(blocker("origin_metadata_mismatch", "FeatureSpec origin metadata does not match the public artifact", "upstream", "Align the origin stage and source application with the FeatureSpec."));
      }
      if (parsed.data.status !== "verified" || parsed.data.oracle.status !== "passed" || parsed.data.open_issues.length > 0) {
        blockers.push(blocker("feature_spec_unverified", "FeatureSpec is not verified against its original behavior", "upstream", "Resolve the spec's open issues and pass its original-code oracle before creating a reusable capability."));
        return "unknown";
      }
      return "passed";
    }
    case "native_subsystem_spec": {
      const parsed = NativeSubsystemSpec.safeParse(artifact);
      if (!parsed.success) {
        blockers.push(blocker("native_spec_invalid", "The origin artifact is not a schema 2 NativeSubsystemSpec", "upstream", "Supply the immutable public schema 2 native spec."));
        return "unknown";
      }
      if (origin.stage !== "native_spec") blockers.push(blocker("origin_stage_mismatch", "Native subsystem specs must use native_spec stage", "upstream", null));
      if (parsed.data.status === "draft") {
        blockers.push(blocker("native_spec_draft", "Draft native specs cannot enter the capability registry", "upstream", "Complete evidence collection and publish a reviewable public spec."));
        return "unknown";
      }
      if (!attestation || attestation.status !== "approved" || attestation.artifact_hash !== artifactHash) {
        blockers.push(blocker("native_review_required", "ready_for_review is not an approval; an artifact-bound approval is required", "upstream", "Record an approved human review for this exact spec hash before implementation."));
        return "unknown";
      }
      return "passed";
    }
    case "electron_contract": {
      const parsed = ElectronContractSpec.safeParse(artifact);
      if (!parsed.success) {
        blockers.push(blocker("electron_spec_invalid", "The origin artifact is not a valid schema 2 Electron behavioral handoff", "upstream", "Supply the immutable public spec.json from a completed reconstruction run."));
        return "unknown";
      }
      if (origin.stage !== "electron_reconstruction") blockers.push(blocker("origin_stage_mismatch", "Electron contracts must use electron_reconstruction stage", "upstream", null));
      if (origin.source_app !== parsed.data.application.name) {
        blockers.push(blocker("origin_metadata_mismatch", "Electron contract origin names a different application", "upstream", "Align the origin source application with the handoff's application name."));
      }
      if ((parsed.data.application.blockers ?? []).length > 0 || (parsed.data.application.unresolved ?? []).length > 0) {
        blockers.push(blocker("electron_spec_blocked", "The handoff still declares readiness blockers or unresolved questions", "upstream", "Resolve the spec blockers and publish a complete handoff revision."));
        return "unknown";
      }
      if (!attestation || attestation.status !== "approved" || attestation.artifact_hash !== artifactHash) {
        blockers.push(blocker("electron_review_required", "A reconstructed contract needs an artifact-bound approval before implementation", "upstream", "Record an approved human review for this exact handoff hash before implementation."));
        return "unknown";
      }
      return "passed";
    }
  }
}

function testBlockers(
  definition: CapabilityDefinition,
  tests: PublicTestCase[],
  blockers: IntakeBlocker[],
): void {
  const operations = operationMap(definition);
  const names = new Set<string>();
  const specs = new Map(definition.public_tests.map((test) => [test.name, test]));
  for (const test of tests) {
    if (names.has(test.name)) blockers.push(blocker("duplicate_test", `Public test ${test.name} is duplicated`, "downstream", null));
    names.add(test.name);
    const spec = specs.get(test.name);
    if (!spec || spec.kind !== "public") {
      blockers.push(blocker("test_not_declared", `Public test ${test.name} is not declared in the capability definition`, "downstream", "Declare the test and its requirement IDs in CapabilityDefinition.public_tests."));
    } else if (spec.requirement_ids.join("\0") !== test.requirement_ids.join("\0")) {
      blockers.push(blocker("test_requirement_mismatch", `Public test ${test.name} has different requirement IDs in its definition and executable case`, "downstream", "Keep the definition metadata and executable test traceability identical."));
    }
    if (test.harness === "ts") {
      for (const problem of tsTestProblems(test, operations)) blockers.push(blocker("test_not_executable", `${test.name}: ${problem}`, "downstream", "Write a test that invokes a declared operation and checks its result through the supplied harness."));
    } else {
      for (const problem of cTestProblems(test, operations)) blockers.push(blocker("test_not_executable", `${test.name}: ${problem}`, "downstream", "Use the C JSON operation-case format and assert a schema-valid result or declared error."));
    }
  }
  for (const spec of specs.values()) {
    if (!names.has(spec.name)) blockers.push(blocker("test_missing", `Declared public test ${spec.name} has no executable case`, "downstream", "Supply executable public test code for every declared test."));
  }
}

export function assessCapabilityIntake(
  raw: unknown,
  now: Date = new Date(),
): IntakeAssessment {
  const parsed = CapabilityIntakeRequest.safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error("Invalid capability intake request"), { status: 400, errors: parsed.error.flatten() });
  const request = parsed.data;
  const definition = CapabilityDefinition.parse(request.definition);
  const originArtifactHash = hashJson(request.origin_artifact);
  const blockers: IntakeBlocker[] = [];
  const upstreamStatus = validateOrigin(definition.origin, request.origin_artifact, request.review_attestation, blockers);

  if (request.review_attestation && request.review_attestation.artifact_hash !== originArtifactHash) {
    blockers.push(blocker("review_hash_mismatch", "Review attestation refers to a different origin artifact", "upstream", "Reissue the review attestation for the exact artifact hash."));
  }
  if (request.independent_verdict && request.independent_verdict.cases === 0) {
    blockers.push(blocker("empty_independent_verdict", "An independent verdict with zero cases is not evidence", "downstream", "Run at least one independent case or omit the verdict."));
  }

  for (const operation of definition.operations) {
    for (const [label, schema] of [["request", operation.request], ["result", operation.result], ["error", operation.error]] as const) {
      for (const problem of wireSchemaProblems(schema)) blockers.push(blocker("ambiguous_wire_schema", `${operation.name} ${label}: ${problem}`, "downstream", "Replace ambiguous fields with a bounded WireType and explicit meaning."));
    }
    const errorFields = new Set(operation.error.fields.map((field) => field.name));
    if (!errorFields.has("code") || !errorFields.has("message")) {
      blockers.push(blocker("error_contract_missing", `${operation.name} needs code and message error fields`, "downstream", "Declare a machine-readable error code and message in the operation error schema."));
    }
  }
  testBlockers(definition, request.public_tests, blockers);

  const readiness = {
    upstream_review: {
      status: upstreamStatus,
      detail: upstreamStatus === "passed" ? "Origin artifact and required review gate match" : upstreamStatus === "not_applicable" ? "Downstream-authored development capability" : "Upstream review is missing or unresolved",
      at: upstreamStatus === "passed" ? timestamp(now) : null,
      evidence_hash: upstreamStatus === "passed" ? originArtifactHash : null,
    },
    implementation_checks: { status: "not_run" as const, detail: "Implementation has not been built", at: null, evidence_hash: null },
    independent_behavior_checks: {
      status: definition.origin.kind === "authored" ? "not_applicable" as const : request.independent_verdict ? "unknown" as const : "not_run" as const,
      detail: definition.origin.kind === "authored" ? "Authored development capability has no recovered behavior to independently verify" : request.independent_verdict ? "An uploaded verdict is recorded but has not been independently revalidated" : "No independent evaluation has run",
      at: null,
      evidence_hash: request.independent_verdict?.report_hash ?? null,
    },
    composition_checks: { status: "not_run" as const, detail: "No composition has run", at: null, evidence_hash: null },
    packaging_checks: { status: "not_run" as const, detail: "No package has been built", at: null, evidence_hash: null },
  };
  const requestHash = hashJson({
    definition_hash: hashJson(definition),
    origin_artifact_hash: originArtifactHash,
    implementation: request.implementation,
    public_tests: request.public_tests,
    review_attestation: request.review_attestation,
  });
  const record: CapabilityIntakeRecord = {
    intake_id: `int_${requestHash.slice(0, 32)}`,
    accepted: blockers.length === 0,
    definition_hash: hashJson(definition),
    origin_artifact_hash: originArtifactHash,
    blockers,
    readiness,
    received_at: timestamp(now),
    definition,
    public_tests: request.public_tests,
    implementation: request.implementation,
    review_attestation: request.review_attestation,
    independent_verdict: request.independent_verdict,
  };
  return { record, originArtifact: request.origin_artifact };
}

export function validateWireObject(value: unknown): boolean {
  return WireObjectSchema.safeParse(value).success;
}
