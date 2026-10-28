import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as asar from "@electron/asar";
import { analyzeElectronArchive } from "./analyze-archive.mjs";
import { runCase } from "./oracle.mjs";

const archive = process.argv[2];
if (!archive) throw new Error("Archive path required");
const analysis = analyzeElectronArchive(archive);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "splice-inventory-"));
try {
  asar.extractAll(archive, directory);
  const observed = await runCase({ appDir: directory, case: { calls: [] }, timeout: 60_000 });
  const channels = new Map(analysis.ipc.handles.map(item => [item.channel, item]));
  for (const item of observed.channels ?? []) channels.set(item.channel, item);
  process.stdout.write(JSON.stringify({ channels: [...channels.values()], entries: analysis.entries,
    diagnostics: analysis.diagnostics, runtime_error: observed.error ?? null }));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
