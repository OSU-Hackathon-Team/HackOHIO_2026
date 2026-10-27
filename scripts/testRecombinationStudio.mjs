// Opt-in browser smoke for the real recombination route, service and built Studio view.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium, expect } from "@playwright/test";
import { FilesystemRecombinationService } from "../packages/backend/src/recombination/service.ts";
import { JobManager } from "../packages/backend/src/recombination/jobs.ts";
import { createRecombinationRouter } from "../packages/backend/src/routes/recombination.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(repo, "packages/frontend/dist");
if (!fs.existsSync(path.join(frontend, "index.html"))) throw new Error("Build the frontend before running the Studio smoke");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-recombination-studio-"));
const smokeToken = "studio-transcription-smoke-key-0123456789";
const previousProvider = process.env.SPLICE_TRANSCRIPTION_PROVIDER;
const previousToken = process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN;
process.env.SPLICE_TRANSCRIPTION_PROVIDER = "aws";
process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN = smokeToken;
let releaseProvider = () => {};
const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
const service = new FilesystemRecombinationService(root, { transcriptionProvider: () => ({
  id: "aws_transcribe_streaming",
  async *transcribe(input) {
    assert.ok(input.audio.size > 0);
    yield { index: 0, startMs: 0, endMs: 400, text: "Budget", final: false };
    await providerGate;
    yield { index: 0, startMs: 0, endMs: 400, text: "Budget line", final: true };
  },
}) });
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(createRecombinationRouter(service, new JobManager(root)));
app.all("/api/*", (_request, response) => response.status(404).json({ error: "Unknown API route" }));
app.use(express.static(frontend));
app.get("*", (_request, response) => response.sendFile(path.join(frontend, "index.html")));

let server;
let browser;
try {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Studio smoke server has no TCP address");
  browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const openRecombine = () => page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "Recombine" }).click();
  await openRecombine();
  await expect(page.getByRole("heading", { name: "Recombine capabilities" })).toBeVisible();
  await page.getByRole("button", { name: "Install notebook example" }).click();
  await expect(page.getByText("splice.example.formula", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Load notebook plan" }).click();
  await expect(page.getByRole("textbox", { name: "Composition plan JSON" })).toHaveValue(/update_notebook/);
  await page.getByRole("button", { name: "Build application" }).click();
  await expect(page.getByText(/Build job: (queued|running|succeeded)/)).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await openRecombine();
  await expect(page.getByText("Build job: succeeded")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Meeting notebook · revision 0 · verified")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Record microphone" }).click();
  await expect(page.getByRole("status")).toContainText("Recording microphone", { timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByRole("status")).toContainText("ready for transcription", { timeout: 10_000 });
  await expect(page.getByText(/Selected audio: meeting-\d+\.wav/)).toBeVisible();
  await page.getByLabel("Transcription access key").fill(smokeToken);
  await page.route("**/api/recombination/transcription/jobs/*/events", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Transcribe WAV" }).click();
  await expect(page.getByText(/Saved transcription: tr_/)).toBeVisible({ timeout: 10_000 });
  const sessionId = await page.evaluate(() => localStorage.getItem("splice.recombination.activeTranscriptionSession"));
  assert.match(sessionId, /^tr_[a-f0-9]{32}$/);
  await page.unroute("**/api/recombination/transcription/jobs/*/events");
  await page.reload();
  await openRecombine();
  await page.getByRole("button", { name: "Meeting notebook · revision 0" }).click();
  await page.getByLabel("Transcription access key").fill(smokeToken);
  await page.getByRole("button", { name: "Reconnect saved transcription" }).click();
  releaseProvider();
  await expect(page.getByRole("status")).toContainText("final segment(s) added", { timeout: 10_000 });
  const transcribedInput = JSON.parse(await page.getByRole("textbox", { name: "Workflow input JSON" }).inputValue());
  assert.equal(transcribedInput.segments[0].text, "Budget line");
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
  });
  await page.getByRole("button", { name: "Record microphone" }).click();
  await expect(page.getByText("Microphone permission was denied. Allow microphone access in the browser and try again.")).toBeVisible();
  await page.getByRole("button", { name: "Run preview" }).click();
  const preview = page.locator("pre").filter({ hasText: '"documents"' });
  await expect(preview).toContainText('"value": 60', { timeout: 20_000 });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download Electron source" }).click(),
  ]);
  assert.match(download.suggestedFilename(), /\.zip$/);

  const planBox = page.getByRole("textbox", { name: "Composition plan JSON" });
  const refined = JSON.parse(await planBox.inputValue());
  refined.app.description += " Browser refinement.";
  await planBox.fill(JSON.stringify(refined, null, 2));
  await page.getByRole("button", { name: "Build application" }).click();
  await expect(page.getByText("Meeting notebook · revision 1 · verified · active")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("combobox", { name: "Application revision" }).selectOption("0");
  await expect(page.getByText("Meeting notebook · revision 0 · verified")).toBeVisible();
  await page.getByRole("button", { name: "Activate revision" }).click();
  await expect(page.getByText("Meeting notebook · revision 0 · verified · active")).toBeVisible();
  await page.reload();
  await openRecombine();
  await page.getByRole("button", { name: "Meeting notebook · revision 0" }).click();
  await expect(page.getByText("Meeting notebook · revision 0 · verified · active")).toBeVisible();
  assert.deepEqual(pageErrors, []);
  console.log("Built Studio captured audio, reattached a durable transcription after reload, previewed and exported the notebook, then restored revision 0 across reload.");
} finally {
  releaseProvider();
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  service.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousProvider === undefined) delete process.env.SPLICE_TRANSCRIPTION_PROVIDER;
  else process.env.SPLICE_TRANSCRIPTION_PROVIDER = previousProvider;
  if (previousToken === undefined) delete process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN;
  else process.env.SPLICE_TRANSCRIPTION_ACCESS_TOKEN = previousToken;
}
