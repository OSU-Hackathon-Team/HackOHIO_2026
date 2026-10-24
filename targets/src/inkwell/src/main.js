"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { loadVault } = require("./storage/vault");
const { buildLinkGraph } = require("./graph/backlinks");
const { rankNotes } = require("./search/fuzzy");

let vault = [];

app.whenReady().then(async () => {
  vault = await loadVault(path.join(app.getPath("documents"), "Inkwell"));
  ipcMain.handle("graph:get", () => buildLinkGraph(vault));
  ipcMain.handle("search:query", (_e, q) => rankNotes(q, vault, 20));
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadURL("data:text/html,<h1>Inkwell</h1>");
});
