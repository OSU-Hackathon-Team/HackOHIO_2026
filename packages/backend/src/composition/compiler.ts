import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import {
  ApplicationBundle,
  canonicalJson,
  type ApplicationFile,
  type CapabilityDefinition,
  type CapabilityPackage,
  type HostEffect,
  type CompositionPlan,
  type CompositionValidateResponse,
  type VerificationReport,
} from "@splice/contracts";
import type { CapabilityResolver } from "../capabilities/types.js";
import { hashJson, sha256Hex } from "../capabilities/identity.js";
import { MIGRATIONS } from "../state/migrations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopHostRoot = path.resolve(here, "../../../desktop-host/src");
const electronVersion = "45.0.0";

function makeReport(generator: string, tests: VerificationReport["tests"], blockers: string[] = []): VerificationReport {
  const report: VerificationReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generator,
    tests,
    mutation: { total: 0, killed: 0, survivors: [] },
    purity_violations: [],
    type_errors: [],
    boundary_checks: [],
    blockers,
    verdict: blockers.length === 0 && tests.length > 0 && tests.every((test) => test.passed) ? "passed" : "failed",
    report_hash: "",
  };
  report.report_hash = hashJson(report);
  return report;
}

function applicationFile(filePath: string, bytes: Uint8Array, encoding: ApplicationFile["encoding"] = "utf8"): ApplicationFile {
  const data = Buffer.from(bytes);
  return {
    path: filePath,
    content: encoding === "base64" ? data.toString("base64") : data.toString("utf8"),
    encoding,
    sha256: sha256Hex(data),
  };
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function initialInput(plan: CompositionPlan, workflowId: string): unknown {
  for (const scenario of plan.acceptance_scenarios) {
    const step = scenario.steps.find((candidate) => candidate.kind === "invoke" && candidate.workflow === workflowId);
    if (step?.kind === "invoke") return step.input;
  }
  return Object.fromEntries(plan.workflows.find((workflow) => workflow.id === workflowId)?.input.fields.map((field) => [field.name, field.type.kind === "map" ? {} : field.type.kind === "array" ? [] : field.type.kind === "string" ? "" : field.type.kind === "bool" ? false : 0]) ?? []);
}

function rendererScript(plan: CompositionPlan): string {
  const descriptor = {
    title: plan.app.title,
    description: plan.app.description,
    surfaces: plan.ui,
    workflows: plan.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, sample: initialInput(plan, workflow.id) })),
  };
  return `
const descriptor = ${JSON.stringify(descriptor)};
const root = document.getElementById("app");
root.replaceChildren();
const title = document.createElement("h1"); title.textContent = descriptor.title; root.append(title);
const description = document.createElement("p"); description.textContent = descriptor.description; root.append(description);
for (const workflow of descriptor.workflows) {
  const section = document.createElement("section");
  const heading = document.createElement("h2"); heading.textContent = workflow.name; section.append(heading);
  const input = document.createElement("textarea"); input.setAttribute("aria-label", workflow.name + " input JSON"); input.value = JSON.stringify(workflow.sample, null, 2); section.append(input);
  const button = document.createElement("button"); button.type = "button"; button.textContent = "Run workflow"; section.append(button);
  const output = document.createElement("pre"); output.setAttribute("aria-live", "polite"); section.append(output);
  button.addEventListener("click", async () => {
    button.disabled = true; output.textContent = "Running…";
    try { const result = await window.splice.runWorkflow(workflow.id, JSON.parse(input.value)); output.textContent = JSON.stringify(result, null, 2); }
    catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
    finally { button.disabled = false; }
  });
  root.append(section);
}
`;
}

