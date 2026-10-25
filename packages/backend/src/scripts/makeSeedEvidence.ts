import fs from "node:fs/promises";
import path from "node:path";
import { RawEvidence, Pantry } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";

const pantry = Pantry.parse(JSON.parse(await fs.readFile(path.join(REPO_ROOT, "targets/manifest.json"), "utf8")));
for (const app of pantry.apps) {
  for (const f of app.features) {
    const seedPath = f.seeds[0].value;
    const srcRoot = path.join(REPO_ROOT, "targets/src", app.app_id);
    const seedCode = await fs.readFile(path.join(srcRoot, seedPath), "utf8");
    const rel = [...seedCode.matchAll(/require\(["'](\.[^"']+)["']\)/g)].map(
      (m) => path.posix.normalize(path.posix.join(path.posix.dirname(seedPath), m[1])) + ".js",
    );
    const paths = [seedPath, ...rel, "src/main.js"];
    const snippets = await Promise.all(
      paths.map(async (p) => {
        const code = await fs.readFile(path.join(srcRoot, p), "utf8");
        return {
          location: `app.asar:${p}`,
          symbol: f.symbols.find((s) => code.includes(`function ${s}`) || new RegExp(`\\b${s}\\b`).test(code)) ?? null,
          language: "javascript" as const,
          code,
          full_module: true,
        };
      }),
    );
    const sha = (await fs.readFile(path.join(REPO_ROOT, app.target_path + ".sha256"), "utf8")).trim();
    const ev = RawEvidence.parse({
      app_id: app.app_id,
      feature_id: f.feature_id,
      target: { path: app.target_path, artifact_type: app.artifact_type, sha256: sha },
      rea_package_version: "6.7.0",
      mode: "replay",
      tool_calls: [],
      snippets,
      related_paths: paths,
      limitations: ["Seed evidence assembled from source, not from REA"],
      unknowns: [],
      collected_at: new Date().toISOString(),
    });
    const out = path.join(REPO_ROOT, "fixtures/evidence/_seed", `${f.feature_id}.json`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(ev, null, 2));
    console.log("wrote", path.relative(REPO_ROOT, out));
  }
}
