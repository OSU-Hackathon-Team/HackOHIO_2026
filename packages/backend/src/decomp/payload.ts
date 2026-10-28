// Code payload for the EC2 decomp worker: tracked files only, selected by pattern, so a new engine
// module is never missing (a hand-kept list once dropped engine/behavior.py) and untracked or
// gitignored files such as packages/backend/.env can never be shipped.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Windows' bsdtar; on PATH, Git's GNU tar would read "C:\..." as a remote host. */
export const TAR = process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

export const PAYLOAD_PATTERNS: readonly RegExp[] = [
  /^engine\//,
  /^scripts\/(lo_[a-z_]+|native_pipeline)\.py$/,
  /^fixtures\/decomp\/libreoffice\/[a-z0-9_]+\.json$/,
  // Target registry (Phase 1) and command-line case suites (Phase 2).
  /^fixtures\/decomp\/targets\/[a-z0-9-]+\.json$/,
  /^fixtures\/decomp\/cli\/[a-z0-9_]+\.json$/,
  /^(launch|agent_worker|model_config)\.py$/,
  /^models\.json$/,
  /^worker\.Dockerfile$/,
  /^infra\/decomp-ec2\//,
  // Node workspace for the LLM spec writer (engine/specification.py -> writeNativeSpec.ts).
  /^package(-lock)?\.json$/,
  /^tsconfig(\.base)?\.json$/,
  /^packages\/(contracts|backend)\/(package\.json|tsconfig\.json|src\/)/,
  /^packages\/frontend\/package\.json$/, // listed in the lockfile; npm ci needs the manifest
];

const NEVER = [/(^|\/)\.env(\.|$)/, /\.test\.ts$/, /(^|\/)__pycache__\//];

export function selectPayloadFiles(tracked: readonly string[]): string[] {
  return tracked
    .filter((file) => PAYLOAD_PATTERNS.some((p) => p.test(file)) && !NEVER.some((p) => p.test(file)))
    .sort();
}

export async function listTrackedFiles(root: string): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean);
}

/** Writes a .tgz of the selected files (working-tree contents) and returns what it contains. */
export async function buildPayload(root: string, outFile: string): Promise<{ file: string; files: string[] }> {
  const files = selectPayloadFiles(await listTrackedFiles(root));
  if (!files.some((f) => f === "scripts/lo_pipeline.py")) throw new Error("payload is missing scripts/lo_pipeline.py");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "decomp-payload-"));
  try {
    const list = path.join(scratch, "files.txt");
    await fs.writeFile(list, files.join("\n") + "\n");
    await run(TAR, ["-czf", outFile, "-C", root, "-T", list]);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  return { file: outFile, files };
}