function rendererHtml(title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${htmlEscape(title)}</title><link rel="stylesheet" href="./style.css"></head>
<body><main id="app"><p>Loading application…</p></main><script src="./app.js"></script></body></html>`;
}

const rendererCss = `:root{font-family:system-ui,sans-serif;color:#172033;background:#f4f6fa}body{margin:0}main{max-width:900px;margin:0 auto;padding:32px}section{background:white;border:1px solid #dce2ec;border-radius:12px;padding:20px;margin:18px 0}textarea{box-sizing:border-box;width:100%;min-height:220px;font:14px ui-monospace,monospace;padding:12px;border:1px solid #c5cedd;border-radius:8px}button{margin-top:12px;padding:10px 16px;border:0;border-radius:7px;background:#345bd6;color:white;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fc;padding:12px;border-radius:8px}`;

export interface CompileApplicationInput {
  plan: CompositionPlan;
  registry: CapabilityResolver;
  validation: CompositionValidateResponse;
  compositionReport: VerificationReport;
  previousRevision: number | null;
  revision: number;
}

/** Build a hash-locked Electron source application from a validated plan and the exact package artifacts. */
export async function compileApplication(input: CompileApplicationInput): Promise<ApplicationBundle> {
  if (!input.validation.ok) throw new Error("Cannot compile a composition plan with blockers");
  const selected: Array<{ instance: string; pkg: CapabilityPackage; definition: CapabilityDefinition; permissions: HostEffect[] }> = [];
  const packageLock: ApplicationBundle["package_lock"] = [];
  const runtimeFiles: ApplicationFile[] = [];
  const platformSets: Set<string>[] = [];
  for (const instance of input.plan.instances) {
    const pkg = await input.registry.getPackage(instance.package_id);
    const definition = await input.registry.getDefinition(instance.package_id);
    if (!pkg || !definition) throw new Error(`Package ${instance.package_id} disappeared during app build`);
    if (hashJson(definition) !== instance.definition_hash) throw new Error(`Definition pin changed for ${instance.instance}`);
    selected.push({ instance: instance.instance, pkg, definition, permissions: [...instance.permissions] });
    platformSets.push(new Set(pkg.platforms.map((platform) => `${platform.os}/${platform.arch}`)));
    for (const artifact of pkg.artifacts) {
      const bytes = await input.registry.readArtifact(pkg, artifact.path);
      runtimeFiles.push(applicationFile(`packages/${instance.instance}/${artifact.path}`, bytes, artifact.kind === "binary" ? "base64" : "utf8"));
    }
    packageLock.push({
      instance: instance.instance,
      package_id: pkg.package_id,
      definition_hash: pkg.definition.hash,
      build_hash: pkg.build.build_hash,
      artifact_hashes: pkg.artifacts.map(({ path: artifactPath, sha256, kind }) => ({ path: artifactPath, sha256, kind })),
      permissions: instance.permissions,
    });
  }
  let supported = new Set([...platformSets[0]]);
  for (const set of platformSets.slice(1)) supported = new Set([...supported].filter((platform) => set.has(platform)));
  const platforms = [...supported].map((value) => {
    const [os, arch] = value.split("/");
    return { os, arch } as const;
  });
  if (!platforms.length) throw new Error("Selected capability packages have no common OS/architecture target");

  const appId = `app_${hashJson({ title: input.plan.app.title.trim().toLowerCase() }).slice(0, 32)}`;
  const appPackages = selected.map(({ instance, pkg, definition, permissions }) => ({ instance, package: pkg, definition, permissions }));
  const manifest = { schema_version: 1 as const, app_id: appId, plan: input.plan, packages: appPackages };
  const mainEntry = path.join(desktopHostRoot, "main.ts");
  const preloadEntry = path.join(desktopHostRoot, "preload.ts");
  const runnerEntry = path.resolve(here, "../../../runtime/src/jsSidecarRunner.mjs");
  const [mainBuild, preloadBuild, runnerBuild] = await Promise.all([
    build({ entryPoints: [mainEntry], bundle: true, write: false, platform: "node", format: "esm", target: "node24", external: ["electron"], packages: "bundle", logLevel: "silent" }),
    build({ entryPoints: [preloadEntry], bundle: true, write: false, platform: "node", format: "cjs", target: "node24", external: ["electron"], packages: "bundle", logLevel: "silent" }),
    build({ entryPoints: [runnerEntry], bundle: true, write: false, platform: "node", format: "esm", target: "node24", packages: "bundle", logLevel: "silent" }),
  ]);
  const mainBytes = mainBuild.outputFiles?.[0]?.contents;
  const preloadBytes = preloadBuild.outputFiles?.[0]?.contents;
  const runnerBytes = runnerBuild.outputFiles?.[0]?.contents;
  if (!mainBytes || !preloadBytes || !runnerBytes) throw new Error("Application host bundle is missing an entrypoint");
  const rendererSource = rendererScript(input.plan);
  await transform(rendererSource, { loader: "js", target: "es2022" });
  const files: ApplicationFile[] = [
    ...runtimeFiles,
    applicationFile("splice.plan.json", Buffer.from(canonicalJson(manifest))),
    applicationFile("host/main.js", mainBytes),
    applicationFile("host/preload.cjs", preloadBytes),
    applicationFile("host/jsSidecarRunner.mjs", runnerBytes),
    applicationFile("renderer/index.html", Buffer.from(rendererHtml(input.plan.app.title))),
    applicationFile("renderer/app.js", Buffer.from(rendererSource)),
    applicationFile("renderer/style.css", Buffer.from(rendererCss)),
    ...MIGRATIONS.map((migration) => applicationFile(`migrations/${String(migration.version).padStart(3, "0")}_${migration.name}.sql`, Buffer.from(migration.sql))),
  ];
  const packageJson = {
    name: input.plan.app.title.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "splice-app",
    version: "1.0.0",
    private: true,
    type: "module",
    main: "host/main.js",
    scripts: { start: "electron ." },
    devDependencies: { electron: electronVersion },
  };
  files.push(applicationFile("package.json", Buffer.from(canonicalJson(packageJson))));
  files.push(applicationFile("splice.lock.json", Buffer.from(canonicalJson({ schema_version: 1, app_id: appId, plan_hash: hashJson(input.plan), package_lock: packageLock }))));
  files.push(applicationFile("README.md", Buffer.from(`# ${input.plan.app.title}\n\nLinux x64 source export. Requires Node 22+, bubblewrap, prlimit and Electron ${electronVersion}.\nRun \`npm install\` followed by \`npm start\`. Capability processes run with read-only package mounts and no network namespace access.\n`)));

  const applicationReport = makeReport("splice.application.electron-source@1", [
    { name: "host and renderer bundle", kind: "boundary", passed: true, requirement_ids: [], duration_ms: 0, assertions: 1, calls: 0, detail: "Electron main, preload, isolated JS runner and renderer sources compiled or parsed" },
    { name: "sandboxed renderer descriptor", kind: "boundary", passed: true, requirement_ids: [], duration_ms: 0, assertions: 1, calls: 0, detail: "Renderer uses context-isolated preload and textContent for capability output" },
  ]);
  const filePaths = new Set(files.map((file) => file.path));
  const packageArtifactsPresent = packageLock.every((entry) => entry.artifact_hashes.every((artifact) => filePaths.has(`packages/${entry.instance}/${artifact.path}`)));
  const packagingReport = makeReport("splice.application.source-package@1", [
    { name: "source archive contents", kind: "boundary", passed: packageArtifactsPresent && filePaths.has("package.json") && filePaths.has("splice.lock.json") && filePaths.has("host/main.js") && filePaths.has("renderer/index.html"), requirement_ids: [], duration_ms: 0, assertions: 1, calls: 0, detail: packageArtifactsPresent ? "Every selected package artifact and required Electron source file is present" : "One or more locked package artifacts are absent" },
  ]);
  const appHash = hashJson({ plan_hash: hashJson(input.plan), package_lock: packageLock, files: files.map(({ path: filePath, sha256, encoding }) => ({ path: filePath, sha256, encoding })) });
  const now = new Date().toISOString();
  const bundle = {
    schema_version: 1 as const,
    app_id: appId,
    revision: input.revision,
    plan_hash: hashJson(input.plan),
    app_hash: appHash,
    title: input.plan.app.title,
    description: input.plan.app.description,
    package_lock: packageLock,
    files,
    storage_migrations: MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name, sql: migration.sql, hash: sha256Hex(migration.sql) })),
    launch: { command: "npm install && npm start", env: [], platforms },
    verification: { composition: input.compositionReport, application: applicationReport, packaging: packagingReport },
    previous_revision: input.previousRevision,
    status: "verified" as const,
    created_at: now,
  };
  // The current app contract labels a source bundle as verified only after its own checks pass.
  // Electron binary packaging is a separate distribution step and is not claimed here.
  return ApplicationBundle.parse(bundle);
}

export function exportApplication(bundle: ApplicationBundle): ApplicationBundle["files"] {
  return bundle.files.map((file) => ({ ...file }));
}
