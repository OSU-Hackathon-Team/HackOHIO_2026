import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import {
  CapabilityPackage,
  canonicalJson,
  type Artifact,
  type CapabilityDefinition,
  type TestOutcome,
  type VerificationReport,
} from "@splice/contracts";
import type { ArtifactFile, BuildHooks, BuildInput, BuiltPackage } from "./types.js";
import { buildInputManifest, hashJson, packageId, safeRelativePath, sha256Hex } from "./identity.js";
import { runRestricted } from "./sandbox.js";
import { generateCapabilityClientFiles } from "./clientGen.js";

const MAX_MUTANTS = 8;
const MARKER = "@@SPLICE_RESULT@@";

function sourceProblems(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const syntaxDiagnostics = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics ?? [];
  const problems: string[] = syntaxDiagnostics
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) problems.push("explicit any types are not allowed in capability source");
    if (ts.isImportDeclaration(node)) {
      const module = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      if (!module.startsWith(".")) problems.push(`import must be relative and local: ${module || "<unknown>"}`);
    }
    if (ts.isImportTypeNode(node)) {
      const module = ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : "";
      if (!module.startsWith(".")) problems.push(`type import must be relative and local: ${module || "<unknown>"}`);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && ["require", "eval", "Function"].includes(node.expression.text)))) {
      problems.push("dynamic imports, require, eval and Function are not allowed");
    }
    if (ts.isIdentifier(node) && ["process", "global", "globalThis"].includes(node.text)) problems.push(`${node.text} is not available in capability source`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(problems)];
}

function buildWrapper(definition: CapabilityDefinition, entry: string): string {
  const importPath = `./${entry.replace(/\\/g, "/")}`;
  const mappings = definition.operations.map((operation) => {
    const name = JSON.stringify(operation.name);
    return `  [${name}]: async (input, ctx) => {\n    const table = candidate.operations ?? defaultObject.operations ?? candidate.default;\n    const fn = table?.[${name}] ?? candidate[${name}];\n    if (typeof fn !== "function") throw new Error("missing operation ${operation.name}");\n    return await fn(input, ctx);\n  },`;
  });
  return `import * as candidate from ${JSON.stringify(importPath)};\nconst defaultObject = candidate.default && typeof candidate.default === "object" ? candidate.default : {};\nexport const operations = {\n${mappings.join("\n")}\n};\n`;
}

async function compileBundle(sourceRoot: string, wrapperFile: string): Promise<Buffer> {
  const output = await build({
    absWorkingDir: sourceRoot,
    entryPoints: [wrapperFile],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    minify: false,
    charset: "utf8",
    logLevel: "silent",
    plugins: [{
      name: "splice-package-import-boundary",
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return undefined;
          if (!args.path.startsWith(".")) {
            return { errors: [{ text: `package imports must be relative and local: ${args.path}` }] };
          }
          const resolved = path.resolve(args.resolveDir, args.path);
          if (!resolved.startsWith(`${sourceRoot}${path.sep}`)) {
            return { errors: [{ text: `package import escapes its source root: ${args.path}` }] };
          }
          return undefined;
        });
      },
    }],
  });
  if (output.errors.length) throw new Error(output.errors.map((error) => error.text).join("\n"));
  const file = output.outputFiles?.[0];
  if (!file) throw new Error("esbuild produced no module artifact");
  return Buffer.from(file.contents);
}

