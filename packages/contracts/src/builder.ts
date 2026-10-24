// Prototype project contracts; these do not represent native engine job state or verified findings.
import { z } from "zod";

export const SAMPLE_FEATURES = [
  { id: "wiki-links", title: "Linked notes", source: "Inkwell Notes", status: "sample", description: "Connect ideas with [[links]] and see which notes refer to each other.", checks: 3, dependencies: [] as string[], limitation: "Authored sample implementation. Three local checks passed; original application behavior has not been verified." },
  { id: "spaced-review", title: "Spaced repetition", source: "Recall Flashcards", status: "sample", description: "Turn your notes into flashcards and schedule the next review from a recall grade.", checks: 3, dependencies: ["wiki-links"], limitation: "Authored sample implementation. Three local checks passed; original application behavior has not been verified." },
  { id: "fuzzy-search", title: "Fuzzy search", source: "Inkwell Notes", status: "needs_review", description: "Find notes even when a search is not an exact match.", checks: 0, dependencies: [] as string[], limitation: "Sample finding only. Its interface and edge cases still need review; no reusable implementation is supplied." },
  { id: "cloud-sync", title: "Cloud sync", source: "Inkwell Notes", status: "blocked", description: "Keep notes consistent across devices.", checks: 0, dependencies: [] as string[], limitation: "Sample finding only. Network and storage dependencies are unresolved. It cannot be added to an app." },
] as const;
export const FeatureId = z.enum(["wiki-links", "spaced-review", "fuzzy-search", "cloud-sync"]);
export const BlockKind = z.enum(["notes", "backlinks", "reviews", "text"]);
export const BuilderBlock = z.object({
  id: z.string().min(1).max(80), kind: BlockKind, title: z.string().max(100),
  description: z.string().max(500), visible: z.boolean(), width: z.enum(["full", "half"]),
}).strict();
export type BuilderBlock = z.infer<typeof BuilderBlock>;
export const BuilderLayout = z.array(BuilderBlock).max(24).superRefine((blocks, ctx) => {
  if (new Set(blocks.map(b => b.id)).size !== blocks.length) ctx.addIssue({ code: "custom", message: "Section IDs must be unique" });
});
export const BuilderEditRequest = z.object({
  revision: z.number().int().nonnegative(), instruction: z.string().trim().min(1).max(2000),
  selectedBlockId: z.string().nullable(), featureIds: z.array(FeatureId).max(4), layout: BuilderLayout,
}).strict();
export type BuilderEditRequest = z.infer<typeof BuilderEditRequest>;
// A single fixed object shape keeps the model's JSON schema compatible with both Bedrock paths.
export const BuilderOperation = z.object({
  type: z.enum(["add", "update", "remove", "move"]), blockId: z.string().max(80),
  index: z.number().int().min(0).max(24), block: BuilderBlock.nullable(),
}).strict();
export const BuilderDraft = z.object({ summary: z.string().min(1).max(600), operations: z.array(BuilderOperation).max(24) }).strict();
export type BuilderDraft = z.infer<typeof BuilderDraft>;
export const BuilderEditResponse = BuilderDraft.extend({ revision: z.number().int().nonnegative(), model: z.string() });
export type BuilderEditResponse = z.infer<typeof BuilderEditResponse>;

export function assertUsableFeatures(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate features are not allowed");
  for (const id of ids) {
    const feature = SAMPLE_FEATURES.find(f => f.id === id);
    if (!feature || feature.status !== "sample") throw new Error(`Feature ${id} is not available for sample builds`);
    if (feature.dependencies.some(dep => !ids.includes(dep))) throw new Error(`Feature ${id} requires linked notes`);
  }
}
export function assertLayoutFeatures(layout: BuilderBlock[], ids: string[]) {
  assertUsableFeatures(ids);
  for (const block of layout) {
    const feature = block.kind === "reviews" ? "spaced-review" : block.kind === "text" ? null : "wiki-links";
    if (feature && !ids.includes(feature)) throw new Error(`${block.kind} needs the ${feature} feature`);
  }
}
/** Apply to a copy and validate the complete result before publishing any edit. */
export function applyBuilderOperations(layout: BuilderBlock[], operations: BuilderDraft["operations"], featureIds: string[]): BuilderBlock[] {
  const next = layout.map(b => ({ ...b }));
  for (const op of operations) {
    const index = next.findIndex(b => b.id === op.blockId);
    if (op.type === "add") {
      if (!op.block || op.block.id !== op.blockId || index !== -1) throw new Error("New section must have a unique matching ID");
      next.splice(Math.min(op.index, next.length), 0, op.block);
    } else {
      if (index === -1) throw new Error(`Unknown section: ${op.blockId}`);
      if (op.type === "remove") next.splice(index, 1);
      if (op.type === "move") { const [block] = next.splice(index, 1); next.splice(Math.min(op.index, next.length), 0, block); }
      if (op.type === "update") {
        if (!op.block || op.block.id !== op.blockId || op.block.kind !== next[index].kind) throw new Error("Update must preserve section ID and kind");
        next[index] = op.block;
      }
    }
  }
  const parsed = BuilderLayout.parse(next); assertLayoutFeatures(parsed, featureIds); return parsed;
}
