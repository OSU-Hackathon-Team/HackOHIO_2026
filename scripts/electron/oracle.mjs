/**
 * Target-neutral Electron behavior oracle.
 *
 * Extracts a packaged archive into a disposable directory and runs its main process in a child
 * Node worker under a mocked Electron host. The worker registers the app's real IPC handlers, so
 * a caller can invoke channels with arguments and fixtures and observe results, errors, file
 * effects and the file paths the app read or wrote. Nothing here knows any application's name,
 * channels or storage layout.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as asar from "@electron/asar";

const self = fileURLToPath(import.meta.url);
const BASES = ["userData", "documents", "logs", "temp"];

/* Host parameters a channel's result may legitimately depend on. They are inputs to the mocked
   host, so a case can be replayed under a second configuration: a result that changes is
   host-dependent, and the feature contract cannot reproduce it. */
export const DEFAULT_HOST = { bounds: { x: 0, y: 0, width: 800, height: 600 },
  display: { width: 1280, height: 800 } };
export const VARIANT_HOST = { bounds: { x: 40, y: 60, width: 1024, height: 720 },
  display: { width: 1920, height: 1080 } };

function hostConfig(host) {
  return { bounds: { ...DEFAULT_HOST.bounds, ...(host?.bounds ?? {}) },
    display: { ...DEFAULT_HOST.display, ...(host?.display ?? {}) } };
}

function within(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw new Error(`Invalid relative path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error(`Path leaves its root: ${relative}`);
  return resolved;
}

/** JSON-safe copy of whatever a handler returned. */
export function sanitize(value, seen = new WeakSet()) {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "function") return { $function: value.name || "anonymous" };
  if (typeof value !== "object") return { $type: typeof value };
  if (seen.has(value)) return { $circular: true };
  seen.add(value);
  if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [sanitize(k, seen), sanitize(v, seen)]) };
  if (value instanceof Set) return { $set: [...value].map(item => sanitize(item, seen)) };
  if (value instanceof Error) return { $error: { name: value.name, message: value.message } };
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sanitize(value[key], seen);
  return out;
}

async function snapshot(root) {
  const files = {};
  async function walk(directory, prefix) {
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), next);
      else if (entry.isFile()) {
        const file = path.join(directory, entry.name);
        let bytes;
        try { bytes = await fsp.readFile(file); }
        catch (error) {
          /* An application may replace a file while it is read (electron-store writes a temporary
             file and renames it). A file that is gone by the time it is opened is not an effect. */
          if (error.code === "ENOENT") continue;
          throw error;
        }
        files[next] = bytes.length > 262144
          ? { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length }
          : bytes.toString("utf8");
      }
    }
  }
  for (const base of BASES) {
    const root0 = root[base];
    if (root0) await walk(root0, base);
  }
  return files;
}

function diffFiles(before, after) {
  const changed = {}, removed = [];
  for (const [key, value] of Object.entries(after)) if (JSON.stringify(before[key]) !== JSON.stringify(value)) changed[key] = value;
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(key);
  return { changed, removed };
}

/** One case: fresh data directory, optional fixtures, then ordered IPC calls. */
export function validateCase(value) {
  if (!value || typeof value !== "object") throw new Error("A case must be an object");
  const calls = value.calls ?? (value.channel ? [{ channel: value.channel, args: value.args ?? [] }] : []);
  if (!Array.isArray(calls)) throw new Error("calls must be an array");
  for (const call of calls) {
    if (typeof call.channel !== "string" || !call.channel) throw new Error("Every call needs a channel");
    if (call.args !== undefined && !Array.isArray(call.args)) throw new Error("Call args must be an array");
  }
  const fixtures = value.fixtures ?? [];
  if (!Array.isArray(fixtures)) throw new Error("Fixtures must be an array");
  for (const fixture of fixtures) {
    if (!BASES.includes(fixture?.base)) throw new Error(`Fixture base must be one of ${BASES.join(", ")}`);
    if (typeof fixture.path !== "string") throw new Error("Fixture needs a relative path");
  }
  if (value.fixed_time !== undefined && !Number.isFinite(Date.parse(value.fixed_time)))
    throw new Error("fixed_time must be an ISO date");
  return { fixtures, calls: calls.map(call => ({ channel: call.channel, args: call.args ?? [] })),
    fixed_time: value.fixed_time ?? null };
}

/** Run a validated case against an extracted app directory. */
export async function runCase({ appDir, case: rawCase, timeout = 20000, host }) {
  appDir = path.resolve(appDir);
  const testCase = validateCase(rawCase);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-oracle-run-"));
  try {
    const bases = {};
    for (const base of BASES) {
      bases[base] = path.join(root, base);
      await fsp.mkdir(bases[base]);
    }
    for (const fixture of testCase.fixtures) {
      const file = within(bases[fixture.base], fixture.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, typeof fixture.content === "string" ? fixture.content : JSON.stringify(fixture.content, null, 2));
    }
    const pkg = JSON.parse(await fsp.readFile(path.join(appDir, "package.json"), "utf8"));
    const main = within(appDir, String(pkg.main ?? "index.js"));
    if (!fs.existsSync(main)) throw new Error(`Main entry is missing: ${main}`);
    /* Match the worker's normalization so a fixture that mentions its own absolute location is
       not reported as a change on the first call. */
    const labels = BASES.map(base => [bases[base], base]).concat([[appDir, "<app>"]])
      .sort((first, second) => second[0].length - first[0].length);
    const initial = Object.fromEntries(Object.entries(await snapshot(bases)).map(([file, value]) => [file,
      typeof value === "string"
        ? labels.reduce((text, [absolute, label]) => text.split(absolute).join(label), value)
        : value]));
    const esmMain = pkg.type === "module" || String(pkg.main ?? "").endsWith(".mjs");
    const result = await runWorker({ appDir, main, esmMain, packageName: pkg.name, packageVersion: pkg.version,
      bases, calls: testCase.calls, fixed_time: testCase.fixed_time, host: hostConfig(host) }, timeout);
    const effects = [];
    let files = initial;
    for (const outcome of result.outcomes) {
      const next = outcome.files;
      effects.push(diffFiles(files, next));
      delete outcome.files;
      files = next;
    }
    const io = result.io.filter(entry => typeof entry.path === "string" &&
      !(entry.path === appDir || entry.path.startsWith(`${appDir}${path.sep}`)));
    return { channels: result.channels, outcomes: result.outcomes, io, initial, files, effects,
      bridge: result.bridge ?? [], windows: result.windows ?? [], startup_error: result.startup_error ?? null };
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function runWorker(payload, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, "--worker"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Oracle worker timed out after ${timeout} ms`)); }, timeout);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Oracle worker exited ${code}: ${stderr.trim() || stdout.trim()}`));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`Oracle worker returned invalid JSON: ${error.message}\n${stdout.slice(0, 4000)}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

