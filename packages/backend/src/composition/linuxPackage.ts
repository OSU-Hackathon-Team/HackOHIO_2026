import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { ApplicationExportResponse, canonicalJson } from "@splice/contracts";
import { hashJson } from "../capabilities/identity.js";

const electronVersion = "45.0.0";

function bytes(file: ApplicationExportResponse["files"][number]): Buffer {
  if (file.content === null) throw new Error(`Export omitted ${file.path}`);
  const data = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  if (createHash("sha256").update(data).digest("hex") !== file.sha256) throw new Error(`Export hash mismatch for ${file.path}`);
  return data;
}

function safePath(filePath: string): string {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe export path ${filePath}`);
  }
  return filePath;
}

/** Materialize a checked Linux x64 payload for installation with the required root-owned sandbox helper. */
export async function packageLinuxApplication(raw: unknown, electronDist: string, destination: string): Promise<{ directory: string; appHash: string }> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Linux x64 packaging requires a Linux x64 host");
  if (existsSync(destination)) throw new Error(`Package destination already exists: ${destination}`);
  const exported = ApplicationExportResponse.parse(raw);
  if (!exported.launch.platforms.some((platform) => platform.os === "linux" && platform.arch === "x64")) throw new Error("Application does not advertise Linux x64");
  const files = new Map<string, Buffer>();
  for (const file of exported.files) {
    const filePath = safePath(file.path);
    if (files.has(filePath)) throw new Error(`Duplicate export path ${filePath}`);
    files.set(filePath, bytes(file));
  }
  for (const required of ["package.json", "splice.plan.json", "splice.lock.json", "host/main.js", "host/preload.cjs", "renderer/index.html"]) {
    if (!files.has(required)) throw new Error(`Export is missing ${required}`);
  }
  const packageJson = JSON.parse(files.get("package.json")!.toString("utf8")) as { devDependencies?: { electron?: string } };
  const runtimeVersion = (await readFile(path.join(electronDist, "version"), "utf8")).trim();
  if (packageJson.devDependencies?.electron !== electronVersion || runtimeVersion !== electronVersion) throw new Error(`Electron runtime must match ${electronVersion}`);
  const lock = JSON.parse(files.get("splice.lock.json")!.toString("utf8")) as { app_id: string; plan_hash: string; package_lock: Array<{ instance: string; artifact_hashes: Array<{ path: string; kind: string }> }> };
  const manifest = JSON.parse(files.get("splice.plan.json")!.toString("utf8")) as { app_id: string; plan: unknown };
  if (lock.app_id !== manifest.app_id || hashJson(manifest.plan) !== lock.plan_hash) throw new Error("Export plan and lock disagree");
  const appHash = hashJson({ plan_hash: lock.plan_hash, package_lock: lock.package_lock, files: exported.files.map(({ path: filePath, sha256, encoding }) => ({ path: filePath, sha256, encoding })) });
  if (appHash !== exported.manifest_hash) throw new Error("Export application hash does not match its files and package lock");
  const executableFiles = new Set(lock.package_lock.flatMap((entry) => entry.artifact_hashes.filter((artifact) => artifact.kind === "binary").map((artifact) => `packages/${entry.instance}/${artifact.path}`)));
  for (const filePath of executableFiles) if (!files.has(filePath)) throw new Error(`Locked binary ${filePath} is missing`);
  if (!(await stat(path.join(electronDist, "electron"))).isFile()) throw new Error("Electron executable is missing");

  const parent = path.dirname(path.resolve(destination));
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".splice-linux-package-"));
  try {
    await chmod(staging, 0o755);
    await cp(electronDist, staging, { recursive: true, force: true });
    const appRoot = path.join(staging, "resources", "app");
    await mkdir(appRoot, { recursive: true });
    for (const [filePath, data] of files) {
      const target = path.join(appRoot, filePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { mode: executableFiles.has(filePath) ? 0o755 : 0o644 });
      if (executableFiles.has(filePath)) await chmod(target, 0o755);
    }
    await writeFile(path.join(staging, "splice-package.json"), canonicalJson({ schema_version: 1, app_id: manifest.app_id, app_hash: appHash, electron_version: electronVersion, platform: "linux/x64" }));
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { directory: path.resolve(destination), appHash };
}
