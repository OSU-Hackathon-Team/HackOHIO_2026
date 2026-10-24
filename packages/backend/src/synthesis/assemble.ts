// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/02_ui_synthesis.md §5
// Engines and entry files are written by the server only, so engines are byte-identical by construction.
import { GENERATED_PATH, ALLOWED_DEPENDENCIES, type FeatureBlueprint, type SynthesisBundle } from "@splice/contracts";

export const ENTRY_FILES: Record<string, string> = {
  "/public/index.html": `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-50 text-slate-900 antialiased">
    <div id="root"></div>
  </body>
</html>`,
  "/index.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`,
  "/styles.css": `html, body, #root { min-height: 100%; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }`,
};

export function enginePath(b: FeatureBlueprint) {
  return `/engines/${b.implementation.module_name}.ts`;
}

/** Two engines with the same module or feature would overwrite each other in /engines/. */
export function duplicateEngineErrors(blueprints: FeatureBlueprint[]): string[] {
  const errors: string[] = [];
  const seen = { module: new Set<string>(), feature: new Set<string>() };
  for (const b of blueprints) {
    if (seen.module.has(b.implementation.module_name)) errors.push(`Duplicate engine module "${b.implementation.module_name}"`);
    if (seen.feature.has(b.feature_id)) errors.push(`Duplicate feature "${b.feature_id}"`);
    seen.module.add(b.implementation.module_name);
    seen.feature.add(b.feature_id);
  }
  return errors;
}

/** Merge: server entry files + engines (verbatim) + allowed generated files. */
export function assembleBundle(
  blueprints: FeatureBlueprint[],
  generated: { path: string; content: string }[],
  meta: { bundle_id: string; app_title: string; app_description: string; revision: number; mode: "live" | "replay" },
): SynthesisBundle {
  const dup = duplicateEngineErrors(blueprints);
  if (dup.length) throw new Error(dup.join("; "));

  const warnings: string[] = [];
  const files: Record<string, string> = { ...ENTRY_FILES };
  for (const b of blueprints) files[enginePath(b)] = b.implementation.portable_code;

  // GENERATED_PATH excludes every server-owned path, so generated files can't overwrite them.
  const generated_paths: string[] = [];
  for (const f of generated) {
    const p = f.path.startsWith("/") ? f.path : "/" + f.path;
    if (!GENERATED_PATH.test(p)) { warnings.push(`Dropped file outside allowed paths: ${p}`); continue; }
    if (generated_paths.includes(p)) warnings.push(`File written twice, kept the last version: ${p}`);
    else generated_paths.push(p);
    files[p] = f.content;
  }

  return {
    bundle_id: meta.bundle_id,
    app_title: meta.app_title,
    app_description: meta.app_description,
    files,
    dependencies: { ...ALLOWED_DEPENDENCIES },
    engine_paths: blueprints.map(enginePath),
    generated_paths,
    feature_ids: blueprints.map((b) => b.feature_id),
    warnings,
    mode: meta.mode,
    revision: meta.revision,
  };
}
