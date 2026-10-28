import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CapabilityDefinition,
  CapabilityIntakeRecord,
  CapabilityPackage,
  canonicalJson,
} from "@splice/contracts";
import type {
  ArtifactFile,
  CapabilityRegistry as CapabilityRegistryPort,
} from "./types.js";
import { hashJson, packageId, safeRelativePath, sha256Hex, writeArtifactFiles } from "./identity.js";

export class RegistryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryIntegrityError";
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function writeImmutableJson(file: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonicalJson(value));
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const existing = await readFile(file);
    if (!existing.equals(bytes)) throw new RegistryIntegrityError(`immutable registry record collision at ${file}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temp).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await readFile(file);
      if (existing.equals(bytes)) return;
    }
    throw error;
  }
}

/** Filesystem registry for immutable downstream intakes and verified package artifacts. */
export class FilesystemCapabilityRegistry implements CapabilityRegistryPort {
  readonly root: string;
  private readonly packagesDir: string;
  private readonly intakesDir: string;
  private readonly originsDir: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.packagesDir = path.join(this.root, "packages");
    this.intakesDir = path.join(this.root, "intakes");
    this.originsDir = path.join(this.root, "origins");
  }

  async initialize(): Promise<void> {
    await Promise.all([this.packagesDir, this.intakesDir, this.originsDir].map((dir) => mkdir(dir, { recursive: true })));
  }

  async getIntake(intakeId: string): Promise<CapabilityIntakeRecord | null> {
    await this.initialize();
    if (!/^int_[a-f0-9]{32}$/.test(intakeId)) return null;
    try {
      const parsed = CapabilityIntakeRecord.parse(await readJson(path.join(this.intakesDir, `${intakeId}.json`)));
      if (parsed.definition_hash !== hashJson(parsed.definition)) throw new RegistryIntegrityError(`intake ${intakeId} definition hash mismatch`);
      const origin = await readJson(path.join(this.originsDir, `${parsed.origin_artifact_hash}.json`));
      if (hashJson(origin) !== parsed.origin_artifact_hash) throw new RegistryIntegrityError(`intake ${intakeId} origin artifact hash mismatch`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listIntakes(): Promise<CapabilityIntakeRecord[]> {
    await this.initialize();
    const names = await readdir(this.intakesDir);
    const records: CapabilityIntakeRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const id = name.slice(0, -5);
      const record = await this.getIntake(id);
      if (record) records.push(record);
    }
    return records;
  }

  async putIntake(record: CapabilityIntakeRecord): Promise<void> {
    await this.initialize();
    const parsed = CapabilityIntakeRecord.parse(record);
    if (parsed.definition_hash !== hashJson(parsed.definition)) throw new RegistryIntegrityError("intake definition hash does not match definition bytes");
    const originFile = path.join(this.originsDir, `${parsed.origin_artifact_hash}.json`);
    try {
      const origin = await readJson(originFile);
      if (hashJson(origin) !== parsed.origin_artifact_hash) throw new RegistryIntegrityError("intake origin artifact hash mismatch");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RegistryIntegrityError("origin artifact must be stored before its intake");
      throw error;
    }
    await writeImmutableJson(path.join(this.intakesDir, `${parsed.intake_id}.json`), parsed);
  }

  async putOriginArtifact(hash: string, artifact: unknown): Promise<void> {
    await this.initialize();
    if (!/^[a-f0-9]{64}$/.test(hash) || hashJson(artifact) !== hash) {
      throw new RegistryIntegrityError("origin artifact hash does not match canonical artifact bytes");
    }
    await writeImmutableJson(path.join(this.originsDir, `${hash}.json`), artifact);
  }

  async listPackages(): Promise<CapabilityPackage[]> {
    await this.initialize();
    const names = await readdir(this.packagesDir);
    const packages: CapabilityPackage[] = [];
    for (const name of names.filter((entry) => /^pkg_[a-f0-9]{32}$/.test(entry)).sort()) {
      const pkg = await this.getPackage(name);
      if (pkg) packages.push(pkg);
    }
    return packages;
  }

  async getPackage(packageIdValue: string): Promise<CapabilityPackage | null> {
    await this.initialize();
    if (!/^pkg_[a-f0-9]{32}$/.test(packageIdValue)) return null;
    const manifestPath = path.join(this.packagesDir, packageIdValue, "manifest.json");
    let value: unknown;
    try {
      value = await readJson(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const pkg = CapabilityPackage.parse(value);
    if (pkg.package_id !== packageIdValue || packageId(pkg.definition.hash, pkg.build.build_hash) !== packageIdValue) {
      throw new RegistryIntegrityError(`package identity mismatch for ${packageIdValue}`);
    }
    for (const artifact of pkg.artifacts) await this.readArtifact(pkg, artifact.path);
    // Older registry writes stored sidecars without the owner execute bit. Repair the
    // mode only after the bytes have passed the immutable artifact check above.
    for (const entrypoint of pkg.entrypoints.filter((entry) => entry.kind === "sidecar_executable")) {
      const executable = path.join(this.artifactRoot(pkg), entrypoint.path);
      if (!((await stat(executable)).mode & 0o100)) await chmod(executable, 0o700);
    }
    const definitionBytes = await this.readArtifact(pkg, "definition.json");
    let definition: unknown;
    try {
      definition = JSON.parse(definitionBytes.toString("utf8"));
    } catch {
      throw new RegistryIntegrityError(`package ${packageIdValue} has invalid definition.json`);
    }
    const parsedDefinition = CapabilityDefinition.parse(definition);
    if (hashJson(parsedDefinition) !== pkg.definition.hash || parsedDefinition.id !== pkg.definition.id || parsedDefinition.version !== pkg.definition.version) {
      throw new RegistryIntegrityError(`package ${packageIdValue} definition identity mismatch`);
    }
    return pkg;
  }

  async getDefinition(packageIdValue: string): Promise<CapabilityDefinition | null> {
    const pkg = await this.getPackage(packageIdValue);
    if (!pkg) return null;
    const bytes = await this.readArtifact(pkg, "definition.json");
    return CapabilityDefinition.parse(JSON.parse(bytes.toString("utf8")));
  }

  artifactRoot(pkg: CapabilityPackage): string {
    return path.join(this.packagesDir, pkg.package_id);
  }

  async readArtifact(pkg: CapabilityPackage, relativePath: string): Promise<Buffer> {
    const relative = safeRelativePath(relativePath);
    const artifact = pkg.artifacts.find((candidate) => candidate.path === relative);
    if (!artifact) throw new RegistryIntegrityError(`artifact ${relative} is not declared in ${pkg.package_id}`);
    const target = path.resolve(this.artifactRoot(pkg), relative);
    const root = this.artifactRoot(pkg);
    if (!target.startsWith(`${root}${path.sep}`)) throw new RegistryIntegrityError(`artifact path escapes package root: ${relative}`);
    const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
    if (!targetReal.startsWith(`${rootReal}${path.sep}`)) throw new RegistryIntegrityError(`artifact symlink escapes package root: ${relative}`);
    const info = await stat(targetReal);
    if (!info.isFile()) throw new RegistryIntegrityError(`artifact ${relative} is not a regular file`);
    const bytes = await readFile(targetReal);
    if (bytes.length !== artifact.size || sha256Hex(bytes) !== artifact.sha256) {
      throw new RegistryIntegrityError(`artifact content mismatch for ${pkg.package_id}:${relative}`);
    }
    return bytes;
  }

  async putPackage(pkgValue: CapabilityPackage, files: ArtifactFile[]): Promise<void> {
    await this.initialize();
    const pkg = CapabilityPackage.parse(pkgValue);
    if (packageId(pkg.definition.hash, pkg.build.build_hash) !== pkg.package_id) throw new RegistryIntegrityError("package id is not derived from the definition and build hashes");
    const definitionFile = files.find((file) => safeRelativePath(file.path) === "definition.json");
    if (!definitionFile) throw new RegistryIntegrityError("package is missing definition.json");
    const definition = CapabilityDefinition.parse(JSON.parse(definitionFile.data.toString("utf8")));
    if (hashJson(definition) !== pkg.definition.hash) throw new RegistryIntegrityError("package definition hash mismatch");
    const fileMap = new Map(files.map((file) => [safeRelativePath(file.path), file]));
    if (fileMap.size !== files.length || fileMap.size !== pkg.artifacts.length) throw new RegistryIntegrityError("package artifact list and files are not one-to-one");
    for (const artifact of pkg.artifacts) {
      const file = fileMap.get(artifact.path);
      if (!file || file.data.length !== artifact.size || sha256Hex(file.data) !== artifact.sha256) {
        throw new RegistryIntegrityError(`package artifact mismatch for ${artifact.path}`);
      }
    }
    const directory = this.artifactRoot(pkg);
    const executablePaths = new Set(pkg.entrypoints.filter((entry) => entry.kind === "sidecar_executable").map((entry) => entry.path));
    await writeArtifactFiles(directory, files, executablePaths);
    await writeImmutableJson(path.join(directory, "manifest.json"), pkg);
    const stored = await this.getPackage(pkg.package_id);
    if (!stored) throw new RegistryIntegrityError(`package ${pkg.package_id} could not be read after write`);
  }
}
