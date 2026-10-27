// Opt-in Linux distribution smoke: install a .deb and launch without a source install.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron, chromium, expect } from "@playwright/test";
import { hashJson } from "../packages/backend/src/capabilities/identity.ts";
import { FilesystemRecombinationService } from "../packages/backend/src/recombination/service.ts";
import { benchmarkInstalledNotebook } from "./benchmarkInstalledRecombination.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "splice-linux-package-smoke-"));
const stateDir = path.join(root, "state");
const packageDir = path.join(root, "meeting-notebook-linux-x64");
const service = new FilesystemRecombinationService(stateDir);
let desktop;
let installedPackage;
const float = { kind: "float", bits: 64 };
const numberPair = { kind: "object", additional: false, fields: [
  { name: "a", type: float, optional: false },
  { name: "b", type: float, optional: false },
] };
const product = { kind: "object", additional: false, fields: [{ name: "product", type: float, optional: false }] };
const nativeArtifact = { kind: "authored_development", id: "linux_package_native_multiply", version: 1 };
const nativeDefinition = {
  schema_version: 1,
  id: "splice.test.linux_package_native_multiply",
  version: "1.0.0",
  title: "Native multiply packaging fixture",
  description: "Authored C fixture for checking an installed native sidecar.",
  origin: { kind: "authored", artifact_hash: hashJson(nativeArtifact), artifact_ref: "authored_development/linux_package_native_multiply@1", source_app: "Splice authored development fixture", stage: "downstream_authored" },
  selected_behavior: ["Multiply two finite double precision values"],
  exclusions: ["No source application parity claim"],
  operations: [{ name: "multiply", summary: "Multiply two values.", request: numberPair, result: product,
    error: { kind: "object", additional: false, fields: [
      { name: "code", type: { kind: "enum", values: ["internal"] }, optional: false },
      { name: "message", type: { kind: "string", encoding: "utf-8", max_bytes: 120 }, optional: false },
    ] }, idempotent: true, cancellable: false, timeout_ms: 2_000, streaming: null, host_effects: [] }],
  provides: [], requires: [], state: { ownership: "package", durable: false, schema: null, migrations: [] },
  lifecycle: { start_operation: null, dispose_operation: null, restart_policy: "on_crash" },
  host_effects: [], assumptions: ["Linux x64", "gcc"], preferred_runtime: "native_sidecar",
  public_tests: [{ name: "multiplication", requirement_ids: ["NATIVE-PACKAGE-1"], kind: "public" }],
};
const nativeIntake = {
  definition: nativeDefinition, origin_artifact: nativeArtifact, review_attestation: null,
  implementation: { kind: "c", entry: "candidate.c", files: [{ path: "candidate.c", encoding: "utf8", content: "int splice_multiply(double a, double b, double *product) { *product = a * b; return 0; }\n" }], compiler: { name: "gcc", flags: [] } },
  public_tests: [{ name: "multiplication", requirement_ids: ["NATIVE-PACKAGE-1"], harness: "c", code: JSON.stringify([
    { op: "multiply", args: { a: 3, b: 20 }, expect: { product: 60 } },
    { op: "multiply", args: { a: 4, b: 20 }, expect: { product: 80 } },
  ]) }], independent_verdict: null,
};
try {
  await service.seedAuthored();
  const job = { signal: new AbortController().signal, stage() {}, log() {} };
  const nativeRecord = await service.intake(nativeIntake);
  assert.equal(nativeRecord.accepted, true, JSON.stringify(nativeRecord.blockers));
  const nativePackage = await service.buildCapability(nativeRecord.intake_id, job);
  let storedNative = await service.getPackage(nativePackage.package_id);
  assert.ok(storedNative);
  const nativePath = path.join(service.registry.artifactRoot(storedNative), "bin", "sidecar");
  assert.ok(fs.statSync(nativePath).mode & 0o100,
    "The verified native sidecar must be executable in the registry");
  fs.chmodSync(nativePath, 0o600); // Simulate a package stored before executable modes were preserved.
  storedNative = await service.getPackage(nativePackage.package_id);
  assert.ok(storedNative);
  assert.ok(fs.statSync(nativePath).mode & 0o100, "Verified legacy sidecar must regain execute permission");
  const plan = await service.notebookPlan();
  plan.instances.push({ instance: "native", package_id: nativePackage.package_id, definition_hash: hashJson(nativeDefinition), config: {}, permissions: [] });
  plan.workflows.push({ id: "native_multiply", name: "Native multiply", trigger: "user", input: numberPair, output: product,
    steps: [{ id: "multiply", operation: { instance: "native", port: "multiply" }, input: [
      { from: "$input.a", to: "a", transform: "identity", factor: null },
      { from: "$input.b", to: "b", transform: "identity", factor: null },
    ], depends_on: [], timeout_ms: 2_000, retries: 0, retry_on_codes: [], idempotency: "none", on_error: "fail", cancellation: "propagate", stale_guard: null, writes: [] }] });
  plan.acceptance_scenarios.push({ id: "native_multiply", name: "Native sidecar multiplies in the composition", steps: [
    { kind: "invoke", workflow: "native_multiply", input: { a: 3, b: 20 }, expect_status: "succeeded" },
  ] });
  plan.notes.push("The native multiplication capability is an authored packaging fixture, not recovered application behavior.");
  const built = await service.buildApp(plan, job);
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
  assert.match(contents.stdout, /-rwxr-xr-x root\/root .*\/resources\/app\/packages\/native\/bin\/sidecar\n/);
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
  const nativeResult = await page.evaluate(() => window.splice.runWorkflow("native_multiply", { a: 3, b: 20 }));
  assert.equal(nativeResult.status, "succeeded", JSON.stringify(nativeResult.errors));
  assert.equal(nativeResult.step_results.multiply.product, 60);
  await page.getByRole("button", { name: "Add cell" }).click();
  await page.getByRole("button", { name: "Add cell" }).click();
  await page.getByRole("textbox", { name: "Cell name" }).nth(0).fill("B2");
  await page.getByRole("textbox", { name: "Cell name" }).nth(1).fill("C2");
  await page.locator("table input[type=number]").nth(0).fill("3");
  await page.locator("table input[type=number]").nth(1).fill("20");
  await page.getByRole("button", { name: "Save confirmed cells" }).click();
  await page.getByRole("button", { name: "Run workflow" }).first().click();
  await expect.poll(async () => (await page.evaluate(() => window.splice.getDocument("meeting")))?.data.value).toBe(60);
  await expect(page.getByRole("button", { name: "Run workflow" }).first()).toBeEnabled();
  await desktop.close(); desktop = undefined;
  desktop = await _electron.launch({ executablePath: executable, args: [], env: appEnv, timeout: 30_000 });
  const reopened = await desktop.firstWindow();
  await expect(reopened).toHaveTitle("Meeting notebook");
  assert.equal((await reopened.evaluate(() => window.splice.getDocument("meeting"))).data.value, 60);
  assert.deepEqual((await reopened.evaluate(() => window.splice.getDocument("workbook"))).data.cells, { B2: 3, C2: 20 });
  await desktop.close(); desktop = undefined;

  const upgradeService = new FilesystemRecombinationService(stateDir);
  try {
    const refined = structuredClone(plan);
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
  await upgradedPage.getByRole("button", { name: "Run workflow" }).first().click();
  await expect.poll(async () => (await upgradedPage.evaluate(() => window.splice.getDocument("meeting")))?.data.value).toBe(80);
  await expect(upgradedPage.getByRole("button", { name: "Run workflow" }).first()).toBeEnabled();
  await desktop.close(); desktop = undefined;
  desktop = await _electron.launch({ executablePath: executable, args: [], env: appEnv, timeout: 30_000 });
  const finalPage = await desktop.firstWindow();
  await expect(finalPage.getByRole("heading", { name: "Refined meeting notebook" })).toBeVisible();
  assert.equal((await finalPage.evaluate(() => window.splice.getDocument("meeting"))).data.value, 80);
  assert.deepEqual((await finalPage.evaluate(() => window.splice.getDocument("workbook"))).data.cells, { B2: 4, C2: 20 });
  const upgradedNativeResult = await finalPage.evaluate(() => window.splice.runWorkflow("native_multiply", { a: 4, b: 20 }));
  assert.equal(upgradedNativeResult.status, "succeeded", JSON.stringify(upgradedNativeResult.errors));
  assert.equal(upgradedNativeResult.step_results.multiply.product, 80);
  if (process.env.SPLICE_TEST_PACKAGED_PERFORMANCE === "1") {
    const electronPid = desktop.process().pid;
    assert.ok(electronPid, "installed Electron process has no PID");
    await benchmarkInstalledNotebook(finalPage, electronPid);
  }
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
      const cleanNativeResult = await cleanPage.evaluate(() => window.splice.runWorkflow("native_multiply", { a: 3, b: 20 }));
      assert.equal(cleanNativeResult.status, "succeeded", JSON.stringify(cleanNativeResult.errors));
      assert.equal(cleanNativeResult.step_results.multiply.product, 60);
      await cleanPage.getByRole("button", { name: "Add cell" }).click();
      await cleanPage.getByRole("button", { name: "Add cell" }).click();
      await cleanPage.getByRole("textbox", { name: "Cell name" }).nth(0).fill("B2");
      await cleanPage.getByRole("textbox", { name: "Cell name" }).nth(1).fill("C2");
      await cleanPage.locator("table input[type=number]").nth(0).fill("3");
      await cleanPage.locator("table input[type=number]").nth(1).fill("20");
      await cleanPage.getByRole("button", { name: "Save confirmed cells" }).click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("workbook"))).data.cells).toEqual({ B2: 3, C2: 20 });
      await cleanPage.getByRole("button", { name: "Run workflow" }).first().click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("meeting"))).data.value).toBe(60);
      await expect(cleanPage.getByRole("button", { name: "Run workflow" }).first()).toBeEnabled();
      await cleanPage.getByRole("spinbutton", { name: "Value for B2" }).fill("4");
      await cleanPage.getByRole("button", { name: "Save confirmed cells" }).click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("workbook"))).data.cells.B2).toBe(4);
      await cleanPage.getByRole("button", { name: "Run workflow" }).first().click();
      await expect.poll(async () => (await cleanPage.evaluate(() => window.splice.getDocument("meeting"))).data.value).toBe(80);
      await expect(cleanPage.getByRole("button", { name: "Run workflow" }).first()).toBeEnabled();
      const cleanNative80 = await cleanPage.evaluate(() => window.splice.runWorkflow("native_multiply", { a: 4, b: 20 }));
      assert.equal(cleanNative80.status, "succeeded", JSON.stringify(cleanNative80.errors));
      assert.equal(cleanNative80.step_results.multiply.product, 80);
      console.log("Fresh Debian container ran installed workbook, formula, note and native sidecar workflows from 60 to 80 without Node or a repo checkout.");
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
