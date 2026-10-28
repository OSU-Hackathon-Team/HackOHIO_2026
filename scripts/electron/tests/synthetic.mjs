import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as asar from "@electron/asar";

export const APP_SOURCE = `"use strict";
const { app, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");

const notes = () => path.join(app.getPath("userData"), "notes");

app.whenReady().then(() => {
  ipcMain.handle("notes:add", async (_event, name, text) => {
    if (typeof name !== "string" || !name) throw new TypeError("name required");
    const value = String(text).trim();
    await fs.mkdir(notes(), { recursive: true });
    await fs.writeFile(path.join(notes(), name + ".txt"), value);
    return { name, length: value.length };
  });
  ipcMain.handle("notes:read", async (_event, name) =>
    fs.readFile(path.join(notes(), name + ".txt"), "utf8"));
});
`;

/* An application with one channel whose answer comes from the invoking window and the display:
   the feature-module contract cannot express it, so the driver must not claim it. */
export const HOST_APP_SOURCE = `"use strict";
const { app, ipcMain, BrowserWindow, screen } = require("electron");
const path = require("path");
const fs = require("fs/promises");

app.whenReady().then(() => {
  ipcMain.handle("window:bounds", event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return { ...window.getBounds(), display: screen.getPrimaryDisplay().size.width };
  });
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("notes:add", async (_event, name, text) => {
    if (typeof name !== "string" || !name) throw new TypeError("name required");
    const value = String(text).trim();
    await fs.mkdir(path.join(app.getPath("userData"), "notes"), { recursive: true });
    await fs.writeFile(path.join(app.getPath("userData"), "notes", name + ".txt"), value);
    return { name, length: value.length };
  });
});
`;

export const HOST_SPEC = {
  schema_version: 2,
  application: {
    name: "synthetic-host",
    version: "1.0.0",
    scope: ["window:bounds and notes:add IPC behavior"],
    exclusions: ["renderer layout"],
    environments: { clock: "2026-10-25T12:00:00.000Z" },
  },
  channels: {
    "app:version": {
      feature: "features/version.cjs",
      args: [[], [null]],
      requirements: [
        "Returns the application version string and ignores any argument.",
      ],
    },
    "window:bounds": {
      feature: "features/bounds.cjs",
      args: [[], []],
      requirements: ["Returns the invoking window's bounds and the primary display width."],
    },
    "notes:add": {
      feature: "features/add.cjs",
      fixtures: [],
      args: [["alpha", " hello "], ["beta", "world"], ["", "x"]],
      requirements: [
        "Trims the note text and writes userData/notes/<name>.txt with the trimmed text and no newline.",
        "Throws TypeError with message 'name required' when name is not a nonempty string.",
        "Returns { name, length } where length is the trimmed text length.",
      ],
    },
  },
};

/* One subsystem of the host application: a scoped run declares and verifies only this channel. */
export const SUBSYSTEM_SPEC = {
  schema_version: 2,
  application: {
    name: "synthetic-host",
    version: "1.0.0",
    scope: ["notes:add IPC behavior", "note files under userData/notes"],
    exclusions: ["renderer layout"],
    environments: { clock: "2026-10-25T12:00:00.000Z" },
  },
  channels: {
    "notes:add": {
      feature: "features/add.cjs",
      fixtures: [],
      args: [["alpha", " hello "], ["beta", "world"], ["", "x"]],
      requirements: [
        "Trims the note text and writes userData/notes/<name>.txt with the trimmed text and no newline.",
        "Throws TypeError with message 'name required' when name is not a nonempty string.",
        "Returns { name, length } where length is the trimmed text length.",
      ],
    },
  },
};

export async function hostSyntheticArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-host-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-host", version: "1.0.0", main: "main.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), HOST_APP_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

export const VERSION_FEATURE = `"use strict";
module.exports = async function (args, ctx) {
  return ctx.app.getVersion();
};
`;

/* A main process that touches the Electron-only process properties and native bindings large apps
   use at import time (protocol schemes, systemPreferences, process._linkedBinding). */
export const HOST_SURFACE_SOURCE = `"use strict";
const { app, ipcMain, protocol, systemPreferences } = require("electron");

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true } }]);
const v8Util = process._linkedBinding ? process._linkedBinding("electron_common_v8_util") : null;
const features = process._linkedBinding ? process._linkedBinding("electron_common_features") : null;

app.whenReady().then(() => {
  ipcMain.handle("host:surface", () => ({
    scheme: typeof protocol.registerSchemesAsPrivileged,
    dark: systemPreferences.isDarkMode(),
    resources: Boolean(process.resourcesPath),
    defaultApp: process.defaultApp,
    linked: v8Util && typeof v8Util.getHiddenValue,
    hidden: v8Util && v8Util.getHiddenValue({}, "anything"),
    flag: features && features.isViewApiEnabled && features.isViewApiEnabled(),
  }));
});
`;

