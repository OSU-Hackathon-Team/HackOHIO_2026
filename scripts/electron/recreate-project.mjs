import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";
import { transformSync } from "esbuild";
import { inspectElectronArchive } from "./inspect-archive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const blueprintDirectory = path.join(repo, "fixtures/hand-authored/blueprints");
const templateDirectory = path.join(here, "project-template");
const require = createRequire(import.meta.url);

function safeId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function moduleExports(code) {
  const ast = ts.createSourceFile("engine.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const result = new Set();
  for (const statement of ast.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) result.add(statement.name.text);
  }
  return result;
}

function candidateBlueprints(evidence, directory) {
  const main = evidence.files[evidence.main];
  if (!main) throw new Error(`Archive main entry ${evidence.main} is missing`);
  const files = fs.readdirSync(directory).filter(file => file.endsWith(".json"));
  const selected = [];
  for (const file of files) {
    const blueprint = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    const sourcePaths = blueprint.spec?.requirements?.flatMap(requirement => requirement.source_refs || [])
      .map(ref => ref.split(":L")[0]) || [];
    const verified = blueprint.spec?.oracle?.status === "passed" && blueprint.verification?.status === "passed";
    const sameArchive = blueprint.spec?.provenance?.target?.sha256 === evidence.archive_sha256;
    const grounded = sourcePaths.length > 0 && sourcePaths.every(source => evidence.files[source]);
    const exports = blueprint.spec?.interface?.exports?.filter(item => item.kind === "function") || [];
    const compiledExports = moduleExports(blueprint.implementation?.portable_code || "");
    const implementable = exports.length > 0 && exports.every(item => compiledExports.has(item.name));
    if (sameArchive && (!verified || !grounded || !implementable))
      throw new Error(`Blueprint ${file} matches archive but lacks verified behavior, matching source modules, or declared exports`);
    if (sameArchive) selected.push({ file, blueprint, exports });
  }
  return selected;
}

function examplesFromTests(source, exports, engine) {
  const ast = ts.createSourceFile("acceptance.js", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const variables = new Map();
  const examples = new Map();
  function value(node) {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      if (!variables.has(node.text)) throw new Error("Nonliteral test argument");
      return variables.get(node.text);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(value);
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
      if (!ts.isPropertyAssignment(property) || !property.name || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) throw new Error("Nonliteral test object");
      return [property.name.text, value(property.initializer)];
    }));
    throw new Error("Nonliteral test argument");
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      try { variables.set(node.name.text, value(node.initializer)); } catch { /* Generated results and helper expressions are not sample literals. */ }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && exports.some(entry => entry.name === node.expression.text) && !examples.has(node.expression.text)) {
      try {
        const args = node.arguments.map(value);
        const result = engine[node.expression.text](...args);
        if (!(result instanceof Promise)) examples.set(node.expression.text, args);
      } catch { /* Invalid-grade and other negative test cases are not samples. */ }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return examples;
}

function fallbackArgs(signature) {
  const argumentsText = /^\((.*)\)\s*=>/.exec(signature)?.[1] || "";
  if (!argumentsText) return [];
  return argumentsText.split(",").map(argument => {
    const type = argument.split(":")[1]?.trim();
    if (type === "number") return 1;
    if (type === "string") return "";
    if (type === "boolean") return false;
    if (type?.endsWith("[]")) return [];
    return {};
  });
}

function buildManifest(evidence, selected) {
  const channels = [...new Set(Object.values(evidence.files).flatMap(file => file.ipc_handles || []))];
  return {
    schema_version: 1,
    source: { sha256: evidence.archive_sha256, package_name: evidence.package_name, package_version: evidence.package_version },
    method: "verified portable feature blueprints with a generated Electron function workbench",
    selection: "archive SHA, verified oracle and implementation, source module presence, and exported function agreement",
    features: selected.map(({ file, blueprint, exports }, index) => ({
      id: blueprint.feature_id,
      title: blueprint.spec.consumer_title || blueprint.feature_id,
      description: blueprint.spec.consumer_description || "",
      module: `engine/${index}-${safeId(blueprint.feature_id)}.cjs`,
      functions: exports.map(item => ({ name: item.name, signature: item.signature, description: item.description })),
      blueprint: `fixtures/hand-authored/blueprints/${file}`,
      provenance_mode: blueprint.spec.provenance?.mode || "unknown",
      oracle_status: blueprint.spec.oracle.status,
      verification_status: blueprint.verification.status,
    })),
    parity: {
      level: "partial",
      original_ipc_channels: channels,
      matched_ipc_channels: [],
      unmatched_ipc_channels: channels,
      original_storage_recreated: false,
      original_ui_recreated: false,
      note: "This project invokes verified portable functions through a new generic workbench; original Electron IPC, persistence, and UI require separate reconstruction and verification.",
    },
  };
}

