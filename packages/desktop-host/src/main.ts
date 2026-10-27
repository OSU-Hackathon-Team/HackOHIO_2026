import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilityClient } from "@splice/runtime";
import type { ApplicationPlanManifest } from "./manifest.js";
import { openStateStore } from "../../backend/src/state/store.js";
import { WorkflowEngine } from "../../backend/src/composition/workflows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let store: ReturnType<typeof openStateStore> | null = null;
let engine: WorkflowEngine | null = null;
let manifest: ApplicationPlanManifest | null = null;
const clients: Array<{ dispose(): Promise<void> }> = [];

function assertReady(): asserts manifest is ApplicationPlanManifest {
  if (!manifest || !engine || !store) throw new Error("Application runtime is not ready");
}

async function loadManifest(): Promise<ApplicationPlanManifest> {
  const parsed = JSON.parse(await fs.readFile(path.join(app.getAppPath(), "splice.plan.json"), "utf8")) as ApplicationPlanManifest;
  if (parsed.schema_version !== 1 || !parsed.plan || !Array.isArray(parsed.packages)) throw new Error("Invalid Splice application plan manifest");
  return parsed;
}

async function startRuntime(): Promise<void> {
  manifest = await loadManifest();
  const definitions = new Map<string, ApplicationPlanManifest["packages"][number]["definition"]>();
  const runtimeClients = new Map();
  for (const entry of manifest.packages) {
    const artifactRoot = path.join(app.getAppPath(), "packages", entry.instance);
    const client = await createCapabilityClient(entry.package, {
      definition: entry.definition,
      artifactRoot,
      grantedEffects: entry.permissions,
    });
    definitions.set(entry.instance, entry.definition);
    runtimeClients.set(entry.instance, client);
    clients.push(client);
  }
  const userData = app.getPath("userData");
  store = openStateStore(path.join(userData, "splice-state"));
  engine = new WorkflowEngine(store, definitions, runtimeClients);
  ipcMain.handle("splice:workflows", () => {
    assertReady();
    return manifest.plan.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, input: workflow.input }));
  });
  ipcMain.handle("splice:run", async (_event, workflowId: unknown, input: unknown) => {
    assertReady();
    if (typeof workflowId !== "string" || !manifest.plan.workflows.some((workflow) => workflow.id === workflowId)) throw new Error("Workflow is not declared in this application");
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Workflow input must be an object");
    return engine.run(manifest.plan, workflowId, input as Record<string, unknown>);
  });
  ipcMain.handle("splice:document", (_event, documentId: unknown) => {
    assertReady();
    if (typeof documentId !== "string" || !manifest.plan.documents.some((document) => document.id === documentId)) throw new Error("Document is not declared in this application");
    return store.getDocument(documentId);
  });
}

async function openWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(app.getAppPath(), "renderer", "index.html"));
  window.on("closed", () => { window = null; });
}

app.whenReady().then(async () => {
  await startRuntime();
  await openWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void openWindow(); });
}).catch((error) => {
  console.error("Splice application startup failed:", error);
  app.quit();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", async () => {
  await Promise.allSettled(clients.map((client) => client.dispose()));
  store?.close();
});
