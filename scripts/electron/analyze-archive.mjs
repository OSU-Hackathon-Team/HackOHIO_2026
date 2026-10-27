import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import ts from "typescript";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const scriptExtensions = [".js", ".cjs", ".mjs"];
const isScript = name => scriptExtensions.some(ext => name.endsWith(ext));
const normalized = name => path.posix.normalize(name.replaceAll("\\", "/").replace(/^\/+/, ""));
const lineOf = (source, node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
const literal = node => node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
const calleeName = (node, source) => node.expression.getText(source);

function staticPath(node, source, moduleName) {
  if (!node) return null;
  const direct = literal(node);
  if (direct !== null) return direct;
  if (ts.isIdentifier(node) && node.text === "__dirname") return path.posix.dirname(moduleName);
  if (!ts.isCallExpression(node)) return null;
  const name = calleeName(node, source);
  if (name !== "path.join" && name !== "path.resolve") return null;
  const segments = node.arguments.map(argument => staticPath(argument, source, moduleName));
  if (segments.some(segment => segment === null)) return null;
  return path.posix.join(...segments);
}

function resolveLocal(from, specifier, files) {
  if (!specifier.startsWith(".")) return null;
  const base = normalized(path.posix.join(path.posix.dirname(from), specifier));
  if (base.startsWith("../") || base === "..") return null;
  const candidates = [base, ...[".js", ".cjs", ".mjs", ".json", ".html"].map(ext => base + ext),
    ...["index.js", "index.cjs", "index.mjs", "index.json"].map(name => path.posix.join(base, name))];
  return candidates.find(candidate => files.has(candidate)) ?? null;
}

function assetType(name) {
  const extension = path.posix.extname(name).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "html";
  if (extension === ".css") return "css";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp"].includes(extension)) return "image";
  if ([".woff", ".woff2", ".ttf", ".otf"].includes(extension)) return "font";
  return "other";
}

/** Static archive inventory. A diagnostic marks source expressions that need runtime tracing. */
export function analyzeElectronArchive(archivePath) {
  const archive = path.resolve(archivePath);
  const archiveBytes = fs.readFileSync(archive);
  const names = asar.listPackage(archive, { isPack: false }).map(normalized)
    .filter(name => !asar.statFile(archive, name).files);
  const fileNames = new Set(names);
  if (!fileNames.has("package.json")) throw new Error("Electron archive is missing package.json");
  const read = name => asar.extractFile(archive, name);
  const pkg = JSON.parse(read("package.json").toString("utf8"));
  const declaredMain = String(pkg.main ?? "index.js");
  if (path.posix.isAbsolute(declaredMain.replaceAll("\\", "/")))
    throw new Error(`Electron main entry is outside archive: ${declaredMain}`);
  const mainBase = normalized(declaredMain);
  if (mainBase.startsWith("../") || mainBase === "..")
    throw new Error(`Electron main entry is outside archive: ${declaredMain}`);
  const main = [mainBase, ...scriptExtensions.map(ext => mainBase + ext),
    ...scriptExtensions.map(ext => path.posix.join(mainBase, "index" + ext))]
    .find(candidate => fileNames.has(candidate) && isScript(candidate));
  if (!main) throw new Error(`Electron main entry is missing or unsupported: ${declaredMain}`);

  const diagnostics = [];
  const modules = {};
  const ipc = { handles: [], sends: [], invokes: [], listens: [] };
  const preloads = new Set();
  const renderers = [];
  const bridgeExports = [];
  const warn = (code, file, source, node, detail) => diagnostics.push({ severity: "warning", code, file,
    line: lineOf(source, node), detail });

  for (const name of names.filter(isScript).sort()) {
    const bytes = read(name);
    const source = ts.createSourceFile(name, bytes.toString("utf8"), ts.ScriptTarget.ES2022, true,
      name.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.JS);
    const module = { sha256: sha256(bytes), dependencies: [], ipc: { handles: [], sends: [], invokes: [], listens: [] },
      bridge_exports: [], preloads: [], window_loads: [] };
    for (const error of source.parseDiagnostics) warn("syntax-error", name, source, source, ts.flattenDiagnosticMessageText(error.messageText, " "));
    const dependency = (specifier, kind, node) => {
      const resolved = resolveLocal(name, specifier, fileNames);
      module.dependencies.push({ specifier, kind, resolved });
      if (specifier.startsWith(".") && !resolved) warn("unresolved-local-module", name, source, node, specifier);
      if (specifier.endsWith(".node") || resolved?.endsWith(".node"))
        warn("native-addon", name, source, node, specifier);
    };
    const channelCall = (kind, node) => {
      const channel = literal(node.arguments[0]);
      if (channel === null) {
        warn("dynamic-ipc-channel", name, source, node, kind);
        return;
      }
      const handler = node.arguments[1];
      const arity = handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
        ? Math.max(0, handler.parameters.length - 1) : null;
      const entry = { channel, file: name, line: lineOf(source, node), arity };
      module.ipc[kind].push(channel);
      ipc[kind].push(entry);
    };
    function visit(node) {
      if (ts.isNewExpression(node) && node.expression.getText(source) === "Function")
        warn("runtime-code-generation", name, source, node, "Function");
      if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier) !== null)
        dependency(literal(node.moduleSpecifier), "import", node);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && literal(node.moduleSpecifier) !== null)
        dependency(literal(node.moduleSpecifier), "export", node);
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "preload") {
        const target = staticPath(node.initializer, source, name);
        if (target === null) warn("dynamic-preload", name, source, node, node.initializer.getText(source));
        else {
          const resolved = normalized(target);
          module.preloads.push(resolved);
          if (fileNames.has(resolved)) preloads.add(resolved);
          else warn("unresolved-preload", name, source, node, resolved);
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node, source);
        if (callee === "require" || callee === "import") {
          const specifier = literal(node.arguments[0]);
          if (specifier === null) warn("dynamic-module-import", name, source, node, callee);
          else dependency(specifier, callee, node);
        }
        if (callee === "eval" || callee === "Function")
          warn("runtime-code-generation", name, source, node, callee);
        const kinds = { "ipcMain.handle": "handles", "ipcRenderer.send": "sends",
          "ipcRenderer.invoke": "invokes", "ipcMain.on": "listens", "ipcRenderer.on": "listens" };
        if (kinds[callee]) channelCall(kinds[callee], node);
        if (callee === "contextBridge.exposeInMainWorld") {
          const global = literal(node.arguments[0]);
          if (global === null) warn("dynamic-bridge-global", name, source, node, callee);
          else {
            const methods = [];
            const value = node.arguments[1];
            if (value && ts.isObjectLiteralExpression(value)) {
              for (const prop of value.properties) {
                if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue;
                const method = prop.name && (literal(prop.name) ?? prop.name.getText(source));
                const channels = [];
                const scan = item => {
                  if (ts.isCallExpression(item) && calleeName(item, source) === "ipcRenderer.invoke") {
                    const channel = literal(item.arguments[0]);
                    if (channel !== null) channels.push(channel);
                  }
                  ts.forEachChild(item, scan);
                };
                scan(prop);
                methods.push({ name: method, invokes: channels });
              }
            } else warn("dynamic-bridge-object", name, source, node, callee);
            const entry = { global, file: name, line: lineOf(source, node), methods };
            module.bridge_exports.push(entry);
            bridgeExports.push(entry);
          }
        }
        if (callee.endsWith(".loadURL") || callee.endsWith(".loadFile")) {
          const value = staticPath(node.arguments[0], source, name);
          if (value === null) warn("dynamic-renderer-load", name, source, node, callee);
          else {
            const kind = callee.endsWith(".loadFile") ? "file" : value.startsWith("data:") ? "data-url" : "url";
            const entry = { kind, file: name, line: lineOf(source, node), target: kind === "data-url" ? null : value,
              sha256: kind === "data-url" ? sha256(value) : null };
            module.window_loads.push(entry);
            renderers.push(entry);
            if (kind === "file" && !fileNames.has(normalized(value)))
              warn("unresolved-renderer-file", name, source, node, value);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    modules[name] = module;
  }

  const assets = names.filter(name => !isScript(name) && name !== "package.json").sort()
    .map(name => ({ file: name, type: assetType(name), sha256: sha256(read(name)) }));
  for (const asset of assets.filter(asset => asset.type === "html")) {
    const html = read(asset.file).toString("utf8");
    for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const script = match[1];
      if (/^(?:https?:|\/\/)/i.test(script)) continue;
      const resolved = resolveLocal(asset.file, script.startsWith(".") ? script : `./${script}`, fileNames);
      if (!resolved) diagnostics.push({ severity: "warning", code: "unresolved-renderer-script", file: asset.file,
        line: html.slice(0, match.index).split("\n").length, detail: script });
      else {
        asset.scripts ??= [];
        asset.scripts.push(resolved);
      }
    }
  }
  const reachable = new Set();
  const traverse = name => {
    if (reachable.has(name) || !modules[name]) return;
    reachable.add(name);
    for (const edge of modules[name].dependencies) if (edge.resolved) traverse(edge.resolved);
  };
  traverse(main);
  for (const preload of preloads) traverse(preload);
  for (const asset of assets) for (const script of asset.scripts ?? []) traverse(script);

  return { schema_version: 1, analysis_method: "static-syntax",
    analysis_limits: ["Direct Electron and IPC call forms only; aliases and runtime behavior require tracing",
      "Renderer contents and external package behavior are not inferred from this inventory"],
    archive: { sha256: sha256(archiveBytes), name: pkg.name ?? null,
    version: pkg.version ?? null }, entries: { main, preloads: [...preloads].sort(), renderers },
    ipc, bridge_exports: bridgeExports, modules, reachable_modules: [...reachable].sort(), assets, diagnostics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error("Usage: node scripts/electron/analyze-archive.mjs <app.asar>");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(analyzeElectronArchive(process.argv[2]), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
