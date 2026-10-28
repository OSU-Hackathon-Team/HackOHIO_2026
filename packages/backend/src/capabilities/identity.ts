import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@splice/contracts";
import type { ImplementationSource, PublicTestCase } from "@splice/contracts";
import type { ArtifactFile } from "./types.js";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function packageId(definitionHash: string, buildHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(definitionHash) || !/^[a-f0-9]{64}$/.test(buildHash)) {
    throw new TypeError("package identity requires lowercase SHA-256 hashes");
  }
  return `pkg_${hashJson({ definition_hash: definitionHash, build_hash: buildHash }).slice(0, 32)}`;
}

/** Immutable inputs that affect whether a build's verification can be reused. */
export function buildInputManifest(input: {
  intake_id: string;
  implementation: ImplementationSource;
  public_tests: PublicTestCase[];
}): Record<string, unknown> {
  if (input.implementation.kind === "blueprint") throw new TypeError("blueprint source needs an explicit adapter before a package build");
  return {
    intake_id: input.intake_id,
    kind: input.implementation.kind,
    entry: input.implementation.entry,
    compiler: input.implementation.kind === "c" ? input.implementation.compiler : null,
    public_tests: input.public_tests,
  };
}

export function safeRelativePath(relative: string): string {
  if (!relative || relative.includes("\0") || path.isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative)) {
    throw new TypeError(`unsafe artifact path: ${relative}`);
  }
  if (relative.replace(/\\/g, "/").split("/").includes("..")) throw new TypeError(`unsafe artifact path: ${relative}`);
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`unsafe artifact path: ${relative}`);
  }
  return normalized;
}

/** Write immutable files below a content-addressed directory. Existing bytes must match. */
export async function writeArtifactFiles(root: string, files: ArtifactFile[], executablePaths: ReadonlySet<string> = new Set()): Promise<void> {
  const absoluteRoot = path.resolve(root);
  await mkdir(absoluteRoot, { recursive: true });
  for (const file of files) {
    const relative = safeRelativePath(file.path);
    const target = path.resolve(absoluteRoot, relative);
    const mode = executablePaths.has(relative) ? 0o700 : 0o600;
    if (!target.startsWith(`${absoluteRoot}${path.sep}`)) throw new TypeError(`artifact escapes root: ${file.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(file.data);
    try {
      if (!(await lstat(target)).isFile()) throw new Error(`artifact is not a regular file: ${file.path}`);
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw new Error(`immutable artifact collision at ${file.path}`);
      await chmod(target, mode);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { mode, flag: "wx" });
    await chmod(temp, mode);
    try {
      await rename(temp, target);
    } catch (error) {
      await import("node:fs/promises").then(({ unlink }) => unlink(temp).catch(() => undefined));
      throw error;
    }
  }
}
