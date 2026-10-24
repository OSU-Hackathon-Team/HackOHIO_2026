// npm run fixtures:promote -- recall.sm2_scheduler   (or no arg = all *.latest.json)
import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "../config.js";

const only = process.argv[2];
const roots = [
  "evidence",
  "transcripts/extract",
  "transcripts/implement",
  "transcripts/synthesize",
  "specs",
  "blueprints",
  "bundles",
].map((d) => path.join(REPO_ROOT, "fixtures", d));

for (const dir of roots) {
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    continue;
  }
  for (const f of files.filter((f) => f.endsWith(".latest.json"))) {
    if (only && !f.startsWith(only)) continue;
    const golden = f.replace(".latest.json", ".json");
    await fs.copyFile(path.join(dir, f), path.join(dir, golden));
    console.log("promoted", path.relative(REPO_ROOT, path.join(dir, golden)));
  }
}
