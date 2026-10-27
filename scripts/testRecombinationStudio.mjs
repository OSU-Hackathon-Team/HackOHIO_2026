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
const service = new FilesystemRecombinationService(root);
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
  browser = await chromium.launch({ headless: true });
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
  console.log("Built Studio created the notebook, reattached after reload, previewed and exported it, then built revision 1 and restored revision 0 across reload.");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  service.close();
  fs.rmSync(root, { recursive: true, force: true });
}
