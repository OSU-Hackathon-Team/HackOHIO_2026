// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/02_ui_synthesis.md §8
// npm run test:synthesis -w @splice/backend [recipe]   (recipe: study | journal | all-four)
// Runs the demo recipes, validates, writes fixtures/bundles/<key>.latest.json. Whether a bundle boots
// in Sandpack is still checked by hand in the Studio. Exit 1 on any failure or missing input.
import fs from "node:fs/promises";
import path from "node:path";
import { FeatureBlueprint } from "@splice/contracts";
import { synthesize, BundleValidationError } from "../synthesis/synthesize.js";
import { synthesisKey } from "../routes/step3/index.js";
import { MISSING_UPSTREAM, REPO_ROOT, step3Deps } from "../routes/step3/deps.js";

/** The golden prompt must stay byte-identical to 09_demo_runbook.md §4 (replay keys depend on it). */
const RECIPES: { name: string; features: string[]; prompt: string }[] = [
  {
    name: "study",
    features: ["inkwell.wikilink_graph", "recall.sm2_scheduler"],
    prompt: "Build a study app for a medical student: notes link to each other with [[wiki links]], show each note's backlinks, and turn every note into a flashcard scheduled with spaced repetition. Show what's due today.",
  },
  {
    name: "journal",
    features: ["recall.review_streaks", "inkwell.fuzzy_search"],
    prompt: "A daily journal where I can quickly fuzzy-search past entries and see my current and longest writing streak.",
  },
  {
    name: "all-four",
    features: ["inkwell.wikilink_graph", "inkwell.fuzzy_search", "recall.sm2_scheduler", "recall.review_streaks"],
    prompt: "A personal knowledge base with linked notes, fast search, spaced-repetition review and a streak counter.",
  },
];

const BP = path.join(REPO_ROOT, "fixtures/blueprints");
const only = process.argv[2];

/** Golden first, then the latest unpromoted run, then a development seed. */
async function loadBlueprint(id: string): Promise<{ bp: FeatureBlueprint; file: string } | null> {
  for (const file of [path.join(BP, `${id}.json`), path.join(BP, `${id}.latest.json`), path.join(BP, "_seed", `${id}.json`)]) {
    try {
      return { bp: FeatureBlueprint.parse(JSON.parse(await fs.readFile(file, "utf8"))), file: path.relative(REPO_ROOT, file) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

if (!step3Deps) {
  console.error(`test:synthesis cannot run yet. Wire these in src/routes/step3/deps.ts:\n  ${MISSING_UPSTREAM.join("\n  ")}`);
  process.exit(1);
}
const deps = step3Deps;

const recipes = RECIPES.filter((r) => !only || r.name === only);
let failed = 0;
for (const r of recipes) {
  const key = synthesisKey(r.features, r.prompt, deps.skills?.version);
  console.log(`\n=== ${r.name}  (${key})`);
  const loaded = await Promise.all(r.features.map(loadBlueprint));
  const missing = r.features.filter((_, i) => !loaded[i]);
  if (missing.length) {
    console.log(`  ✗ missing blueprints: ${missing.join(", ")} (run test:implement first)`);
    failed++;
    continue;
  }
  for (const l of loaded) console.log(`  engine ${l!.bp.implementation.module_name} from ${l!.file} (${l!.bp.verification.status})`);

  const t0 = Date.now();
  try {
    const bundle = await synthesize(loaded.map((l) => l!.bp), r.prompt, `b_test_${r.name}`, {
      onStage: (stage, message) => console.log(`  [${stage}] ${message}`),
      onProgress: () => {},
      onValidation: (ok, errors) => console.log(`  validation: ${ok ? "ok" : `${errors.length} error(s)`}${errors.slice(0, 5).map((e) => `\n    ${e}`).join("")}`),
    }, deps);
    console.log(`  → OK "${bundle.app_title}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const p of [...bundle.engine_paths, ...bundle.generated_paths]) console.log(`    ${p}  ${bundle.files[p].split("\n").length} lines`);
    for (const w of bundle.warnings) console.log(`    warning: ${w}`);
    await fs.mkdir(path.join(REPO_ROOT, "fixtures/bundles"), { recursive: true });
    await fs.writeFile(path.join(REPO_ROOT, "fixtures/bundles", `${key}.latest.json`), JSON.stringify(bundle, null, 2));
  } catch (e) {
    failed++;
    console.log(`  ✗ ${(e as Error).message} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (e instanceof BundleValidationError) for (const x of e.errors) console.log(`    ${x}`);
  }
}

console.log(`\n${recipes.length - failed}/${recipes.length} recipes produced valid bundles`);
process.exit(failed ? 1 : 0);
