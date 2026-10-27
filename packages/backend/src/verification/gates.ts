// Independent gates. A package, composition or application only becomes "verified" when every
// relevant dimension passes; unrun checks stay visible instead of being folded into one badge.
import type {
  ApplicationBundle,
  ApplicationExportResponse,
  CapabilityPackage,
  CompositionValidateResponse,
  VerificationReport,
} from "@splice/contracts";
import { hashJson, sha256Hex } from "../capabilities/identity.js";

export interface GateFinding {
  code: string;
  message: string;
  owner: "upstream" | "downstream" | "user";
}

export interface GateResult {
  ok: boolean;
  findings: GateFinding[];
}

const fail = (code: string, message: string, owner: GateFinding["owner"] = "downstream"): GateFinding => ({
  code,
  message,
  owner,
});

/** A report is only trustworthy if it executed real assertions and sent real calls. */
export function reportFindings(report: VerificationReport, label: string): GateFinding[] {
  const findings: GateFinding[] = [];
  if (report.verdict !== "passed") findings.push(fail(`${label}_verdict`, `${label} verdict is ${report.verdict}`));
  if (report.blockers.length) findings.push(fail(`${label}_blockers`, `${label} has blockers: ${report.blockers.join("; ")}`));
  if (!report.tests.length) findings.push(fail(`${label}_no_tests`, `${label} has no executable tests`));
  for (const test of report.tests) {
    if (!test.passed) findings.push(fail(`${label}_test_failed`, `Test ${test.name} failed: ${test.detail}`));
    if (test.passed && test.assertions === 0) findings.push(fail(`${label}_vacuous`, `Test ${test.name} passed without an assertion`));
    if (test.passed && test.calls === 0 && (test.kind === "public" || test.kind === "held_out")) {
      findings.push(fail(`${label}_vacuous_call`, `Test ${test.name} passed without calling the capability`));
    }
  }
  if (report.mutation.total > 0 && report.mutation.killed < report.mutation.total) {
    findings.push(
      fail(
        `${label}_mutation_survivors`,
        `${report.mutation.total - report.mutation.killed}/${report.mutation.total} mutants survived: ${report.mutation.survivors.join(", ")}`,
      ),
    );
  }
  if (report.mutation.total !== report.mutation.killed + report.mutation.survivors.length) {
    findings.push(fail(`${label}_mutation_accounting`, "Mutation totals do not match killed and surviving mutants"));
  }
  const expectedReportHash = hashJson({ ...report, report_hash: "" });
  if (report.report_hash !== expectedReportHash) findings.push(fail(`${label}_report_hash`, "Verification report hash does not match its contents"));
  if (report.purity_violations.length) findings.push(fail(`${label}_purity`, report.purity_violations.join("; ")));
  if (report.type_errors.length) findings.push(fail(`${label}_types`, report.type_errors.join("; ")));
  for (const check of report.boundary_checks) {
    if (!check.passed) findings.push(fail(`${label}_boundary`, `${check.name}: ${check.detail}`));
  }
  return findings;
}

export function capabilityGate(pkg: CapabilityPackage): GateResult {
  const findings = reportFindings(pkg.verification, "capability");
  if (!["passed", "not_applicable"].includes(pkg.readiness.upstream_review.status)) findings.push(fail("upstream_review_incomplete", pkg.readiness.upstream_review.detail, "upstream"));
  if (pkg.readiness.implementation_checks.status !== "passed") {
    findings.push(fail("implementation_not_passed", pkg.readiness.implementation_checks.detail));
  }
  if (!["passed", "not_applicable"].includes(pkg.readiness.independent_behavior_checks.status)) {
    findings.push(fail("independent_behavior_not_passed", pkg.readiness.independent_behavior_checks.detail, "upstream"));
  }
  if (!["passed", "not_applicable"].includes(pkg.readiness.packaging_checks.status)) findings.push(fail("packaging_not_passed", pkg.readiness.packaging_checks.detail));
  if (!pkg.artifacts.length) findings.push(fail("no_artifacts", "Package has no hashed artifacts"));
  if (!/^[a-f0-9]{64}$/.test(pkg.build.build_hash)) findings.push(fail("build_hash", "Build hash is not lowercase SHA-256 hex"));
  for (const artifact of pkg.artifacts) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) findings.push(fail("artifact_hash", `${artifact.path} has an invalid hash`));
  }
  return { ok: findings.length === 0, findings };
}

