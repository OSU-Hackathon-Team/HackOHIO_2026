import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";

const self = fileURLToPath(import.meta.url);

function within(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error(`Invalid relative path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Path leaves workspace: ${relative}`);
  return resolved;
}

function validateScenario(scenario) {
  if (!scenario || typeof scenario !== "object" || !Array.isArray(scenario.calls) || !scenario.calls.length)
    throw new Error("Scenario needs at least one IPC call");
  if (scenario.fixed_time !== undefined && !Number.isFinite(Date.parse(scenario.fixed_time)))
    throw new Error("fixed_time must be an ISO date");
  for (const item of [...(scenario.fixtures || []), ...(scenario.compare_files || [])]) {
    if (!["userData", "documents"].includes(item.base) || typeof item.path !== "string")
      throw new Error("File entries need base userData/documents and a relative path");
    within(path.resolve(os.tmpdir()), item.path);
  }
  for (const call of scenario.calls) {
    if (typeof call.channel !== "string" || !Array.isArray(call.args))
      throw new Error("Each call needs a channel and args array");
  }
  return scenario;
}

async function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, "--worker"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`App probe exited ${code}: ${stderr.trim() || stdout.trim()}`));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`App probe returned invalid JSON: ${error.message}\n${stdout}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function verifyProject(archivePath, projectPath, scenarioPath) {
  const archive = path.resolve(archivePath), project = path.resolve(projectPath);
  const scenario = validateScenario(JSON.parse(await fsp.readFile(scenarioPath, "utf8")));
  const projectPackage = JSON.parse(await fsp.readFile(path.join(project, "package.json"), "utf8"));
  const candidateMain = within(project, projectPackage.main || "index.js");
  if (!fs.existsSync(candidateMain)) throw new Error(`Candidate main entry is missing: ${candidateMain}`);
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-electron-verify-"));
  try {
    const original = path.join(temp, "original");
    await fsp.mkdir(original);
    asar.extractAll(archive, original);
    const originalPackage = JSON.parse(await fsp.readFile(path.join(original, "package.json"), "utf8"));
    const originalMain = within(original, originalPackage.main || "index.js");
    const probes = [];
    for (const [label, main] of [["original", originalMain], ["candidate", candidateMain]]) {
      const data = path.join(temp, `${label}-data`);
      await fsp.mkdir(data);
      const bases = { userData: path.join(data, "userData"), documents: path.join(data, "documents") };
      for (const base of Object.values(bases)) await fsp.mkdir(base);
      for (const fixture of scenario.fixtures || []) {
        const file = within(bases[fixture.base], fixture.path);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, typeof fixture.content === "string" ? fixture.content : JSON.stringify(fixture.content, null, 2));
      }
      probes.push(await runWorker({ main, bases, calls: scenario.calls, compare_files: scenario.compare_files || [], fixed_time: scenario.fixed_time }));
    }
    const [expected, actual] = probes;
    for (const call of scenario.calls)
      assert.ok(expected.channels.includes(call.channel), `Scenario calls an unknown original IPC channel ${call.channel}`);
    for (const channel of expected.channels)
      assert.ok(actual.channels.includes(channel), `Candidate is missing original IPC channel ${channel}`);
    assert.equal(actual.outcomes.length, expected.outcomes.length, "Candidate call count differs");
    for (let i = 0; i < expected.outcomes.length; i++) {
      assert.deepEqual(actual.outcomes[i], expected.outcomes[i],
        `IPC result or file effects differ at call ${i + 1}: ${scenario.calls[i].channel}`);
    }
    return { archive, project, scenario: path.resolve(scenarioPath), channels: expected.channels,
      checks: expected.outcomes.length, result: "passed" };
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

async function worker() {
  const payload = await readStdin();
  console.log = (...args) => console.error(...args);
  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  const handlers = new Map(), ready = [];
  const electron = {
    app: {
      whenReady: () => ({ then(fn) { const promise = Promise.resolve().then(fn); ready.push(promise); return promise; } }),
      getPath: key => {
        if (!payload.bases[key]) throw new Error(`App requested unsupported Electron path ${key}`);
        return payload.bases[key];
      },
      on: () => {}, quit: () => {},
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    BrowserWindow: class {
      webContents = { setWindowOpenHandler: () => {}, on: () => {} };
      loadURL() {} loadFile() {}
      static getAllWindows() { return []; }
    },
  };
  const nativeLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (name === "electron") return electron;
    return nativeLoad.call(this, name, parent, isMain);
  };
  if (payload.fixed_time) {
    const NativeDate = globalThis.Date, instant = Date.parse(payload.fixed_time);
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [instant])); }
      static now() { return instant; }
    };
  }
  try {
    require(payload.main);
    await Promise.all(ready);
    const outcomes = [];
    for (const call of payload.calls) {
      const handler = handlers.get(call.channel);
      let result;
      if (!handler) result = { ok: false, name: "MissingHandler", code: null };
      else {
        try { result = { ok: true, value: await handler({}, ...call.args) }; }
        catch (error) { result = { ok: false, name: error.name, code: error.code ?? null }; }
      }
      const files = {};
      for (const item of payload.compare_files) {
        const key = `${item.base}/${item.path}`;
        try { files[key] = await fsp.readFile(within(payload.bases[item.base], item.path), "utf8"); }
        catch (error) { if (error.code === "ENOENT") files[key] = null; else throw error; }
      }
      outcomes.push({ result, files });
    }
    process.stdout.write(JSON.stringify({ channels: [...handlers.keys()], outcomes }));
  } finally { Module._load = nativeLoad; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === "--worker") worker().catch(error => { console.error(error); process.exitCode = 1; });
  else if (process.argv.length !== 5) {
    console.error("Usage: node scripts/electron/verify-project.mjs <app.asar> <generated-project> <scenario.json>");
    process.exitCode = 2;
  } else verifyProject(process.argv[2], process.argv[3], process.argv[4])
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
