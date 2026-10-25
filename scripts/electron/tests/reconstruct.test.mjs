import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reconstructElectron } from "../reconstruct.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const archive = name => path.join(repo, `targets/build/${name}/app.asar`);

test("one command selects reviewed Recall IPC adapter and verifies original behavior", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-auto-recall-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const output = path.join(temp, "project");
  const { manifest } = await reconstructElectron(archive("recall"), output, { requireOriginalIpc: true });
  assert.equal(manifest.method, "reviewed-recall");
  assert.equal(manifest.parity.level, "bounded-original-ipc");
  assert.deepEqual(manifest.parity.unmatched_ipc_channels, []);
  assert.deepEqual(manifest.parity.matched_ipc_channels, ["card:answer", "stats:streak"]);
  assert.equal(manifest.verification.status, "passed");
  assert.equal(manifest.verification.checks, 6);
  assert.ok(fs.existsSync(path.join(output, "analysis.json")));
  assert.ok(fs.existsSync(path.join(output, "electron/main.cjs")));
});

test("one command falls back to a plainly partial Inkwell workbench", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-auto-inkwell-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const output = path.join(temp, "project");
  const { manifest } = await reconstructElectron(archive("inkwell"), output);
  assert.equal(manifest.parity.level, "partial");
  assert.deepEqual(manifest.parity.unmatched_ipc_channels, ["graph:get", "search:query"]);
  assert.ok(fs.existsSync(path.join(output, "analysis.json")));
});

test("coverage gates reject unsupported parity before writing projects", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-auto-gate-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const ipcOutput = path.join(temp, "ipc");
  await assert.rejects(reconstructElectron(archive("inkwell"), ipcOutput, { requireOriginalIpc: true }),
    /No reviewed original-IPC reconstruction adapter/);
  assert.equal(fs.existsSync(ipcOutput), false);
  const fullOutput = path.join(temp, "full");
  await assert.rejects(reconstructElectron(archive("recall"), fullOutput, { requireFullParity: true }),
    /Full source-app parity is not established/);
  assert.equal(fs.existsSync(fullOutput), false);
});
