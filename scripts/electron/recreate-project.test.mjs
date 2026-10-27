import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import asar from "@electron/asar";
import { recreateProject } from "./recreate-project.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("auto-selects verified portable features for two Electron archives and marks platform gaps", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-project-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const [target, feature, channels] of [
    ["recall", "recall.sm2_scheduler", ["card:answer", "stats:streak"]],
    ["inkwell", "inkwell.wikilink_graph", ["graph:get", "search:query"]],
  ]) {
    const output = path.join(temp, target);
    const { manifest } = recreateProject(path.join(repo, `targets/build/${target}/app.asar`), output);
    assert.deepEqual(manifest.features.map(entry => entry.id), [feature]);
    assert.deepEqual(manifest.parity.unmatched_ipc_channels, channels);
    assert.equal(manifest.parity.level, "partial");
    assert.equal(manifest.parity.original_storage_recreated, false);
    assert.equal(manifest.parity.original_ui_recreated, false);
    assert.ok(fs.existsSync(path.join(output, "main.cjs")));
    const analysis = JSON.parse(fs.readFileSync(path.join(output, "analysis.json"), "utf8"));
    assert.equal(analysis.archive.sha256, manifest.source.sha256);
    assert.deepEqual(analysis.ipc.handles.map(item => item.channel), channels);
    assert.ok(fs.existsSync(path.join(output, "test")));
    assert.equal(fs.existsSync(path.join(output, "src")), false);
  }
});

test("full-parity gate rejects partial project before writing output", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-project-gate-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const output = path.join(temp, "output");
  assert.throws(() => recreateProject(path.join(repo, "targets/build/recall/app.asar"), output, { requireFullParity: true }), /Full parity unavailable/);
  assert.equal(fs.existsSync(output), false);
});

test("unsupported archive fails with actionable blueprint diagnostic", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-project-unknown-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "unknown-electron-app", version: "1.0.0", main: "main.js" }));
  fs.writeFileSync(path.join(source, "main.js"), "const {app} = require('electron'); app.whenReady().then(() => {});\n");
  const archive = path.join(temp, "app.asar");
  await asar.createPackage(source, archive);
  const output = path.join(temp, "output");
  assert.throws(() => recreateProject(archive, output), /No verified portable blueprint matches unknown-electron-app.*Supply a verified FeatureBlueprint/);
  assert.equal(fs.existsSync(output), false);
});

test("failed generated project leaves no partial output", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-project-rollback-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const directory = path.join(temp, "blueprints");
  fs.mkdirSync(directory);
  const blueprint = JSON.parse(fs.readFileSync(path.join(repo, "fixtures/hand-authored/blueprints/recall.sm2_scheduler.json"), "utf8"));
  blueprint.implementation.portable_code = "export function scheduleReview() {}\nexport function updateEase() {}\nthrow new Error('broken generated engine');";
  fs.writeFileSync(path.join(directory, "broken.json"), JSON.stringify(blueprint));
  const output = path.join(temp, "output");
  assert.throws(() => recreateProject(path.join(repo, "targets/build/recall/app.asar"), output,
    { blueprintDirectory: directory }), /broken generated engine/);
  assert.equal(fs.existsSync(output), false);
});
