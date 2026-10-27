// Opt-in packaged source smoke for two distinct authored recipes and their persisted documents.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";
import { FilesystemRecombinationService } from "../packages/backend/src/recombination/service.ts";
import { budgetBoardPlan } from "../packages/backend/src/example/budget.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary = path.join(repo, "node_modules", "electron", "dist", "electron");
if (!fs.existsSync(binary)) throw new Error("Electron 45 is not installed; run npm ci with the scratch-backed node_modules mount");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-electron-export-test-"));
const stateDir = path.join(root, "builder-state");
const appDir = path.join(root, "app");
const configDir = path.join(root, "config");
const liveTranscriptionWav = process.env.SPLICE_TEST_EXPORTED_TRANSCRIPTION_WAV;
fs.mkdirSync(appDir, { recursive: true });
const service = new FilesystemRecombinationService(stateDir);
async function writeExport(appId, directory) {
  const exported = await service.exportApp(appId);
  for (const file of exported.files) {
    if (file.content === null) throw new Error(`Export omitted ${file.path}`);
    const target = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
    if (file.path.endsWith("/bin/sidecar")) fs.chmodSync(target, 0o755);
  }
}
try {
  await service.seedAuthored();
  const plan = await service.notebookPlan();
  const built = await service.buildApp(plan, { signal: new AbortController().signal, stage() {}, log() {} });
  await writeExport(built.app_id, appDir);

  const options = { executablePath: binary, args: [appDir], env: { ...process.env, XDG_CONFIG_HOME: configDir, ...(liveTranscriptionWav ? { SPLICE_TRANSCRIPTION_PROVIDER: "aws" } : {}) }, timeout: 30_000 };
  let desktop = await _electron.launch(options);
  try {
    const page = await desktop.firstWindow();
    await expect(page).toHaveTitle("Meeting notebook");
    await page.getByRole("button", { name: "Run workflow" }).click();
    await page.waitForFunction(() => document.querySelector("pre")?.textContent?.includes('"status": "succeeded"'));
    assert.equal((await page.evaluate(() => window.splice.getDocument("meeting"))).data.value, 60);
    const input = JSON.parse(await page.locator("textarea").inputValue());
    input.cells.B2 = 4;
    await page.locator("textarea").fill(JSON.stringify(input));
    await page.getByRole("button", { name: "Run workflow" }).click();
    await page.waitForFunction(() => document.querySelector("pre")?.textContent?.includes('"value": 80'));
    assert.equal((await page.evaluate(() => window.splice.getDocument("meeting"))).data.value, 80);
    if (liveTranscriptionWav) {
      await page.getByLabel("Audio WAV file").setInputFiles(liveTranscriptionWav);
      await page.getByRole("button", { name: "Transcribe WAV" }).click();
      await expect.poll(async () => (await page.evaluate(() => window.splice.listTranscriptions()))[0]?.status, { timeout: 90_000 }).toBe("succeeded");
      const sessions = await page.evaluate(() => window.splice.listTranscriptions());
      assert.ok(sessions[0].segments.length > 0, "live provider must yield a final transcript");
      const transcript = (await page.evaluate(() => window.splice.getDocument("meeting"))).data.transcript;
      assert.equal(transcript[0].text, sessions[0].segments[0].text);
      await expect(page.getByText(/Transcription succeeded/)).toBeVisible();
      const workflowInput = JSON.parse(await page.getByRole("textbox", { name: "Update meeting notebook input JSON" }).inputValue());
      assert.equal(workflowInput.segments[0].text, transcript[0].text);
    }
  } finally {
    await desktop.close();
  }

  desktop = await _electron.launch(options);
  try {
    const page = await desktop.firstWindow();
    await page.getByRole("button", { name: "Run workflow" }).waitFor();
    const saved = await page.evaluate(() => window.splice.getDocument("meeting"));
    assert.equal(saved.data.value, 80);
    if (liveTranscriptionWav) assert.ok(saved.data.transcript.length > 0, "transcript survives exported app restart");
    assert.ok(saved.revision >= 2);
    console.log(`Electron export launched; revision ${saved.revision} and value 80 survived restart.`);
  } finally {
    await desktop.close();
  }

  const formulaPackage = plan.instances.find((instance) => instance.instance === "formula")?.package_id;
  const reportPackage = (await service.listCapabilities()).packages.find((pkg) => pkg.definition.id === "splice.example.budget_report")?.package_id;
  if (!formulaPackage) throw new Error("Notebook plan is missing its formula package");
  if (!reportPackage) throw new Error("Budget report fixture is missing");
  const budgetPlan = budgetBoardPlan(plan, formulaPackage, reportPackage);
  const budgetBuilt = await service.buildApp(budgetPlan, { signal: new AbortController().signal, stage() {}, log() {} });
  const budgetDir = path.join(root, "budget-app");
  await writeExport(budgetBuilt.app_id, budgetDir);
  const budgetOptions = { executablePath: binary, args: [budgetDir], env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "budget-config") }, timeout: 30_000 };
  desktop = await _electron.launch(budgetOptions);
  try {
    const page = await desktop.firstWindow();
    await expect(page).toHaveTitle("Budget board");
    await page.getByRole("button", { name: "Run workflow" }).click();
    await page.waitForFunction(() => document.querySelector("pre")?.textContent?.includes('"status": "succeeded"'));
    assert.equal((await page.evaluate(() => window.splice.getDocument("budget"))).data.total, 60);
    assert.equal((await page.evaluate(() => window.splice.getDocument("budget"))).data.html, "<p>Operating budget: <strong>60.00</strong></p>");
    const input = JSON.parse(await page.locator("textarea").inputValue());
    input.cells.A1 = 9;
    await page.locator("textarea").fill(JSON.stringify(input));
    await page.getByRole("button", { name: "Run workflow" }).click();
    await page.waitForFunction(() => document.querySelector("pre")?.textContent?.includes('"value": 108'));
    assert.equal((await page.evaluate(() => window.splice.getDocument("budget"))).data.total, 108);
    assert.equal((await page.evaluate(() => window.splice.getDocument("budget"))).data.html, "<p>Operating budget: <strong>108.00</strong></p>");
  } finally {
    await desktop.close();
  }
  desktop = await _electron.launch(budgetOptions);
  try {
    const page = await desktop.firstWindow();
    await page.getByRole("button", { name: "Run workflow" }).waitFor();
    const saved = await page.evaluate(() => window.splice.getDocument("budget"));
    assert.equal(saved.data.total, 108);
    assert.equal(saved.data.html, "<p>Operating budget: <strong>108.00</strong></p>");
    console.log(`Budget board Electron export launched; revision ${saved.revision}, total 108 and report survived restart.`);
  } finally {
    await desktop.close();
  }
} finally {
  service.close();
  fs.rmSync(root, { recursive: true, force: true });
}
