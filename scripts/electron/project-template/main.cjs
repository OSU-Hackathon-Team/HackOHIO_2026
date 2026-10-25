const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");
const manifest = require("./reconstruction.json");

const functions = new Map();
for (const feature of manifest.features) {
  const engine = require(path.join(__dirname, feature.module));
  for (const entry of feature.functions) {
    if (typeof engine[entry.name] !== "function") throw new Error(`Missing generated function ${entry.name}`);
    functions.set(`${feature.id}:${entry.name}`, engine[entry.name]);
  }
}

app.whenReady().then(() => {
  ipcMain.handle("workbench:manifest", () => manifest);
  ipcMain.handle("workbench:invoke", (_event, featureId, functionName, args) => {
    if (!Array.isArray(args)) throw new TypeError("Arguments must be a JSON array");
    const fn = functions.get(`${featureId}:${functionName}`);
    if (!fn) throw new Error("Unknown verified function");
    return fn(...args);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  const win = new BrowserWindow({
    width: 980, height: 720,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
