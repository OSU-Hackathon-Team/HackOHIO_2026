import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SynthesisBundle } from "@splice/contracts";
import { createElectronProject } from "../src/lib/electronProject.js";

const bundle = JSON.parse(readFileSync(new URL("../../../fixtures/bundles/_seed/study-room.json", import.meta.url), "utf8")) as SynthesisBundle;

test("exports a runnable Electron project with the checked engines unchanged", () => {
  const project = createElectronProject(bundle, "Study Room");
  const pkg = JSON.parse(project.files["package.json"]);
  assert.equal(project.filename, "study-room-electron-rev0.zip");
  assert.equal(pkg.main, "electron/main.cjs");
  assert.equal(pkg.scripts.start, "npm run build && electron .");
  for (const path of bundle.engine_paths) {
    assert.equal(project.files[`src${path}`], bundle.files[path]);
  }
  assert.match(project.files["electron/main.cjs"], /sandbox: true/);
  assert.match(project.files["electron/main.cjs"], /nodeIntegration: false/);
  assert.match(project.files["vite.config.ts"], /base: "\.\/"/);
  assert.doesNotMatch(project.files["index.html"], /cdn\.tailwindcss\.com/);
  assert.match(project.files["src/styles.css"], /@tailwind utilities/);
});

test("rejects files outside the bundle layout", () => {
  assert.throws(() => createElectronProject({ ...bundle, files: { ...bundle.files, "/../../bad.ts": "bad" } }), /Unexpected bundle path/);
});
