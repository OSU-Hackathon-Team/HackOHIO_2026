import asar from "@electron/asar";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export interface ArchiveReader {
  files: string[]; // posix paths relative to archive root, no leading slash
  readText(p: string): string;
}

export const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");

export async function openArchive(absPath: string): Promise<ArchiveReader> {
  if (!fsSync.existsSync(absPath)) {
    throw new Error(`Archive not found: ${absPath}`);
  }

  if (absPath.endsWith(".asar")) {
    const files = asar.listPackage(absPath, { isPack: false }).map(norm);
    const fileSet = new Set(files);
    return {
      files,
      readText: (p) => {
        const key = norm(p);
        if (!fileSet.has(key)) throw new Error(`not in archive: ${key}`);
        // The public reader uses POSIX keys; asar's extractor splits on the host separator.
        return asar.extractFile(absPath, key.split("/").join(path.sep)).toString("utf8");
      },
    };
  }

  // electron_dir
  const files: string[] = [];
  async function walk(dir: string) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(norm(path.relative(absPath, full)));
    }
  }
  await walk(absPath);
  return {
    files,
    readText: (p) => fsSync.readFileSync(path.join(absPath, norm(p)), "utf8"),
  };
}
