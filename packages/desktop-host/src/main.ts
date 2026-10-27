import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilityClient } from "@splice/runtime";
import { encodeWireValue } from "@splice/contracts";
import type { ApplicationPlanManifest } from "./manifest.js";
import { openStateStore } from "../../backend/src/state/store.js";
import { WorkflowEngine } from "../../backend/src/composition/workflows.js";
import { DesktopTranscription } from "./transcription.js";
import { initializeDocuments } from "../../backend/src/composition/documentMigrations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | null = null;
let store: ReturnType<typeof openStateStore> | null = null;
let engine: WorkflowEngine | null = null;
let manifest: ApplicationPlanManifest | null = null;
let transcription: DesktopTranscription | null = null;
const clients: Array<{ dispose(): Promise<void> }> = [];

function ready() {
  if (!manifest || !engine || !store || !transcription) throw new Error("Application runtime is not ready");
  return { manifest, engine, store, transcription };
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
  initializeDocuments(store, manifest.plan);
  engine = new WorkflowEngine(store, definitions, runtimeClients);
  transcription = new DesktopTranscription(store, manifest.app_id, manifest.plan, path.join(userData, "splice-audio"), (session) => {
    window?.webContents.send("splice:transcription-event", session);
  });
  ipcMain.handle("splice:workflows", () => {
    const runtime = ready();
    return runtime.manifest.plan.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, input: workflow.input }));
  });
  ipcMain.handle("splice:run", async (_event, workflowId: unknown, input: unknown) => {
    const runtime = ready();
    if (typeof workflowId !== "string" || !runtime.manifest.plan.workflows.some((workflow) => workflow.id === workflowId)) throw new Error("Workflow is not declared in this application");
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Workflow input must be an object");
    return runtime.engine.run(runtime.manifest.plan, workflowId, input as Record<string, unknown>);
  });
  ipcMain.handle("splice:document", (_event, documentId: unknown) => {
    const runtime = ready();
    if (typeof documentId !== "string" || !runtime.manifest.plan.documents.some((document) => document.id === documentId)) throw new Error("Document is not declared in this application");
    return runtime.store.getDocument(documentId);
  });
  ipcMain.handle("splice:document-save", (event, documentId: unknown, value: unknown, expectedRevision: unknown) => {
    if (event.sender !== window?.webContents) throw new Error("Unexpected document caller");
    const runtime = ready();
    const definition = runtime.manifest.plan.documents.find((document) => document.id === documentId);
    if (!definition || definition.owner_instance !== null) throw new Error("Document is not editable in this application");
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1)) throw new Error("Expected document revision is invalid");
    const encoded = encodeWireValue(definition.schema, value);
    return runtime.store.putDocument(definition.id, encoded, expectedRevision as number | null);
  });
  ipcMain.handle("splice:transcription-availability", (event) => {
    if (event.sender !== window?.webContents) throw new Error("Unexpected transcription caller");
    return ready().transcription.availability();
  });
  ipcMain.handle("splice:transcriptions", (event) => {
    if (event.sender !== window?.webContents) throw new Error("Unexpected transcription caller");
    return ready().transcription.list();
  });
  ipcMain.handle("splice:transcription", (event, sessionId: unknown) => {
    if (event.sender !== window?.webContents) throw new Error("Unexpected transcription caller");
    if (typeof sessionId !== "string") throw new Error("Transcription ID must be a string");
    return ready().transcription.get(sessionId);
  });
  ipcMain.handle("splice:transcription-start", async (event, bytes: unknown, providerId: unknown, language: unknown) => {
    if (event.sender !== window?.webContents) throw new Error("Unexpected transcription caller");
    if (!(bytes instanceof Uint8Array) || typeof providerId !== "string" || typeof language !== "string") throw new Error("Invalid transcription request");
    return ready().transcription.startWav(bytes, providerId, language);
  });
  ipcMain.handle("splice:transcription-cancel", async (event, sessionId: unknown) => {
    if (event.sender !== window?.webContents) throw new Error("Unexpected transcription caller");
    if (typeof sessionId !== "string") throw new Error("Transcription ID must be a string");
    return ready().transcription.cancel(sessionId);
  });
  transcription.resume();
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
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    await transcription?.shutdown();
    await Promise.allSettled(clients.map((client) => client.dispose()));
    store?.close();
    app.quit();
  })();
});
