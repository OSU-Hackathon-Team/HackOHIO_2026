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
