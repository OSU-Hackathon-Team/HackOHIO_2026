import { z } from "zod";
import { BuilderLayout, FeatureId, SAMPLE_FEATURES, assertLayoutFeatures, type BuilderBlock } from "@splice/contracts";

export const Project = z.object({
  version: z.literal(1), id: z.string(), title: z.string().min(1).max(100), goal: z.string().max(2000),
  mode: z.enum(["explore", "build"]), sampleAnalysis: z.boolean(),
  sources: z.array(z.object({ name: z.string(), size: z.number().nonnegative() })).max(20),
  featureIds: z.array(FeatureId).max(4), layout: BuilderLayout, revision: z.number().int().nonnegative(),
  chat: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string(), model: z.string().optional() })),
  notes: z.array(z.object({ id: z.string(), title: z.string(), body: z.string() })),
  reviews: z.record(z.object({ repetitions: z.number(), intervalDays: z.number(), easeFactor: z.number(), lapses: z.number(), dueDate: z.string(), isLeech: z.boolean() })),
}).superRefine((p, ctx) => { try { assertLayoutFeatures(p.layout, p.featureIds); } catch (e) { ctx.addIssue({ code: "custom", message: (e as Error).message }); } });
export type Project = z.infer<typeof Project>;
export type Scene = Pick<Project, "layout" | "featureIds">;
export const projectId = () => crypto.randomUUID();
export function newProject(goal: string, sources: Project["sources"], sample: boolean): Project {
  return {
    version: 1, id: projectId(), title: sample ? "My study space" : "Untitled project", goal, sources, sampleAnalysis: sample,
    mode: "explore", revision: 0, featureIds: [], layout: [], reviews: {},
    chat: [{ role: "assistant", text: sample ? "These are sample findings from Inkwell Notes and Recall Flashcards. Explore a feature to see what it does, then add it to your app. Your original application has not been analyzed." : "Your files are attached by name and size only. Native analysis is not connected in this prototype. You can explore an explicitly labeled example instead." }],
    notes: [
      { id: "cardiology", title: "Cardiology", body: "The heart connects [[Anatomy]] with [[Physiology]]." },
      { id: "anatomy", title: "Anatomy", body: "Structure supports [[Physiology]]." },
      { id: "physiology", title: "Physiology", body: "Circulation is part of [[Cardiology]]." },
      { id: "pharmacology", title: "Pharmacology", body: "Treatments build on [[Physiology]]." },
      { id: "clinical", title: "Clinical practice", body: "Apply [[Cardiology]] and [[Pharmacology]]." },
    ],
  };
}
export function sectionsForFeature(id: string): BuilderBlock[] {
  const kinds = id === "wiki-links" ? ["notes", "backlinks"] as const : ["reviews"] as const;
  return kinds.map(kind => ({ id: projectId(), kind, title: { notes: "My notes", backlinks: "Connected ideas", reviews: "Review practice" }[kind], description: "", visible: true, width: kind === "notes" ? "full" : "half" }));
}
export function addFeatureToScene(scene: Scene, id: string, index?: number): Scene {
  const feature = SAMPLE_FEATURES.find(f => f.id === id);
  if (!feature || feature.status !== "sample") throw new Error("This finding is not available for reuse. Review its evidence first.");
  if (scene.featureIds.includes(feature.id)) return scene;
  let result = scene;
  for (const dependency of feature.dependencies) result = addFeatureToScene(result, dependency);
  const blocks = sectionsForFeature(id);
  const layout = [...result.layout]; layout.splice(Math.min(index ?? layout.length, layout.length), 0, ...blocks);
  return { layout, featureIds: [...result.featureIds, feature.id] };
}