function recordIo(io, bases) {
  const label = absolute => {
    for (const base of BASES) {
      const root = bases[base];
      if (root && (absolute === root || absolute.startsWith(`${root}${path.sep}`)))
        return path.posix.join(base, path.relative(root, absolute).split(path.sep).join("/"));
    }
    return absolute;
  };
  const fsModule = createRequire(import.meta.url)("node:fs");
  const promises = fsModule.promises;
  for (const [owner, name, key] of [[fsModule, "readFile", "read"], [fsModule, "writeFile", "write"],
    [fsModule, "appendFile", "write"], [fsModule, "readFileSync", "read"], [fsModule, "writeFileSync", "write"],
    [fsModule, "appendFileSync", "write"], [fsModule, "readdir", "list"], [fsModule, "readdirSync", "list"],
    [fsModule, "mkdir", "mkdir"], [fsModule, "mkdirSync", "mkdir"]]) {
    const original = owner[name];
    if (typeof original !== "function") continue;
    owner[name] = function (first, ...rest) {
      try { if (typeof first === "string") io.push({ op: key, path: label(path.resolve(first)) }); }
      catch { /* non-path argument */ }
      return original.call(this, first, ...rest);
    };
  }
  for (const [name, key] of [["readFile", "read"], ["writeFile", "write"], ["appendFile", "write"],
    ["readdir", "list"], ["mkdir", "mkdir"]]) {
    const original = promises[name];
    if (typeof original !== "function") continue;
    promises[name] = function (first, ...rest) {
      try { if (typeof first === "string") io.push({ op: key, path: label(path.resolve(first)) }); }
      catch { /* non-path argument */ }
      return original.call(this, first, ...rest);
    };
  }
}

