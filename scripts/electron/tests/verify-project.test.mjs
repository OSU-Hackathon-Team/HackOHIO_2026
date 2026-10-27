import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import asar from "@electron/asar";
import { verifyProject } from "../verify-project.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scenarios = path.join(repo, "scripts/electron/scenarios");
const builds = path.join(repo, "targets/build");

test("[E2] Inkwell scenario observes graph and fuzzy-search IPC", async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-verify-test-"));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const archive = path.join(builds, "inkwell/app.asar"), project = path.join(temp, "reference-candidate");
  await fsp.mkdir(project);
  // This reference copy tests the verifier's Inkwell probe. It is not a reconstructed app.
  asar.extractAll(archive, project);
  const result = await verifyProject(archive, project, path.join(scenarios, "inkwell.json"));
  assert.equal(result.result, "passed");
  assert.equal(result.checks, 5);
  assert.deepEqual(result.channels, ["graph:get", "search:query"]);
});

test("[E2] changed Inkwell behavior is rejected", async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-verify-test-"));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const archive = path.join(builds, "inkwell/app.asar"), project = path.join(temp, "bad-candidate");
  await fsp.mkdir(project);
  asar.extractAll(archive, project);
  const search = path.join(project, "src/search/fuzzy.js");
  const source = await fsp.readFile(search, "utf8");
  assert.match(source, /return out\.slice\(0, limit === undefined \? 10 : limit\)/);
  await fsp.writeFile(search, source.replace(/return out\.slice\(0, limit === undefined \? 10 : limit\)/, "return []"));
  await assert.rejects(verifyProject(archive, project, path.join(scenarios, "inkwell.json")),
    /IPC result or file effects differ at call 2: search:query/);
});

test("[E2] missing original IPC channels are rejected", async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-verify-test-"));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const archive = path.join(builds, "inkwell/app.asar"), project = path.join(temp, "bad-candidate");
  await fsp.mkdir(project);
  asar.extractAll(archive, project);
  const main = path.join(project, "src/main.js");
  const source = await fsp.readFile(main, "utf8");
  assert.match(source, /ipcMain\.handle\("search:query"/);
  await fsp.writeFile(main, source.replace(/ipcMain\.handle\("search:query",[^\n]+\n/, ""));
  await assert.rejects(verifyProject(archive, project, path.join(scenarios, "inkwell.json")),
    /Candidate is missing original IPC channel search:query/);
});
