import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import asar from "@electron/asar";
import { analyzeElectronArchive } from "../analyze-archive.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = name => path.join(repo, "targets/build", name, "app.asar");

test("Recall inventory identifies main IPC and every local module", () => {
  const report = analyzeElectronArchive(fixture("recall"));
  assert.equal(report.entries.main, "src/main.js");
  assert.deepEqual(report.entries.preloads, []);
  assert.deepEqual(report.ipc.handles.map(item => item.channel), ["card:answer", "stats:streak"]);
  assert.equal(report.entries.renderers[0].kind, "data-url");
  assert.deepEqual(report.reachable_modules, ["src/db/deckStore.js", "src/main.js",
    "src/scheduler/sm2.js", "src/stats/streaks.js"]);
  assert.deepEqual(report.diagnostics, []);
});

test("Inkwell inventory connects preload bridge, invokes, handlers, and graph", () => {
  const report = analyzeElectronArchive(fixture("inkwell"));
  assert.deepEqual(report.entries.preloads, ["src/preload.js"]);
  assert.deepEqual(report.ipc.handles.map(item => item.channel), ["graph:get", "search:query"]);
  assert.deepEqual(report.ipc.invokes.map(item => item.channel), ["graph:get", "search:query"]);
  assert.deepEqual(report.bridge_exports[0].methods, [
    { name: "graph", invokes: ["graph:get"] }, { name: "search", invokes: ["search:query"] },
  ]);
  assert.ok(report.reachable_modules.includes("src/graph/wikilinks.js"));
  assert.ok(report.reachable_modules.includes("src/storage/vault.js"));
  assert.deepEqual(report.diagnostics, []);
});

test("dynamic paths and channels become diagnostics instead of invented edges", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-archive-analysis-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "probe", main: "main.cjs" }));
  fs.writeFileSync(path.join(source, "main.cjs"), [
    'const path = require("path");',
    'const { ipcMain, BrowserWindow } = require("electron");',
    'require("./helper");',
    'require("./native.node");',
    'require(dynamicName);',
    'new Function("return 1");',
    'ipcMain.handle(dynamicChannel, () => 1);',
    'ipcMain.handle();',
    'new BrowserWindow({ webPreferences: { preload: path.join(__dirname, "preload.cjs") } }).loadFile("index.html");',
  ].join("\n"));
  fs.writeFileSync(path.join(source, "preload.cjs"), 'const { ipcRenderer } = require("electron"); ipcRenderer.invoke("ping");');
  fs.writeFileSync(path.join(source, "helper.js"), "module.exports = 1;");
  fs.writeFileSync(path.join(source, "native.node"), "placeholder");
  fs.writeFileSync(path.join(source, "index.html"), '<script src="ui.js"></script>');
  fs.writeFileSync(path.join(source, "ui.js"), "document.title = 'probe';");
  const archive = path.join(root, "probe.asar");
  await asar.createPackage(source, archive);
  const report = analyzeElectronArchive(archive);
  assert.deepEqual(report.entries.preloads, ["preload.cjs"]);
  assert.equal(report.entries.renderers[0].kind, "file");
  assert.deepEqual(report.assets.find(asset => asset.file === "index.html").scripts, ["ui.js"]);
  assert.ok(report.reachable_modules.includes("ui.js"));
  assert.equal(report.modules["main.cjs"].dependencies.find(edge => edge.specifier === "./helper").resolved, "helper.js");
  assert.deepEqual(report.diagnostics.map(item => item.code).sort(),
    ["dynamic-ipc-channel", "dynamic-ipc-channel", "dynamic-module-import", "native-addon", "runtime-code-generation"]);
});

test("missing Electron main entry fails clearly", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-archive-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "invalid", main: "missing.js" }));
  const archive = path.join(root, "invalid.asar");
  await asar.createPackage(source, archive);
  assert.throws(() => analyzeElectronArchive(archive), /main entry is missing or unsupported/);
});