function typecheckSources(files: Map<string, string>): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const normalized = path.resolve(fileName);
    for (const [candidatePath, code] of files) {
      if (path.resolve(candidatePath) === normalized) return ts.createSourceFile(fileName, code, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const location = diagnostic.file && diagnostic.start !== undefined
      ? `${path.basename(diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      : "typescript";
    return `${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
}

function mutationSites(files: Map<string, string>): Array<{ file: string; start: number; end: number; replacement: string; name: string }> {
  const replacements = new Map<ts.SyntaxKind, { replacement: string; name: string }>([
    [ts.SyntaxKind.PlusToken, { replacement: "-", name: "plus-to-minus" }],
    [ts.SyntaxKind.MinusToken, { replacement: "+", name: "minus-to-plus" }],
    [ts.SyntaxKind.AsteriskToken, { replacement: "/", name: "multiply-to-divide" }],
    [ts.SyntaxKind.EqualsEqualsEqualsToken, { replacement: "!==", name: "strict-equality-to-inequality" }],
    [ts.SyntaxKind.GreaterThanEqualsToken, { replacement: ">", name: "greater-or-equal-to-greater" }],
    [ts.SyntaxKind.LessThanEqualsToken, { replacement: "<", name: "less-or-equal-to-less" }],
  ]);
  const sites: Array<{ file: string; start: number; end: number; replacement: string; name: string }> = [];
  for (const [file, code] of files) {
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node)) {
        const replacement = replacements.get(node.operatorToken.kind);
        if (replacement) sites.push({
          file,
          start: node.operatorToken.getStart(source),
          end: node.operatorToken.end,
          replacement: replacement.replacement,
          name: `${path.basename(file)}:${node.operatorToken.getStart(source)}:${replacement.name}`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.slice(0, MAX_MUTANTS);
}

async function executeSuite(
  root: string,
  runnerFile: string,
  moduleBytes: Buffer,
  definition: CapabilityDefinition,
  tests: BuildInput["public_tests"],
  signal?: AbortSignal,
): Promise<TestOutcome[]> {
  const moduleFile = path.join(root, "module.mjs");
  const definitionFile = path.join(root, "definition.json");
  const testsFile = path.join(root, "tests.json");
  fs.writeFileSync(moduleFile, moduleBytes);
  fs.writeFileSync(definitionFile, canonicalJson(definition));
  const compiledTests = tests
    .filter((test) => test.harness === "ts")
    .map((test) => ({
      name: test.name,
      requirement_ids: test.requirement_ids,
      code: ts.transpile(test.code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }),
    }));
  fs.writeFileSync(testsFile, canonicalJson(compiledTests));
  const runnerRelative = path.relative(root, runnerFile).split(path.sep).join("/");
  const result = await runRestricted(process.execPath, [
    `/work/${runnerRelative}`,
    "/work/module.mjs",
    "/work/definition.json",
    "/work/tests.json",
  ], { cwd: root, timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024, signal });
  if (result.code !== 0) throw new Error(`TypeScript public tests failed to execute (exit ${result.code ?? result.signal}): ${result.stderr.slice(0, 2000)}`);
  const line = result.stdout.split("\n").reverse().find((entry) => entry.startsWith(MARKER));
  if (!line) throw new Error(`TypeScript test harness produced no result: ${result.stdout.slice(-1000)} ${result.stderr.slice(0, 500)}`);
  const parsed = JSON.parse(line.slice(MARKER.length)) as { tests: TestOutcome[] };
  return parsed.tests;
}

function report(
  tests: TestOutcome[],
  mutation: { total: number; killed: number; survivors: string[] },
  typeErrors: string[],
): VerificationReport {
  const value: VerificationReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generator: "splice.capabilities.ts-builder@1",
    tests,
    mutation,
    purity_violations: [],
    type_errors: typeErrors,
    boundary_checks: [],
    blockers: [],
    verdict: tests.length > 0 && tests.every((test) => test.passed) && mutation.survivors.length === 0 && typeErrors.length === 0 ? "passed" : "failed",
    report_hash: "",
  };
  value.report_hash = hashJson(value);
  return value;
}

export async function buildTypeScriptPackage(input: BuildInput, hooks: BuildHooks): Promise<BuiltPackage> {
  if (input.implementation.kind !== "typescript") throw new Error("buildTypeScriptPackage requires TypeScript implementation source");
  if (input.public_tests.some((test) => test.harness !== "ts")) throw new Error("TypeScript builder only accepts ts public tests");
  const definition = input.definition;
  const definitionHash = hashJson(definition);
  if (input.hash_definition && input.hash_definition !== definitionHash) throw new Error("Intake definition hash does not match the definition being built");
  if (input.implementation.files.length === 0) throw new Error("TypeScript implementation has no files");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "splice-ts-build-"));
  const sourceRoot = path.join(work, "src");
  const sandboxRoot = path.join(work, "sandbox");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(sandboxRoot, { recursive: true });
  try {
    const sourceFiles = new Map<string, string>();
    for (const file of input.implementation.files) {
      const relative = safeRelativePath(file.path);
      if (!/\.(?:ts|tsx|js|mjs)$/.test(relative)) throw new Error(`Unsupported TypeScript source file ${file.path}`);
      if (sourceFiles.has(relative)) throw new Error(`Duplicate source file ${file.path}`);
      const bytes = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
      const code = bytes.toString("utf8");
      for (const problem of sourceProblems(relative, code)) throw new Error(`${file.path}: ${problem}`);
      sourceFiles.set(relative, code);
      const target = path.resolve(sourceRoot, relative);
      if (!target.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`Source path escapes package root: ${file.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, code);
    }
    const entry = safeRelativePath(input.implementation.entry);
    if (!sourceFiles.has(entry)) throw new Error(`TypeScript entry ${entry} is not in implementation.files`);
    const wrapperPath = path.join(sourceRoot, "__splice_entry.ts");
    fs.writeFileSync(wrapperPath, buildWrapper(definition, entry));
    const typeErrors = typecheckSources(new Map([...sourceFiles].map(([relative, code]) => [path.join(sourceRoot, relative), code])));
    if (typeErrors.length) throw new Error(`TypeScript implementation has type errors:\n${typeErrors.join("\n")}`);

    hooks.onStage("bundle", "Bundling isolated TypeScript capability", 30);
    const runnerBuild = await build({
      entryPoints: [new URL("./tsTestRunner.mjs", import.meta.url).pathname],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "bundle",
      sourcemap: false,
      logLevel: "silent",
    });
    const runnerBytes = Buffer.from(runnerBuild.outputFiles![0].contents);
    const runnerFile = path.join(sandboxRoot, "test-runner.mjs");
    fs.writeFileSync(runnerFile, runnerBytes);

    const baseModule = await compileBundle(sourceRoot, wrapperPath);
    hooks.onStage("verify", "Running public tests in a restricted Linux namespace", 55);
    const tests = await executeSuite(sandboxRoot, runnerFile, baseModule, definition, input.public_tests, hooks.signal);

    const mutants = mutationSites(sourceFiles);
    const survivors: string[] = [];
    for (const [index, site] of mutants.entries()) {
      if (hooks.signal?.aborted) throw new Error("cancelled");
      const original = sourceFiles.get(site.file)!;
      const mutant = `${original.slice(0, site.start)}${site.replacement}${original.slice(site.end)}`;
      sourceFiles.set(site.file, mutant);
      fs.writeFileSync(path.join(sourceRoot, site.file), mutant);
      let killed = false;
      try {
        const moduleBytes = await compileBundle(sourceRoot, wrapperPath);
        const outcomes = await executeSuite(sandboxRoot, runnerFile, moduleBytes, definition, input.public_tests, hooks.signal);
        killed = outcomes.some((outcome) => !outcome.passed);
      } catch {
        killed = true;
      } finally {
        sourceFiles.set(site.file, original);
        fs.writeFileSync(path.join(sourceRoot, site.file), original);
      }
      if (!killed) survivors.push(site.name);
      hooks.onStage("mutation", `Mutation checks ${index + 1}/${mutants.length}`, 60 + ((index + 1) / Math.max(1, mutants.length)) * 20);
    }
    const mutation = { total: mutants.length, killed: mutants.length - survivors.length, survivors };
    const finalModule = await compileBundle(sourceRoot, wrapperPath);
    const verification = report(tests, mutation, []);
    if (verification.verdict !== "passed") throw new Error(`TypeScript verification failed: ${tests.filter((test) => !test.passed).map((test) => `${test.name}: ${test.detail}`).join("; ") || `mutants survived: ${survivors.join(", ")}`}`);

    hooks.onStage("package", "Writing content-addressed package artifacts", 90);
    const files: ArtifactFile[] = [
      { path: "definition.json", data: Buffer.from(canonicalJson(definition)) },
      { path: "build-input.json", data: Buffer.from(canonicalJson(buildInputManifest(input))) },
      { path: "module.mjs", data: finalModule },
      ...generateCapabilityClientFiles(definition),
      ...[...sourceFiles.entries()].map(([relative, code]) => ({ path: `src/${relative}`, data: Buffer.from(code) })),
    ];
    const artifactRecords: Artifact[] = files.map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.data),
      size: file.data.length,
      kind: file.path === "definition.json" ? "manifest" : file.path === "module.mjs" ? "binary" : file.path.startsWith("client/") ? "client" : "source",
    }));
    const buildHash = hashJson(artifactRecords.map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size })));
    const sourceHash = hashJson([...sourceFiles.entries()].map(([filePath, code]) => ({ path: filePath, hash: sha256Hex(code) })));
    const now = new Date().toISOString();
    const authored = definition.origin.kind === "authored";
    const pkg: CapabilityPackage = {
      schema_version: 1,
      package_id: packageId(definitionHash, buildHash),
      definition: { id: definition.id, version: definition.version, hash: definitionHash },
      runtime_kind: "ts_worker",
      entrypoints: [{ kind: "module", path: "module.mjs", protocol: "splice-ts-module-v1" }],
      platforms: [{ os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64" }],
      build: {
        recipe: "esbuild bundle (Node 22, isolated tests under bubblewrap)",
        toolchain: { name: "node+esbuild", version: process.version },
        source_hash: sourceHash,
        build_hash: buildHash,
        reproducible: true,
        log_hash: hashJson({ compiler: "esbuild", tests: tests.map((test) => test.name), mutation }),
        attempts: 0,
      },
      artifacts: artifactRecords,
      dependency_lock: [],
      assets: [],
      verification,
      independent_verdict_ref: null,
      readiness: {
        upstream_review: input.intake_readiness?.upstream_review ?? { status: authored ? "not_applicable" : "unknown", detail: authored ? "Authored development capability" : "Origin readiness was not supplied", at: null, evidence_hash: null },
        implementation_checks: { status: "passed", detail: `${tests.length} public cases passed; ${mutation.killed}/${mutation.total} mutants were detected`, at: now, evidence_hash: verification.report_hash },
        independent_behavior_checks: input.intake_readiness?.independent_behavior_checks ?? { status: authored ? "not_applicable" : "not_run", detail: authored ? "Authored development capability has no recovered behavior to independently verify" : "Independent original-behavior evaluation has not run", at: null, evidence_hash: null },
        composition_checks: { status: "not_run", detail: "No composition has run", at: null, evidence_hash: null },
        packaging_checks: { status: "passed", detail: "Bundle, definition and source artifacts were hash-pinned", at: now, evidence_hash: buildHash },
      },
      created_at: now,
    };
    hooks.onStage("complete", "TypeScript package verified", 100);
    return { package: CapabilityPackage.parse(pkg), files };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
