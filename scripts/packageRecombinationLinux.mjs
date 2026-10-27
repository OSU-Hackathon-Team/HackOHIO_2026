#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { FilesystemRecombinationService } from "../packages/backend/src/recombination/service.ts";
import { packageLinuxApplication } from "../packages/backend/src/composition/linuxPackage.ts";

const [stateDirectory, appId, outputDirectory] = process.argv.slice(2);
if (!stateDirectory || !/^app_[a-f0-9]{32}$/.test(appId ?? "") || !outputDirectory) {
  throw new Error("Usage: node --import tsx scripts/packageRecombinationLinux.mjs <state-dir> <app-id> <output-dir>");
}
const destination = path.resolve(outputDirectory);
const archive = `${destination}.deb`;
const payload = `${destination}.deb-root`;
if (existsSync(destination) || existsSync(archive) || existsSync(payload)) throw new Error("Package destination, payload or archive already exists");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = path.join(repo, "node_modules", "electron", "dist");
const service = new FilesystemRecombinationService(path.resolve(stateDirectory));
try {
  const exported = await service.exportApp(appId);
  const packaged = await packageLinuxApplication(exported, electronDist, destination);
  const packageName = `splice-app-${appId.slice(4)}`;
  const revision = /-(\d+)\.splice-source\.json$/.exec(exported.filename)?.[1];
  if (revision === undefined) throw new Error("Export filename does not identify a revision");
  const appDestination = path.join(payload, "opt", "splice", appId);
  await fs.mkdir(path.dirname(appDestination), { recursive: true });
  await fs.cp(destination, appDestination, { recursive: true });
  await fs.chmod(path.join(appDestination, "chrome-sandbox"), 0o4755);
  const command = path.join(payload, "usr", "bin", packageName);
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.writeFile(command, `#!/bin/sh\nset -eu\nexec /opt/splice/${appId}/electron "$@"\n`, { mode: 0o755 });
  await fs.chmod(command, 0o755);
  await fs.mkdir(path.join(payload, "DEBIAN"));
  await fs.writeFile(path.join(payload, "DEBIAN", "control"), `Package: ${packageName}\nVersion: 1.0.${revision}\nSection: utils\nPriority: optional\nArchitecture: amd64\nMaintainer: Splice\nDepends: bubblewrap, util-linux, libc6, libnss3, libgtk-3-0t64 | libgtk-3-0, libgbm1, libasound2t64 | libasound2\nDescription: Splice generated ${exported.filename}\n`);
  const result = spawnSync("dpkg-deb", ["--build", "--root-owner-group", payload, archive], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`dpkg-deb failed: ${result.stderr || result.error?.message || result.status}`);
  await fs.rm(payload, { recursive: true, force: true });
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  console.log(JSON.stringify({ directory: packaged.directory, deb: archive, deb_sha256: digest.digest("hex"), package_name: packageName, app_hash: packaged.appHash }, null, 2));
} finally {
  service.close();
}
