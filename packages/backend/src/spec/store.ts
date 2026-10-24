// Owner: Eng 2 (Requirements) — spec: agents/2_requirements_extraction/01_pipeline_and_route.md §2
import fs from "node:fs/promises";
import path from "node:path";
import { FeatureSpec } from "@splice/contracts";
import { REPO_ROOT } from "../config.js";

const DIR = path.join(REPO_ROOT, "fixtures/specs");

export async function saveSpec(spec: FeatureSpec): Promise<void> {
  if (spec.provenance.mode !== "live") return; // replay-derived specs are not re-saved
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${spec.feature_id}.latest.json`), JSON.stringify(spec, null, 2));
}

/** Golden specs first, then hand-authored, then _seed. One per feature_id. */
export async function listSpecs(): Promise<FeatureSpec[]> {
  const out = new Map<string, FeatureSpec>();
  for (const dir of [DIR, path.join(DIR, "_seed"), path.join(REPO_ROOT, "fixtures/hand-authored/specs")]) {
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files.filter((f) => f.endsWith(".json") && !f.endsWith(".latest.json"))) {
      try {
        const spec = FeatureSpec.parse(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
        if (!out.has(spec.feature_id)) {
          out.set(spec.feature_id, { ...spec, provenance: { ...spec.provenance, mode: "replay" } });
        }
      } catch {
        /* skip invalid spec json */
      }
    }
  }
  return [...out.values()];
}

/** Finds a recorded spec: golden, hand-authored, or seed. */
export async function loadRecordedSpec(featureId: string): Promise<FeatureSpec | null> {
  const candidates = [
    path.join(DIR, `${featureId}.json`),
    path.join(DIR, `${featureId}.latest.json`),
    path.join(REPO_ROOT, "fixtures/hand-authored/specs", `${featureId}.json`),
    path.join(DIR, "_seed", `${featureId}.json`),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const spec = FeatureSpec.parse(JSON.parse(raw));
      return { ...spec, provenance: { ...spec.provenance, mode: "replay" } };
    } catch {
      /* continue */
    }
  }
  return null;
}
