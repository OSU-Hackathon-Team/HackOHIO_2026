// scripts/build-targets.mjs
import { createPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["inkwell", "recall"];

async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

for (const app of APPS) {
  const src = path.join(ROOT, "targets/src", app);
  const outDir = path.join(ROOT, "targets/build", app);
  const out = path.join(outDir, "app.asar");
  await fs.mkdir(outDir, { recursive: true });
  await createPackage(src, out);
  const hash = await sha256(out);
  await fs.writeFile(out + ".sha256", hash + "\n");
  console.log(`${app.padEnd(8)} → ${path.relative(ROOT, out)}  sha256=${hash.slice(0, 16)}…`);
}
