import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { inspectElectronArchive } from "./inspect-archive.mjs";
import { recreateRecall } from "./recreate-recall.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const archive = path.join(repo, "targets/build/recall/app.asar");
const fixedTime = Date.parse("2026-10-25T12:00:00.000Z");

async function loadMain(entry, userData) {
  const handlers = new Map();
  const electron = {
    app: { whenReady: () => Promise.resolve(), getPath: () => userData, on: () => {}, quit: () => {} },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    BrowserWindow: class {
      webContents = { setWindowOpenHandler: () => {}, on: () => {} };
      loadURL() {}
      loadFile() {}
      static getAllWindows() { return []; }
    },
  };
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (name === "electron") return electron;
    return originalLoad.call(this, name, parent, isMain);
  };
  try { require(entry); }
  finally { Module._load = originalLoad; }
  await new Promise(resolve => setImmediate(resolve));
  return handlers;
}

async function outcome(handler, args) {
  try { return { ok: true, value: await handler({}, ...args) }; }
  catch (error) { return { ok: false, name: error.name, code: error.code ?? null }; }
}

async function run() {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-recall-verify-"));
  const originalDate = globalThis.Date;
  try {
    const inkwellArchive = path.join(repo, "targets/build/inkwell/app.asar");
    const otherEvidence = inspectElectronArchive(inkwellArchive);
    assert.deepEqual(otherEvidence.files[otherEvidence.main].ipc_handles, ["graph:get", "search:query"]);
    assert.deepEqual(otherEvidence.files["src/preload.js"].bridge_exports, ["inkwell"]);
    assert.throws(() => recreateRecall(inkwellArchive, path.join(temp, "unsupported")), /Unsupported Electron archive/);

    const source = path.join(temp, "source");
    const clone = path.join(temp, "clone");
    const sourceData = path.join(temp, "source-data");
    const cloneData = path.join(temp, "clone-data");
    fs.mkdirSync(source);
    asar.extractAll(archive, source);
    recreateRecall(archive, clone);
    for (const dir of [sourceData, cloneData]) {
      await fsp.mkdir(path.join(dir, "decks"), { recursive: true });
      await fsp.writeFile(path.join(dir, "decks", "study.json"), JSON.stringify({
        cards: [{ id: "a", reps: 0, interval: 0, ease: 2.5, lapses: 0, due: 0 }], history: [],
      }, null, 2));
    }
    globalThis.Date = class extends originalDate {
      constructor(...args) { super(...(args.length ? args : [fixedTime])); }
      static now() { return fixedTime; }
    };
    const originalHandlers = await loadMain(path.join(source, "src/main.js"), sourceData);
    const cloneHandlers = await loadMain(path.join(clone, "electron/main.cjs"), cloneData);
    assert.deepEqual([...originalHandlers.keys()], ["card:answer", "stats:streak"]);
    assert.ok(cloneHandlers.has("card:answer") && cloneHandlers.has("stats:streak"));

    const cases = [
      ["stats:streak", ["study"]],
      ["card:answer", ["study", "a", 5]],
      ["stats:streak", ["study"]],
      ["card:answer", ["study", "a", 4]],
      ["card:answer", ["study", "a", 2]],
      ["card:answer", ["study", "a", 9]],
      ["stats:streak", ["missing"]],
    ];
    let checked = 0;
    for (const [channel, args] of cases) {
      assert.deepEqual(await outcome(cloneHandlers.get(channel), args), await outcome(originalHandlers.get(channel), args),
        `${channel} ${JSON.stringify(args)} result differs`);
      const [left, right] = await Promise.all([sourceData, cloneData].map(dir =>
        fsp.readFile(path.join(dir, "decks", "study.json"), "utf8")));
      assert.equal(right, left, `${channel} ${JSON.stringify(args)} persisted deck differs`);
      checked++;
    }

    const originalScheduler = require(path.join(source, "src/scheduler/sm2.js"));
    const cloneScheduler = require(path.join(clone, "electron/engine/scheduler.cjs"));
    const originalStreaks = require(path.join(source, "src/stats/streaks.js"));
    const cloneStreaks = require(path.join(clone, "electron/engine/streaks.cjs"));
    for (let reps = 0; reps <= 4; reps++) for (let grade = 0; grade <= 5; grade++) {
      const card = { id: "a", reps, interval: reps * 6, ease: 2.3, lapses: 7, due: 0 };
      assert.deepEqual(cloneScheduler.scheduleReview(card, grade, fixedTime), originalScheduler.scheduleReview(card, grade, fixedTime));
      checked++;
    }
    for (const dates of [[], ["2026-10-24"], ["2026-10-22", "2026-10-23", "2026-10-24"],
      ["2026-10-20", "2026-10-21", "2026-10-24", "2026-10-24"]]) {
      assert.deepEqual(cloneStreaks.computeStreak(dates, "2026-10-25"), originalStreaks.computeStreak(dates, "2026-10-25"));
      checked++;
    }
    console.log(`Recall archive reconstruction: ${checked} original-vs-clone checks passed`);
    console.log(`Archive SHA-256: ${JSON.parse(fs.readFileSync(path.join(clone, "evidence.json"), "utf8")).archive_sha256}`);
    return clone;
  } finally {
    globalThis.Date = originalDate;
    // Keep the generated project for optional Electron runtime inspection.
    console.log(`Verification workspace: ${temp}`);
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
