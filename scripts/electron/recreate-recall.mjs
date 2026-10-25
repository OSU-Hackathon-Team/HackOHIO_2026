import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { inspectElectronArchive } from "./inspect-archive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const EXPECTED_ARCHIVE = "76af753af301c7596196594ca58dc6b15b42f3019fb227c7e87411322d484f55";

export function recreateRecall(archivePath, outputPath) {
  const evidence = inspectElectronArchive(archivePath);
  const main = evidence.files[evidence.main];
  if (evidence.archive_sha256 !== EXPECTED_ARCHIVE || evidence.package_name !== "recall-flashcards" ||
      !main || JSON.stringify(main.ipc_handles) !== JSON.stringify(["card:answer", "stats:streak"]) ||
      !["./db/deckStore", "./scheduler/sm2", "./stats/streaks"].every(name => main.local_requires.includes(name))) {
    throw new Error("Unsupported Electron archive: Recall behavior evidence does not match the reviewed target");
  }
  const blueprint = JSON.parse(fs.readFileSync(path.join(repo, "fixtures/hand-authored/blueprints/recall.sm2_scheduler.json"), "utf8"));
  if (blueprint.feature_id !== "recall.sm2_scheduler" || blueprint.spec.oracle.status !== "passed" ||
      blueprint.verification.status !== "passed") throw new Error("Recall scheduler blueprint is not verified");

  const output = path.resolve(outputPath);
  if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
  fs.mkdirSync(path.join(output, "electron", "engine"), { recursive: true });
  fs.mkdirSync(path.join(output, "dist"), { recursive: true });
  const template = path.join(here, "recall-template");
  for (const [source, destination] of [
    ["main.cjs", "electron/main.cjs"], ["preload.cjs", "electron/preload.cjs"],
    ["streaks.cjs", "electron/engine/streaks.cjs"], ["index.html", "dist/index.html"],
    ["renderer.js", "dist/renderer.js"], ["style.css", "dist/style.css"],
  ]) fs.copyFileSync(path.join(template, source), path.join(output, destination));
  const scheduler = transformSync(blueprint.implementation.portable_code, { loader: "ts", format: "cjs", target: "node22" });
  fs.writeFileSync(path.join(output, "electron/engine/scheduler.cjs"), scheduler.code);
  fs.writeFileSync(path.join(output, "package.json"), JSON.stringify({
    name: "recall-recreated", version: "1.0.0", private: true,
    main: "electron/main.cjs", scripts: { start: "electron ." },
    devDependencies: { electron: "45.0.0" },
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "evidence.json"), JSON.stringify({
    ...evidence,
    reconstruction: {
      scheduler_blueprint: "fixtures/hand-authored/blueprints/recall.sm2_scheduler.json",
      scheduler_oracle: blueprint.spec.oracle.status,
      scheduler_verification: blueprint.verification.status,
      scope: "Recall IPC, JSON deck storage, scheduler, streaks, and desktop UI",
      method: "reviewed bounded template plus verified scheduler blueprint; original source is not copied",
    },
  }, null, 2) + "\n");
  return { output, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2] || path.join(repo, "targets/build/recall/app.asar");
  const output = process.argv[3];
  if (!output) {
    console.error("Usage: node scripts/electron/recreate-recall.mjs <app.asar> <new-output-directory>");
    process.exitCode = 2;
  } else {
    try { console.log(recreateRecall(archive, output).output); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
