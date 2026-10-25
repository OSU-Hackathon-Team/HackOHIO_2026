// Source of truth: agents/CONTRACTS.md — change both together (all three engineers approve).
import { z } from "zod";

export const ArtifactType = z.enum([
  "electron_asar",     // packaged Electron app archive (primary, live)
  "electron_dir",      // unpacked Electron app directory
  "javascript_bundle", // single JS bundle file
  "dotnet_assembly",   // stretch
  "native_pe",         // stretch, replay-only
  "native_elf",        // stretch, replay-only
  "web_app",           // stretch
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const Category = z.enum([
  "graph", "scheduling", "calculator", "parser", "search", "state_engine", "utility",
]);
export type Category = z.infer<typeof Category>;

export const ReaSeed = z.object({
  kind: z.enum(["module", "symbol"]),
  value: z.string(),               // e.g. "src/graph/wikilinks.js" or "parseWikiLinks"
});
export type ReaSeed = z.infer<typeof ReaSeed>;

export const PantryFeature = z.object({
  feature_id: z.string().regex(/^[a-z0-9]+\.[a-z0-9_]+$/), // "<app_id>.<feature>", e.g. "inkwell.wikilink_graph"
  title: z.string(),                // "Wiki-link graph & backlinks"
  query: z.string(),                // natural-language description given to the harvester
  category: Category,
  seeds: z.array(ReaSeed).min(1),   // where REA starts tracing
  symbols: z.array(z.string()).min(1), // functions that must be reconstructed
});
export type PantryFeature = z.infer<typeof PantryFeature>;

export const PantryApp = z.object({
  app_id: z.string().regex(/^[a-z0-9]+$/), // "inkwell"
  display_name: z.string(),         // "Inkwell Notes"
  icon: z.string(),                 // lucide-react icon name, e.g. "BookOpen"
  description: z.string(),
  artifact_type: ArtifactType,
  target_path: z.string(),          // repo-relative, e.g. "targets/build/inkwell/app.asar"
  live_supported: z.boolean(),      // false → replay only
  features: z.array(PantryFeature).min(1),
});
export type PantryApp = z.infer<typeof PantryApp>;

export const Pantry = z.object({ apps: z.array(PantryApp) });
export type Pantry = z.infer<typeof Pantry>;