export function recreateProject(archivePath, outputPath, options = {}) {
  if (!archivePath || !outputPath) throw new Error("Archive and output directory are required");
  const evidence = inspectElectronArchive(archivePath);
  const selected = candidateBlueprints(evidence, options.blueprintDirectory || blueprintDirectory);
  if (!selected.length) throw new Error(`No verified portable blueprint matches ${evidence.package_name || "unnamed archive"} (${evidence.archive_sha256}). Supply a verified FeatureBlueprint with matching archive provenance and source modules; static inspection alone cannot reconstruct app behavior.`);
  const manifest = buildManifest(evidence, selected);
  if (options.requireFullParity) throw new Error(`Full parity unavailable: ${manifest.parity.unmatched_ipc_channels.length} original IPC channel(s), storage, and UI are not recreated`);
  const output = path.resolve(outputPath);
  if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
  fs.mkdirSync(path.join(output, "engine"), { recursive: true });
  fs.mkdirSync(path.join(output, "test"), { recursive: true });
  for (const file of ["main.cjs", "preload.cjs", "index.html", "renderer.js", "style.css"]) {
    fs.copyFileSync(path.join(templateDirectory, file), path.join(output, file));
  }
  for (let index = 0; index < selected.length; index++) {
    const { blueprint } = selected[index];
    const destination = path.join(output, manifest.features[index].module);
    const compiled = transformSync(blueprint.implementation.portable_code, { loader: "ts", format: "cjs", target: "node22" });
    fs.writeFileSync(destination, compiled.code);
    const engine = require(destination);
    const examples = examplesFromTests(blueprint.spec.acceptance_tests, manifest.features[index].functions, engine);
    for (const entry of manifest.features[index].functions) entry.example_args = examples.get(entry.name) || fallbackArgs(entry.signature);
    const testCode = `const { test } = require("node:test");\nconst assert = require("node:assert/strict");\nconst { ${manifest.features[index].functions.map(entry => entry.name).join(", ")} } = require("../${manifest.features[index].module}");\n${blueprint.spec.acceptance_tests}\n`;
    fs.writeFileSync(path.join(output, "test", `${index}-${safeId(blueprint.feature_id)}.test.cjs`), testCode);
  }
  fs.writeFileSync(path.join(output, "reconstruction.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "package.json"), JSON.stringify({
    name: `${safeId(evidence.package_name || "electron-app").toLowerCase()}-workbench`,
    version: "1.0.0", private: true, main: "main.cjs",
    scripts: { start: "electron .", test: "node --test test/*.test.cjs" }, devDependencies: { electron: "45.0.0" },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "README.md"), `# ${evidence.package_name} feature workbench\n\nRun \`npm install && npm start\`. Select a verified function, enter a JSON array of arguments, and invoke it. Run \`npm test\` to check the portable engines against their blueprint acceptance cases.\n\nGenerated from verified portable blueprints for archive ${evidence.archive_sha256}. The original source files are not included.\n\nCoverage: ${manifest.features.map(feature => feature.id).join(", ")}. Original IPC channels (${manifest.parity.original_ipc_channels.join(", ") || "none observed"}), storage, and UI are not recreated. See \`reconstruction.json\` for machine readable coverage.\n`);
  try { execFileSync(process.execPath, ["--test", ...fs.readdirSync(path.join(output, "test")).map(file => path.join(output, "test", file))], { stdio: "pipe" }); }
  catch (error) { throw new Error(`Generated blueprint acceptance tests failed:\n${error.stdout?.toString() || ""}${error.stderr?.toString() || ""}`); }
  return { output, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2];
  const output = process.argv[3];
  if (!archive || !output) {
    console.error("Usage: node scripts/electron/recreate-project.mjs <app.asar> <new-output-directory> [--require-full-parity]");
    process.exitCode = 2;
  } else {
    try { console.log(recreateProject(archive, output, { requireFullParity: process.argv.includes("--require-full-parity") }).output); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
