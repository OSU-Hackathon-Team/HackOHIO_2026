// Opt-in Linux distribution smoke: install a .deb and launch without a source install.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron, chromium, expect } from "@playwright/test";
import { FilesystemRecombinationService } from "../packages/backend/src/recombination/service.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-linux-package-smoke-"));
const stateDir = path.join(root, "state");
const packageDir = path.join(root, "meeting-notebook-linux-x64");
const service = new FilesystemRecombinationService(stateDir);
let desktop;
let installedPackage;
try {
  await service.seedAuthored();
  const built = await service.buildApp(await service.notebookPlan(), { signal: new AbortController().signal, stage() {}, log() {} });
  service.close();
  const packageScript = path.join(repo, "scripts", "packageRecombinationLinux.mjs");
  const packaged = spawnSync(process.execPath, ["--import", "tsx", packageScript, stateDir, built.app_id, packageDir], { cwd: repo, encoding: "utf8" });
  assert.equal(packaged.status, 0, packaged.stderr);
  const output = JSON.parse(packaged.stdout);
  assert.match(output.deb_sha256, /^[a-f0-9]{64}$/);
  assert.equal(output.app_hash, (JSON.parse(fs.readFileSync(path.join(packageDir, "splice-package.json"), "utf8"))).app_hash);
  const contents = spawnSync("dpkg-deb", ["--contents", output.deb], { encoding: "utf8" });
  assert.equal(contents.status, 0, contents.stderr);
  assert.match(contents.stdout, /-rwsr-xr-x root\/root .*chrome-sandbox/);
  assert.match(contents.stdout, /-rwxr-xr-x root\/root .*\/electron\n/);
  const previous = spawnSync("dpkg-query", ["-W", "-f=${Status}", output.package_name], { encoding: "utf8" });
  assert.notEqual(previous.stdout.trim(), "install ok installed", "package name is already installed");
  installedPackage = output.package_name;
  const install = spawnSync("sudo", ["-n", "dpkg", "-i", output.deb], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const executable = path.join("/opt", "splice", built.app_id, "electron");
  const appEnv = { ...process.env, PATH: "/nonexistent", XDG_CONFIG_HOME: path.join(root, "config") };
  desktop = await _electron.launch({ executablePath: executable, args: [], env: appEnv, timeout: 30_000 });
  const page = await desktop.firstWindow();
  await expect(page).toHaveTitle("Meeting notebook");
  await page.getByRole("button", { name: "Add cell" }).click();
  await page.getByRole("button", { name: "Add cell" }).click();
  await page.getByRole("textbox", { name: "Cell name" }).nth(0).fill("B2");
  await page.getByRole("textbox", { name: "Cell name" }).nth(1).fill("C2");
  await page.locator("table input[type=number]").nth(0).fill("3");
  await page.locator("table input[type=number]").nth(1).fill("20");
  await page.getByRole("button", { name: "Save confirmed cells" }).click();
  await page.getByRole("button", { name: "Run workflow" }).click();
  await expect.poll(async () => (await page.evaluate(() => window.splice.getDocument("meeting")))?.data.value).toBe(60);
  await desktop.close(); desktop = undefined;
  desktop = await _electron.launch({ executablePath: executable, args: [], env: appEnv, timeout: 30_000 });
  const reopened = await desktop.firstWindow();
  await expect(reopened).toHaveTitle("Meeting notebook");
  assert.equal((await reopened.evaluate(() => window.splice.getDocument("meeting"))).data.value, 60);
  assert.deepEqual((await reopened.evaluate(() => window.splice.getDocument("workbook"))).data.cells, { B2: 3, C2: 20 });
  await desktop.close(); desktop = undefined;

  const upgradeService = new FilesystemRecombinationService(stateDir);
  try {
    const refined = await upgradeService.notebookPlan();
    refined.ui[0].title = "Refined meeting notebook";
    const upgraded = await upgradeService.buildApp(refined, { signal: new AbortController().signal, stage() {}, log() {} });
    assert.equal(upgraded.revision, 1);
  } finally { upgradeService.close(); }
  const upgradeDir = path.join(root, "meeting-notebook-linux-x64-revision-1");
  const upgradePackage = spawnSync(process.execPath, ["--import", "tsx", packageScript, stateDir, built.app_id, upgradeDir], { cwd: repo, encoding: "utf8" });
  assert.equal(upgradePackage.status, 0, upgradePackage.stderr);
  const upgradeOutput = JSON.parse(upgradePackage.stdout);
  assert.equal(upgradeOutput.package_name, installedPackage);
  const upgradeInstall = spawnSync("sudo", ["-n", "dpkg", "-i", upgradeOutput.deb], { encoding: "utf8" });
  assert.equal(upgradeInstall.status, 0, upgradeInstall.stderr || upgradeInstall.stdout);
  desktop = await _electron.launch({ executablePath: executable, args: [], env: appEnv, timeout: 30_000 });
  const upgradedPage = await desktop.firstWindow();
  await expect(upgradedPage.getByRole("heading", { name: "Refined meeting notebook" })).toBeVisible();
  assert.equal((await upgradedPage.evaluate(() => window.splice.getDocument("meeting"))).data.value, 60);
  assert.deepEqual((await upgradedPage.evaluate(() => window.splice.getDocument("workbook"))).data.cells, { B2: 3, C2: 20 });
  await upgradedPage.getByRole("spinbutton", { name: "Value for B2" }).fill("4");
  await upgradedPage.getByRole("button", { name: "Save confirmed cells" }).click();
  await upgradedPage.getByRole("button", { name: "Run workflow" }).click();
  await expect.poll(async () => (await upgradedPage.evaluate(() => window.splice.getDocument("meeting")))?.data.value).toBe(80);
  await desktop.close(); desktop = undefined;
  desktop = await _electron.launch({ executablePath: executable, args: [], env: appEnv, timeout: 30_000 });
  const finalPage = await desktop.firstWindow();
  await expect(finalPage.getByRole("heading", { name: "Refined meeting notebook" })).toBeVisible();
  assert.equal((await finalPage.evaluate(() => window.splice.getDocument("meeting"))).data.value, 80);
  assert.deepEqual((await finalPage.evaluate(() => window.splice.getDocument("workbook"))).data.cells, { B2: 4, C2: 20 });
  await desktop.close(); desktop = undefined;
  if (process.env.SPLICE_TEST_CLEAN_CONTAINER === "1") {
    const probe = spawnSync("sudo", ["-n", "docker", "run", "-d", "--privileged", "--shm-size=1g", "-p", "127.0.0.1::9222",
      "-v", `${upgradeOutput.deb}:/tmp/app.deb:ro`,
      "-v", `${path.join(repo, "scripts", "cleanRecombinationLinuxPackageProbe.sh")}:/tmp/probe.sh:ro`,
      "-e", `SPLICE_PACKAGE_NAME=${installedPackage}`,
      "debian:bookworm-slim", "/bin/sh", "/tmp/probe.sh"], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    const containerId = probe.stdout.trim();
    let browser;
    try {
      const published = spawnSync("sudo", ["-n", "docker", "port", containerId, "9222"], { encoding: "utf8" });
      assert.equal(published.status, 0, published.stderr);
      const port = /127\.0\.0\.1:(\d+)/.exec(published.stdout)?.[1];
      assert.ok(port, `No loopback debug port: ${published.stdout}`);
      const endpoint = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 120_000;
      while (!browser && Date.now() < deadline) {
        try { browser = await chromium.connectOverCDP(endpoint, { timeout: 2_000 }); }
        catch { await new Promise((resolve) => setTimeout(resolve, 1_000)); }
      }
      assert.ok(browser, "Clean container did not expose the installed app");
      const context = browser.contexts()[0];
      const cleanPage = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15_000 });
      await expect(cleanPage).toHaveTitle("Meeting notebook");
      await cleanPage.getByRole("button", { name: "Add cell" }).click();
      await cleanPage.getByRole("button", { name: "Add cell" }).click();
      await cleanPage.getByRole("textbox", { name: "Cell name" }).nth(0).fill("B2");
      await cleanPage.getByRole("textbox", { name: "Cell name" }).nth(1).fill("C2");
      await cleanPage.locator("table input[type=number]").nth(0).fill("3");
      await cleanPage.locator("table input[type=number]").nth(1).fill("20");
      await cleanPage.getByRole("button", { name: "Save confirmed cells" }).click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("workbook"))).data.cells).toEqual({ B2: 3, C2: 20 });
      await cleanPage.getByRole("button", { name: "Run workflow" }).click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("meeting"))).data.value).toBe(60);
      await cleanPage.getByRole("spinbutton", { name: "Value for B2" }).fill("4");
      await cleanPage.getByRole("button", { name: "Save confirmed cells" }).click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("workbook"))).data.cells.B2).toBe(4);
      await cleanPage.getByRole("button", { name: "Run workflow" }).click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("meeting"))).data.value).toBe(80);
      console.log("Fresh Debian container ran installed workbook, formula and note workflow from 60 to 80 without Node or a repo checkout.");
    } catch (error) {
      const logs = spawnSync("sudo", ["-n", "docker", "logs", "--tail", "80", containerId], { encoding: "utf8" });
      console.error(logs.stderr || logs.stdout);
      throw error;
    } finally {
      await browser?.close();
      spawnSync("sudo", ["-n", "docker", "rm", "-f", containerId], { encoding: "utf8" });
    }
  }
  console.log(`Installed Linux package ran without npm install or Splice server; UI upgrade and restart preserved workbook and note (${upgradeOutput.deb_sha256}).`);
} finally {
  await desktop?.close();
  if (installedPackage) {
    const removed = spawnSync("sudo", ["-n", "dpkg", "-r", installedPackage], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  }
  try { service.close(); } catch { /* closed after build */ }
  if (process.env.SPLICE_KEEP_PACKAGE_SMOKE) console.error(`Package smoke files: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}