async function worker() {
  const payload = await readStdin();
  const output = process.stdout.write.bind(process.stdout);
  const error = process.stderr.write.bind(process.stderr);
  console.log = (...args) => error(args.map(String).join(" ") + "\n");
  console.info = console.log;
  console.warn = console.log;
  process.stdout.write = (chunk, ...rest) => error(chunk, ...rest);
  /* Libraries branch on process.type. Without it, packages such as electron-log load their
     renderer preload inside the main process and crash on renderer-only globals. */
  if (!process.type) process.type = "browser";
  try { process.versions.electron ??= "45.0.0"; } catch { /* versions may be frozen */ }

  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  const pathModule = require("node:path");
  const io = [];
  recordIo(io, payload.bases);

  const handlers = new Map(), windows = [], bridge = [];
  const readyCallbacks = [];
  /* app.whenReady() chains real work (vault loading, handler registration). Track every
     continuation so a call can never race the app's own startup. */
  class TrackedPromise {
    constructor(promise) { this.promise = promise; }
    then(onFulfilled, onRejected) {
      const next = Promise.resolve(this.promise).then(onFulfilled, onRejected);
      readyCallbacks.push(next);
      return new TrackedPromise(next);
    }
    catch(onRejected) { return this.then(undefined, onRejected); }
    finally(onFinally) {
      const next = Promise.resolve(this.promise).finally(onFinally);
      readyCallbacks.push(next);
      return new TrackedPromise(next);
    }
  }
  const sender = {
    send: () => {}, invoke: async () => undefined, postMessage: () => {},
    on: () => {}, once: () => {}, removeListener: () => {},
    id: 1, isDestroyed: () => false,
  };
  /* A handler is invoked by a window, and real main processes resolve that window with
     BrowserWindow.fromWebContents(event.sender). When the app has not created one yet, provide a
     default window so bound-dependent call shapes run instead of failing on null. */
  let defaultWindow = null;
  const senderWindow = () => windows[0] ?? (defaultWindow ??= new BrowserWindow(payload.host.bounds));
  const fakeEvent = { get sender() { return senderWindow().webContents; },
    senderFrame: { url: `file://${payload.appDir}/index.html` }, frameId: 1, processId: 1 };
  const webContents = () => ({
    send: () => {}, postMessage: () => {}, on: () => {}, once: () => {}, removeListener: () => {},
    executeJavaScript: async () => undefined, setWindowOpenHandler: () => {}, openDevTools: () => {},
    loadURL: async () => {}, loadFile: async () => {}, session: null, id: windows.length + 1,
    isDestroyed: () => false, getURL: () => "about:blank",
  });
  class BrowserWindow {
    constructor(options = {}) {
      this.options = options;
      this.webContents = { ...webContents(), session: null };
      this.id = windows.length + 1;
      windows.push(this);
    }
    loadURL(url) { this.url = String(url); this.webContents.loadURL?.(url); return Promise.resolve(); }
    loadFile(file) { this.url = `file://${pathModule.resolve(payload.appDir, String(file))}`; return Promise.resolve(); }
    on() { return this; } once() { return this; } removeListener() { return this; }
    show() {} hide() {} focus() {} close() {} destroy() {} isDestroyed() { return false; }
    getBounds() { const { x = 0, y = 0, width = 800, height = 600 } = this.options; return { x, y, width, height }; }
    getContentBounds() { return this.getBounds(); }
    setContentBounds(next) { this.setBounds(next); }
    setBounds(next) { this.options = { ...this.options, ...next }; }
    getSize() { const { width = 800, height = 600 } = this.options; return [width, height]; }
    setSize(width, height) { this.options = { ...this.options, width, height }; }
    isMaximized() { return false; } maximize() {} unmaximize() {} isMinimized() { return false; }
    minimize() {} restore() {}
    static getAllWindows() { return windows; }
    static getFocusedWindow() { return windows[0] ?? null; }
    static fromWebContents(contents) { return windows.find(window => window.webContents === contents) ?? null; }
    static fromId(id) { return windows.find(window => window.id === id) ?? null; }
  }
  /* Lifecycle listeners: apps commonly do real startup work in app.on("ready"), not only in
     whenReady() chains. Without emitting it, settings stores and timers stay uninitialized and
     every handler looks broken. */
  const appListeners = new Map();
  const appOn = (event, listener, once = false) => {
    if (typeof listener !== "function") return app;
    const entry = { listener, once };
    appListeners.set(event, [...(appListeners.get(event) ?? []), entry]);
    return app;
  };
  /* app.getPath is a lookup, not a capability gate: an unsupported key must return the path the
     platform would use, not throw, or every channel that reads a directory looks broken. */
  const home = pathModule.join(pathModule.dirname(payload.bases.userData), "home");
  const systemPaths = {
    home,
    appData: pathModule.dirname(payload.bases.userData),
    sessionData: payload.bases.userData,
    crashDumps: pathModule.join(payload.bases.userData, "crashDumps"),
    desktop: pathModule.join(home, "Desktop"),
    downloads: pathModule.join(home, "Downloads"),
    music: pathModule.join(home, "Music"),
    pictures: pathModule.join(home, "Pictures"),
    videos: pathModule.join(home, "Videos"),
    recent: pathModule.join(home, "Recent"),
    exe: pathModule.join(payload.appDir, "app"),
    module: payload.appDir,
  };
  const app = {
    whenReady: () => new TrackedPromise(Promise.resolve()),
    isReady: () => true,
    on: (event, listener) => appOn(event, listener),
    once: (event, listener) => appOn(event, listener, true),
    off: (event, listener) => { appListeners.set(event, (appListeners.get(event) ?? [])
      .filter(entry => entry.listener !== listener)); return app; },
    removeListener: (event, listener) => app.off(event, listener),
    removeAllListeners: event => { appListeners.delete(event); return app; },
    emit: (event, ...args) => {
      const entries = appListeners.get(event) ?? [];
      appListeners.set(event, entries.filter(entry => !entry.once));
      for (const entry of entries) {
        try { entry.listener(...args); }
        catch (caught) { try { error(`${caught?.stack ?? caught}\n`); } catch { /* stderr is closed */ } }
      }
      return entries.length > 0;
    },
    getPath: key => {
      const value = payload.bases[key] ?? systemPaths[key];
      if (!value) throw new Error(`App requested unsupported Electron path ${key}`);
      return value;
    },
    setPath: () => {},
    getName: () => payload.packageName ?? "app",
    getVersion: () => payload.packageVersion ?? "0.0.0",
    getAppPath: () => payload.appDir,
    getLocale: () => "en-US",
    isPackaged: false,
    quit: () => {}, exit: () => {}, relaunch: () => {}, focus: () => {},
    setAppUserModelId: () => {}, requestSingleInstanceLock: () => true, releaseSingleInstanceLock: () => {},
    disableHardwareAcceleration: () => {}, setAsDefaultProtocolClient: () => true,
    commandLine: { appendSwitch: () => {}, hasSwitch: () => false, getSwitchValue: () => "" },
  };
  const noopEmitter = { on: () => {}, once: () => {}, removeListener: () => {}, emit: () => false };
  const electron = {
    app,
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      handleOnce: (channel, handler) => { handlers.set(channel, handler); },
      on: (channel, handler) => { handlers.set(channel, handler); },
      once: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: channel => { handlers.delete(channel); },
      removeListener: () => {}, removeAllListeners: () => {},
    },
    /* The main process has no ipcRenderer: in real Electron require("electron") inside main
       only exposes main-process APIs. Libraries such as electron-log branch on that absence. */
    contextBridge: {
      exposeInMainWorld: (name, value) => { bridge.push({ global: name, methods: Object.keys(value ?? {}) }); },
      exposeInIsolatedWorld: () => {},
    },
    BrowserWindow,
    webContents: { getAllWebContents: () => windows.map(window => window.webContents), fromId: () => null },
    /* Real Electron resolves BrowserWindow.fromWebContents(event.sender); channels such as
       "get-window-bounds" are useless without it. */
    /* (fromWebContents is defined on BrowserWindow below.) */
    session: {
      defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {},
        protocol: { handle: () => {}, registerFileProtocol: () => {} }, webRequest: noopEmitter,
        getPreloads: () => [], setPreloads: () => {}, getStoragePath: () => payload.bases.userData,
        clearStorageData: async () => {}, flushStorageData: async () => {},
        cookies: { get: async () => [], set: async () => {}, remove: async () => {} } },
      fromPartition: () => electron.session.defaultSession,
    },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}), getApplicationMenu: () => null,
      sendActionToFirstResponder: () => {} },
    Tray: class {
      constructor() {} setImage() {} setPressedImage() {} setToolTip() {} setTitle() {} getTitle() { return ""; }
      setContextMenu() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; } popUpContextMenu() {}
      close() {} destroy() {} isDestroyed() { return false; } setIgnoreDoubleClickEvents() {}
      getIgnoreDoubleClickEvents() { return false; } displayBalloon() {} removeBalloon() {} focus() {}
      on() { return this; } once() { return this; } addListener() { return this; }
      removeListener() { return this; } removeAllListeners() { return this; }
    },
    nativeImage: (() => {
      const image = () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }),
        getAspectRatio: () => 1, resize: () => image(), crop: () => image(),
        toPNG: () => Buffer.alloc(0), toJPEG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(0),
        toDataURL: () => "data:image/png;base64,", isTemplateImage: () => false,
        setTemplateImage: () => {}, addRepresentation: () => {} });
      return { createEmpty: () => image(), createFromPath: () => image(), createFromBuffer: () => image(),
        createFromBitmap: () => image(), createFromDataURL: () => image(), createFromNamedImage: () => image() };
    })(),
    Notification: class { constructor() {} show() {} on() {} close() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: null }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
      showErrorBox: () => {} },
    shell: { openExternal: async () => {}, openPath: async () => "", showItemInFolder: () => {}, beep: () => {} },
    clipboard: { readText: () => "", writeText: () => {}, readImage: () => null, writeImage: () => {} },
    nativeTheme: noopEmitter,
    screen: (() => {
      const { width, height } = payload.host.display;
      const bounds = { x: 0, y: 0, width, height };
      const display = { id: 1, label: "", bounds, workArea: bounds,
        size: { width, height }, workAreaSize: { width, height }, scaleFactor: 1, rotation: 0,
        internal: false, touchSupport: "unknown", accelerometerSupport: "unknown", colorSpace: "srgb",
        colorDepth: 24, depthPerComponent: 8, displayFrequency: 60, monochrome: false };
      const primary = () => display;
      return { getPrimaryDisplay: primary, getAllDisplays: () => [display],
        getDisplayNearestPoint: primary, getDisplayMatching: primary, getDisplayNearestWindow: primary,
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        screenToDipPoint: point => point, dipToScreenPoint: point => point,
        screenToDipRect: rect => rect, dipToScreenRect: rect => rect };
    })(),
    powerMonitor: noopEmitter,
    globalShortcut: { register: () => true, isRegistered: () => false, unregister: () => {},
      unregisterAll: () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(String(value)),
      decryptString: value => Buffer.from(value).toString() },
    net: { fetch: (...args) => fetch(...args), request: () => { throw new Error("net.request is unavailable in the oracle"); } },
    autoUpdater: noopEmitter,
    utilityProcess: { fork: () => { throw new Error("utilityProcess is unavailable in the oracle"); } },
  };
  const nativeLoad = Module._load;
  Module._load = function (name, parent, isMain) {
    if (name === "electron") return electron;
    return nativeLoad.call(this, name, parent, isMain);
  };
  /* ES module main processes ("type": "module", import from "electron") bypass Module._load.
     Publish the same host through a shim package in the extracted directory's node_modules and
     expose it on a global that the ESM shim reads. Writes are idempotent and atomic so parallel
     cases can share one extracted app. */
  function exposeElectronToEsm() {
    const directory = pathModule.join(payload.appDir, "node_modules", "electron");
    const write = (name, content) => {
      const file = pathModule.join(directory, name);
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
      const temporary = `${file}.${process.pid}.tmp`;
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, content);
      fs.renameSync(temporary, file);
    };
    const keys = Object.keys(electron);
    write("package.json", JSON.stringify({ name: "electron", version: "0.0.0-splice-oracle",
      main: "index.cjs",
      exports: { ".": { import: "./index.mjs", require: "./index.cjs" },
        "./main": { import: "./index.mjs", require: "./index.cjs" },
        "./common": { import: "./index.mjs", require: "./index.cjs" },
        "./renderer": { import: "./index.mjs", require: "./index.cjs" } } }, null, 2) + "\n");
    write("index.cjs", "\"use strict\";\nmodule.exports = globalThis.__spliceElectron;\n");
    write("index.mjs", ["const host = globalThis.__spliceElectron;",
      ...keys.map(key => `export const ${key} = host.${key};`),
      "export default host;", ""].join("\n"));
  }
  globalThis.__spliceElectron = electron;
  try { exposeElectronToEsm(); } catch { /* A read-only app directory falls back to require only. */ }
  if (payload.fixed_time) {
    const NativeDate = globalThis.Date, instant = Date.parse(payload.fixed_time);
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [instant])); }
      static now() { return instant; }
    };
  }
  /* Harness-owned absolute paths are not behavior: each observation runs in its own directory, so
     a result, an error message or a written file that mentions one would differ between the
     original and a reimplementation that computes the same path from ctx. Report them as the
     storage root they came from, and keep everything else byte for byte. */
  const pathLabels = BASES.filter(base => payload.bases[base])
    .map(base => [pathModule.resolve(payload.bases[base]), base])
    .concat([[pathModule.resolve(payload.appDir), "<app>"]])
    .sort((first, second) => second[0].length - first[0].length);
  const normalizeText = text => {
    let out = String(text);
    for (const [absolute, label] of pathLabels) out = out.split(absolute).join(label);
    return out;
  };
  const normalizeValue = value => {
    if (typeof value === "string") return normalizeText(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
    return value;
  };
  const normalizeFiles = files => Object.fromEntries(Object.entries(files)
    .map(([file, value]) => [file, typeof value === "string" ? normalizeText(value) : value]));

  const outcomes = [];
  let startupError = null;
  try {
    if (payload.esmMain) await import(pathToFileURL(payload.main).href);
    else require(payload.main);
    await Promise.allSettled(readyCallbacks);
    app.emit("ready");
    await Promise.allSettled(readyCallbacks);
    const settled = await Promise.allSettled(readyCallbacks);
    startupError = settled.find(item => item.status === "rejected")?.reason;
    /* The calls arrive from a window; a handler that looks up its invoking window must find one. */
    senderWindow();
    for (const call of payload.calls) {
      const handler = handlers.get(call.channel);
      let outcome;
      if (!handler) outcome = { ok: false, error: { name: "MissingHandler", message: "No handler registered", code: null } };
      else {
        try {
          const value = await handler(fakeEvent, ...call.args);
          outcome = { ok: true, value: normalizeValue(sanitize(value)) };
        } catch (caught) {
          outcome = { ok: false, error: { name: caught?.name ?? "Error",
            message: normalizeText(caught?.message ?? caught), code: caught?.code ?? null,
            ...(process.env.SPLICE_ORACLE_STACKS ? { stack: String(caught?.stack ?? "") } : {}) } };
        }
      }
      outcome.files = normalizeFiles(await snapshot(payload.bases));
      outcomes.push(outcome);
    }
    const body = JSON.stringify({ channels: [...handlers.keys()].sort().map(channel => ({
      channel, arity: Math.max(0, (handlers.get(channel)?.length ?? 1) - 1) })), outcomes, io, bridge,
      windows: windows.map(window => ({ url: window.url ?? null })),
      startup_error: startupError ? { name: startupError.name ?? "Error",
        message: String(startupError.message ?? startupError) } : null });
    /* The app may have started timers, sockets or watchers. Report and exit deliberately instead
       of waiting for its event loop to drain, which it never does for a real application. */
    await new Promise((resolve, reject) => {
      output(body, error => (error ? reject(error) : resolve()));
    });
    process.exit(0);
  } catch (caught) {
    error(`${caught?.stack ?? caught}\n`);
    process.exit(1);
  } finally {
    Module._load = nativeLoad;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === "--worker") {
    worker().catch(caught => { console.error(caught); process.exitCode = 1; });
  } else {
    const [archive, caseFile] = process.argv.slice(2);
    if (!archive || !caseFile) {
      console.error("Usage: node scripts/electron/oracle.mjs <app.asar> <case.json>");
      process.exitCode = 2;
    } else {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "splice-oracle-app-"));
      try {
        asar.extractAll(path.resolve(archive), temp);
        const result = await runCase({ appDir: temp, case: JSON.parse(fs.readFileSync(caseFile, "utf8")) });
        console.log(JSON.stringify(result, null, 2));
      } catch (caught) {
        console.error(caught.message);
        process.exitCode = 1;
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    }
  }
}
