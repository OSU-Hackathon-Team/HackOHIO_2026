import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeElectronArchive } from "./analyze-archive.mjs";
import { recreateRecall } from "./recreate-recall.mjs";
import { recreateProject } from "./recreate-project.mjs";
import { verifyProject } from "./verify-project.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapters = [
  { name: "reviewed-recall", create: recreateRecall, scenario: path.join(here, "scenarios/recall.json") },
];

/** Choose the highest-coverage reviewed reconstruction available for an archive. */
export async function reconstructElectron(archivePath, outputPath, options = {}) {
  if (!archivePath || !outputPath) throw new Error("Archive and output directory are required");
  const output = path.resolve(outputPath);
  if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
  if (options.requireFullParity) throw new Error("Full source-app parity is not established by any available adapter");

  for (const adapter of adapters) {
    let result;
    try { result = adapter.create(archivePath, output); }
    catch (error) {
      if (error.message.startsWith("Unsupported Electron archive:")) continue;
      throw error;
    }
    try {
      const verification = await verifyProject(archivePath, output, adapter.scenario);
      const analysis = analyzeElectronArchive(archivePath);
      const channels = [...new Set(analysis.ipc.handles.map(item => item.channel))];
      const manifest = {
        schema_version: 1,
        source: analysis.archive,
        method: adapter.name,
        parity: {
          level: "bounded-original-ipc",
          original_ipc_channels: channels,
          matched_ipc_channels: verification.channels,
          unmatched_ipc_channels: channels.filter(channel => !verification.channels.includes(channel)),
          original_storage_recreated: true,
          original_ui_recreated: false,
          note: "Observed original IPC and selected file effects passed the recorded scenario; this does not establish full source-app equivalence.",
        },
        verification: { status: verification.result, scenario: path.relative(path.resolve(here, "../.."), adapter.scenario), checks: verification.checks },
      };
      fs.writeFileSync(path.join(output, "analysis.json"), JSON.stringify(analysis, null, 2) + "\n");
      fs.writeFileSync(path.join(output, "reconstruction.json"), JSON.stringify(manifest, null, 2) + "\n");
      return { output, manifest, evidence: result.evidence };
    } catch (error) {
      fs.rmSync(output, { recursive: true, force: true });
      throw error;
    }
  }

  if (options.requireOriginalIpc) throw new Error("No reviewed original-IPC reconstruction adapter supports this archive");
  return recreateProject(archivePath, output, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2], output = process.argv[3];
  if (!archive || !output) {
    console.error("Usage: node scripts/electron/reconstruct.mjs <app.asar> <new-output-directory> [--require-original-ipc] [--require-full-parity]");
    process.exitCode = 2;
  } else reconstructElectron(archive, output, {
    requireOriginalIpc: process.argv.includes("--require-original-ipc"),
    requireFullParity: process.argv.includes("--require-full-parity"),
  }).then(result => console.log(`${result.output}\nCoverage: ${result.manifest.parity.level}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
