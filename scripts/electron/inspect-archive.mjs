import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import asar from "@electron/asar";
import ts from "typescript";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");

export function inspectElectronArchive(archivePath) {
  const archive = path.resolve(archivePath);
  const bytes = fs.readFileSync(archive);
  const files = asar.listPackage(archive, { isPack: false }).map(p => p.replace(/^\/+/, ""));
  const fileSet = new Set(files);
  const read = name => {
    if (!fileSet.has(name)) throw new Error(`Archive is missing ${name}`);
    return asar.extractFile(archive, name);
  };
  const pkg = JSON.parse(read("package.json").toString("utf8"));
  const main = String(pkg.main || "index.js").replace(/^\.\//, "");
  if (!main.endsWith(".js") || main.includes("..")) throw new Error("Unsupported Electron main entry");
  const sources = files.filter(p => p.endsWith(".js"));
  const analyzed = {};
  for (const name of sources) {
    const source = read(name).toString("utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const ipcHandles = [], bridgeExports = [], localRequires = [], windowLoads = [];
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast);
        if (callee === "ipcMain.handle" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
          ipcHandles.push(node.arguments[0].text);
        if (callee === "contextBridge.exposeInMainWorld" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
          bridgeExports.push(node.arguments[0].text);
        if (callee === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith("."))
          localRequires.push(node.arguments[0].text);
        if (callee.endsWith(".loadURL") && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
          windowLoads.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    analyzed[name] = { sha256: hash(source), ipc_handles: ipcHandles, bridge_exports: bridgeExports,
      local_requires: localRequires, window_loads: windowLoads };
  }
  return {
    archive_sha256: hash(bytes), package_name: pkg.name, package_version: pkg.version,
    main, files: analyzed,
  };
}