export async function hostSurfaceArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-surface-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-surface", version: "1.0.0", main: "main.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), HOST_SURFACE_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

/* One feature module declared for two channels: an implementation can only answer them
   differently if the contract says which channel is being invoked. */
export const SHARED_SOURCE = `"use strict";
const { app, ipcMain } = require("electron");

app.whenReady().then(() => {
  ipcMain.handle("state:name", () => "state");
  ipcMain.handle("state:count", () => 3);
});
`;

export const SHARED_SPEC = {
  schema_version: 2,
  application: {
    name: "synthetic-shared",
    version: "1.0.0",
    scope: ["state IPC behavior"],
    exclusions: ["renderer layout"],
    environments: { clock: "2026-10-25T12:00:00.000Z" },
  },
  channels: {
    "state:name": { feature: "features/state.cjs", args: [[], [null]],
      requirements: ["Returns the string 'state'."] },
    "state:count": { feature: "features/state.cjs", args: [[], [null]],
      requirements: ["Returns the number 3."] },
  },
};

export const SHARED_FEATURE = `"use strict";
module.exports = async function (args, ctx) {
  return ctx.channel === "state:name" ? "state" : 3;
};
`;

export async function sharedArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-shared-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-shared", version: "1.0.0", main: "main.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), SHARED_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

/* An application that cannot even start when a particular fixture is present: no case built on
   that fixture can produce an expectation, and the specification stage has to repair it. */
export const FRAGILE_SOURCE = `"use strict";
const { app, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

if (fs.existsSync(path.join(app.getPath("userData"), "state.lock"))) process.exit(3);

app.whenReady().then(() => {
  ipcMain.handle("safe:echo", (_event, value) => String(value));
});
`;

export const FRAGILE_SPEC = {
  schema_version: 2,
  application: {
    name: "synthetic-fragile",
    version: "1.0.0",
    scope: ["safe:echo IPC behavior"],
    exclusions: ["renderer layout"],
    environments: { clock: "2026-10-25T12:00:00.000Z" },
  },
  channels: {
    "safe:echo": {
      feature: "features/echo.cjs",
      /* The lock file makes the original exit before it registers anything. */
      fixtures: [{ base: "userData", path: "state.lock", content: "" }],
      args: [["alpha"], ["beta"]],
      requirements: ["Returns its argument as a string."],
    },
  },
};

/** The same specification after the stage repaired the fixture that made the app exit. */
export const FRAGILE_SPEC_REPAIRED = {
  ...FRAGILE_SPEC,
  channels: { "safe:echo": { ...FRAGILE_SPEC.channels["safe:echo"], fixtures: [],
    args: [["alpha"], ["beta"]] } },
};

export const ECHO_FEATURE = `"use strict";
module.exports = async function (args) {
  return String(args[0]);
};
`;

export async function fragileArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-fragile-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-fragile", version: "1.0.0", main: "main.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), FRAGILE_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

/* An application whose stable-looking channel mints a random identifier only inside a stateful
   sequence: checking one case per channel would verify the original's own random key. */
export const REGISTRY_SOURCE = `"use strict";
const { app, ipcMain } = require("electron");
const crypto = require("crypto");

const items = {};

app.whenReady().then(() => {
  ipcMain.handle("registry:add", () => {
    items[crypto.randomBytes(8).toString("hex")] = { at: Date.now() };
    return Object.keys(items).length;
  });
  ipcMain.handle("registry:list", () => items);
});
`;

export const REGISTRY_SPEC = {
  schema_version: 2,
  application: {
    name: "synthetic-registry",
    version: "1.0.0",
    scope: ["registry IPC behavior"],
    exclusions: ["renderer layout"],
    environments: { clock: "2026-10-25T12:00:00.000Z" },
  },
  channels: {
    "registry:add": {
      feature: "features/add.cjs",
      args: [[], [null]],
      requirements: ["Adds an item under a fresh identifier and returns the number of items."],
    },
    "registry:list": {
      feature: "features/list.cjs",
      args: [[], [null]],
      requirements: ["Returns every stored item keyed by its identifier."],
      sequences: [{ description: "listing after an add exposes the new identifier",
        calls: [{ channel: "registry:list", args: [] }, { channel: "registry:add", args: [] },
          { channel: "registry:list", args: [] }] }],
    },
  },
};

export const REGISTRY_ADD_FEATURE = `"use strict";
const crypto = require("crypto");
const items = {};
module.exports = async function () {
  items[crypto.randomBytes(8).toString("hex")] = { at: Date.now() };
  return Object.keys(items).length;
};
`;

export const REGISTRY_LIST_FEATURE = `"use strict";
const items = {};
module.exports = async function () {
  return items;
};
`;

export async function registryArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-registry-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-registry", version: "1.0.0", main: "main.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), REGISTRY_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