export function compositionGate(response: CompositionValidateResponse): GateResult {
  const findings: GateFinding[] = [];
  if (!response.ok) {
    for (const error of response.errors) findings.push({ code: error.code, message: `${error.path}: ${error.message}`, owner: error.owner });
  }
  if (response.readiness.composition_checks.status !== "passed") {
    findings.push(fail("composition_checks", response.readiness.composition_checks.detail));
  }
  return { ok: findings.length === 0, findings };
}

export function applicationGate(bundle: ApplicationBundle): GateResult {
  const findings: GateFinding[] = [];
  const computedHash = hashJson({
    plan_hash: bundle.plan_hash,
    package_lock: bundle.package_lock,
    files: bundle.files.map(({ path, sha256, encoding }) => ({ path, sha256, encoding })),
  });
  if (computedHash !== bundle.app_hash) findings.push(fail("application_hash_mismatch", "Application hash does not match its plan, package lock and files"));
  for (const [label, report] of Object.entries(bundle.verification) as [string, VerificationReport][]) {
    findings.push(...reportFindings(report, label));
  }
  if (bundle.status !== "verified") findings.push(fail("app_status", `Application status is ${bundle.status}`));
  if (!bundle.package_lock.length) findings.push(fail("package_lock", "Application has no package lock"));
  for (const entry of bundle.package_lock) {
    if (!entry.artifact_hashes.length) findings.push(fail("artifact_lock", `${entry.instance} has no artifact hashes`));
  }
  if (!bundle.storage_migrations.length) findings.push(fail("migrations", "Application has no storage migrations"));
  if (!bundle.files.some((file) => file.path === "package.json")) findings.push(fail("package_json", "Application is missing package.json"));
  if (!bundle.files.some((file) => file.path.startsWith("host/"))) findings.push(fail("host", "Application is missing a host entry"));
  if (!bundle.files.some((file) => file.path.startsWith("renderer/"))) findings.push(fail("renderer", "Application is missing a renderer"));
  if (!bundle.launch.command.trim()) findings.push(fail("launch", "Application has no launch command"));
  if (!bundle.launch.platforms.length) findings.push(fail("platforms", "Application advertises no platforms"));
  return { ok: findings.length === 0, findings };
}

export function exportGate(bundle: ApplicationBundle, exported: ApplicationExportResponse): GateResult {
  const findings = applicationGate(bundle).findings;
  if (exported.manifest_hash !== bundle.app_hash) findings.push(fail("export_hash", "Export manifest hash does not match the built app"));
  const paths = new Set<string>();
  for (const file of exported.files) {
    if (paths.has(file.path)) findings.push(fail("duplicate_path", `Duplicate export path ${file.path}`));
    paths.add(file.path);
    if (file.path.includes("..")) findings.push(fail("path_traversal", `Unsafe export path ${file.path}`));
    if (file.encoding === "utf8" && file.content === null) findings.push(fail("missing_content", `Text file ${file.path} has no content`));
    if (file.content !== null) {
      const bytes = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
      if (sha256Hex(bytes) !== file.sha256) findings.push(fail("export_file_hash", `Exported file ${file.path} does not match its SHA-256`));
    }
  }
  for (const required of ["package.json", "host/main.js", "renderer/index.html", "splice.lock.json"]) {
    if (!paths.has(required)) findings.push(fail("export_incomplete", `Export is missing ${required}`));
  }
  return { ok: findings.length === 0, findings };
}
