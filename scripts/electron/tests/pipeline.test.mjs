import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { analyzeElectronArchive } from "../analyze-archive.mjs";
import { runCase } from "../oracle.mjs";
import { buildCases, compareCase, runSuite, usableResults, validateContract } from "../cases.mjs";
import { assembleProject, validateWorkspace } from "../project.mjs";
import { findFixture } from "../fixture-search.mjs";
import { CONTRACT, hostSurfaceArchive, syntheticArchive, syntheticWorkspace } from "./synthetic.mjs";

test("the mocked host answers Electron-only process properties and native bindings", async () => {
  const { root, extracted } = await hostSurfaceArchive();
  try {
    const result = await runCase({ appDir: extracted, case: { channel: "host:surface" } });
    const surface = result.outcomes[0].value;
    /* A large application loads @electron/remote and registers a privileged scheme before the
       first window; neither exists in Node, so the host answers both instead of letting the main
       process die at import time. */
    assert.equal(surface.scheme, "function");
    assert.equal(surface.dark, false);
    assert.equal(surface.resources, true, "process.resourcesPath names the directory that holds the app");
    assert.equal(surface.defaultApp, false);
    assert.equal(surface.linked, "function");
    /* The stub never invents a value: the observation reports the sanitized undefined. */
    assert.deepEqual(surface.hidden, { $undefined: true });
    assert.deepEqual(surface.flag, { $undefined: true });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("oracle observes a never-seen archive without any target-specific code", async () => {
  const { root, archive, extracted } = await syntheticArchive();
  try {
    const analysis = analyzeElectronArchive(archive);
    assert.equal(analysis.archive.name, "synthetic-notes");
    assert.deepEqual(analysis.ipc.handles.map(item => [item.channel, item.arity]).sort(),
      [["notes:add", 2], ["notes:read", 1]]);
    const added = await runCase({ appDir: extracted, case: { channel: "notes:add", args: ["alpha", "  hello  "] } });
    assert.deepEqual(added.outcomes[0].value, { name: "alpha", length: 5 });
    assert.equal(added.files["userData/notes/alpha.txt"], "hello");
    assert.equal(added.effects[0].changed["userData/notes/alpha.txt"], "hello");
    const read = await runCase({ appDir: extracted, case: { channel: "notes:read", args: ["alpha"],
      fixtures: [{ base: "userData", path: "notes/alpha.txt", content: "hello" }] } });
    assert.deepEqual(read.outcomes[0].value, "hello");
    const missing = await runCase({ appDir: extracted, case: { channel: "notes:read", args: ["nope"] } });
    assert.equal(missing.outcomes[0].ok, false);
    assert.equal(missing.outcomes[0].error.code, "ENOENT");
    /* Harness-owned absolute paths are not behavior: the message names the storage root instead, so
       the same answer is comparable when a reimplementation computes the path from ctx. */
    assert.match(missing.outcomes[0].error.message, /userData[\\/]notes[\\/]nope\.txt/);
    assert.equal(missing.outcomes[0].error.message.includes(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("fixture search finds a missing file the error names", async () => {
  const { root, extracted } = await syntheticArchive();
  try {
    const found = await findFixture({ appDir: extracted, channel: "notes:read", args: ["alpha"] });
    assert.equal(found.found, true);
    assert.deepEqual(found.fixtures.map(item => [item.base, item.path]), [["userData", "notes/alpha.txt"]]);
    assert.deepEqual(found.result.outcomes[0].value, "{}");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("generated cases, assembly and differential verification accept a faithful clone", async () => {
  const { root, archive, extracted } = await syntheticArchive();
  try {
    const analysis = analyzeElectronArchive(archive);
    const workspace = await syntheticWorkspace();
    assert.deepEqual(validateWorkspace(workspace, analysis, CONTRACT), []);
    assert.deepEqual(validateContract(CONTRACT, analysis.ipc.handles), []);
    const built = buildCases({ contract: CONTRACT, channels: analysis.ipc.handles, seed: "public" });
    assert.ok(built.publicCases.length >= 4);
    assert.ok(built.heldOut.length >= 3);
    assert.equal(built.all.every(item => item.fixed_time === "2026-10-25T12:00:00.000Z"), true,
      "generated cases must not depend on the wall clock");
    const publicNames = new Set(built.publicCases.map(item => item.name));
    assert.equal(built.heldOut.some(item => publicNames.has(item.name)), false);
    assert.equal(built.repairCases.some(item => publicNames.has(item.name)), false,
      "repair cases must never be visible before the first failure");
    assert.equal(built.repairCases.some(item => built.finalCases.some(other => other.name === item.name)), false,
      "repair and final cases must be disjoint");
    const expected = usableResults(await runSuite({ runCase, appDir: extracted, cases: built.all }));
    assert.ok(expected.length >= 7);
    const assembled = await assembleProject({ analysis, contract: CONTRACT, workspace, output: path.join(root, "out") });
    assert.ok((await fsp.readFile(path.join(assembled.output, "main.cjs"), "utf8")).includes("ipcMain.handle"));
    const actual = await runSuite({ runCase, appDir: assembled.output, cases: expected.map(item => item.case) });
    const failures = actual.flatMap((item, index) => item.error ? [`${item.case.name}: ${item.error.message}`]
      : compareCase(expected[index].result, item.result).map(problem => `${item.case.name}: ${problem}`));
    assert.deepEqual(failures, []);
    assert.equal(fs.existsSync(path.join(assembled.output, "main.js")), false, "original source must not be copied");
    assert.equal(fs.existsSync(path.join(assembled.output, "src")), false);
    await fsp.rm(workspace, { recursive: true, force: true });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("differential verification rejects a candidate that special-cases sample arguments", async () => {
  const { root, archive, extracted } = await syntheticArchive();
  try {
    const analysis = analyzeElectronArchive(archive);
    const workspace = await syntheticWorkspace();
    await fsp.writeFile(path.join(workspace, "features/add.cjs"), `"use strict";
module.exports = async function (args) {
  return args[0] === "alpha" ? { name: "alpha", length: 5 } : { name: args[0], length: 0 };
};
`);
    const built = buildCases({ contract: CONTRACT, channels: analysis.ipc.handles, seed: "public" });
    const expected = usableResults(await runSuite({ runCase, appDir: extracted, cases: built.all }));
    const assembled = await assembleProject({ analysis, contract: CONTRACT, workspace, output: path.join(root, "out") });
    const actual = await runSuite({ runCase, appDir: assembled.output, cases: expected.map(item => item.case) });
    const differences = actual.flatMap((item, index) => item.error ? [] : compareCase(expected[index].result, item.result));
    assert.ok(differences.length > 0, "an overfitted candidate must fail differential cases");
    await fsp.rm(workspace, { recursive: true, force: true });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