/* A launcher package: the declared entry does not exist, the module the launcher requires exports an
   initializer instead of registering as it loads, it reaches for Electron's unpatched fs, and its
   channels answer through sendSync returnValue. Each of those is a general main-process shape a
   large application uses, and none of them is specific to this fixture. */
export const LAUNCHER_SOURCE = `"use strict";
const { app, ipcMain } = require("electron");
const fs = require("original-fs");
const path = require("path");

module.exports = function (appDir, events) {
  ipcMain.on("launcher:state", event => {
    event.returnValue = { name: app.name, directory: path.basename(appDir),
      events: typeof events.on };
  });
  ipcMain.on("launcher:write", (event, value) => {
    fs.writeFileSync(path.join(app.getPath("userData"), "state.json"), JSON.stringify({ value }));
    event.returnValue = null;
  });
};
`;

/* A main process that fails asynchronously while answering: the handler starts work it never
   awaits, and the rejection surfaces after the call has returned. */
export const ASYNC_FAILURE_SOURCE = `"use strict";
const { app, ipcMain } = require("electron");

app.whenReady().then(() => {
  ipcMain.on("job:start", event => {
    Promise.reject(new TypeError("late failure"));
    event.returnValue = "started";
  });
  ipcMain.on("job:status", event => { event.returnValue = "idle"; });
});
`;

export async function asyncFailureArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-async-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-async", version: "1.0.0", main: "main.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), ASYNC_FAILURE_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

export async function launcherArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-launcher-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  /* The declared entry is absent on purpose: a launcher package describes the launcher, not the
     payload archive it ships. */
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-launcher", version: "1.0.0", main: "index.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), LAUNCHER_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

export const ADD_FEATURE = `"use strict";
module.exports = async function (args, ctx) {
  const [name, text] = args;
  if (typeof name !== "string" || !name) throw new TypeError("name required");
  const value = String(text).trim();
  const notes = ctx.path.join(ctx.userData, "notes");
  await ctx.fs.mkdir(notes, { recursive: true });
  await ctx.fs.writeFile(ctx.path.join(notes, name + ".txt"), value);
  return { name, length: value.length };
};
`;

export const READ_FEATURE = `"use strict";
module.exports = async function (args, ctx) {
  return ctx.fs.readFile(ctx.path.join(ctx.userData, "notes", args[0] + ".txt"), "utf8");
};
`;

export const SPEC = {
  schema_version: 2,
  application: {
    name: "synthetic-notes",
    version: "9.9.9",
    scope: ["notes:add and notes:read IPC behavior", "note files under userData/notes"],
    exclusions: ["renderer layout"],
    environments: { clock: "2026-10-25T12:00:00.000Z" },
  },
  channels: {
    "notes:add": {
      feature: "features/add.cjs",
      fixtures: [],
      args: [["alpha", " hello "], ["beta", "world"], ["", "x"]],
      requirements: [
        "Trims the note text and writes userData/notes/<name>.txt with the trimmed text and no newline.",
        "Throws TypeError named TypeError with message 'name required' when name is not a nonempty string.",
        "Returns { name, length } where length is the trimmed text length.",
      ],
      sequences: [{ description: "Adding the same note twice overwrites the file",
        calls: [{ channel: "notes:add", args: ["alpha", "one"] }, { channel: "notes:add", args: ["alpha", "two"] }] }],
    },
    "notes:read": {
      feature: "features/read.cjs",
      fixtures: [{ base: "userData", path: "notes/alpha.txt", content: "hello" }],
      args: [["alpha"], ["missing"]],
      requirements: [
        "Reads userData/notes/<name>.txt as UTF-8 and returns the text.",
        "Propagates the ENOENT error (code ENOENT) when the file does not exist.",
      ],
    },
  },
};

export const CONTRACT = {
  schema_version: 1,
  channels: {
    "notes:add": { feature: "features/add.cjs", fixtures: [], args: [["alpha", " hello "], ["beta", "world"], ["", "x"]] },
    "notes:read": {
      feature: "features/read.cjs",
      fixtures: [{ base: "userData", path: "notes/alpha.txt", content: "hello" }],
      args: [["alpha"], ["missing"]],
    },
  },
};

export async function syntheticArchive() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-synthetic-"));
  const source = path.join(root, "source");
  await fsp.mkdir(source);
  await fsp.writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "synthetic-notes", version: "9.9.9", main: "main.js",
  }));
  await fsp.writeFile(path.join(source, "main.js"), APP_SOURCE);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  const extracted = path.join(root, "extracted");
  await fsp.mkdir(extracted);
  asar.extractAll(archive, extracted);
  return { root, archive, extracted };
}

export async function syntheticWorkspace() {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "splice-workspace-"));
  await fsp.mkdir(path.join(workspace, "features"), { recursive: true });
  await fsp.writeFile(path.join(workspace, "features/add.cjs"), ADD_FEATURE);
  await fsp.writeFile(path.join(workspace, "features/read.cjs"), READ_FEATURE);
  return workspace;
}
