// Live native specs (GET /api/native-specs) as Studio library entries, shown next to the fixtures.
// A "draft" spec comes from a partial dossier: it is viewable, but the backend adapter refuses to
// turn it into a FeatureSpec, so Studio must not offer reconstruction for it.

import type { DecompRunEvent, DecompRunResult, DecompStage, NativeSubsystemSpec } from "@splice/contracts";
import type { DecompiledTarget, IdeFeatureRecord } from "./ideFixtures";

export const liveNativeTargetId = (artifact: string) => `native-${artifact.slice(0, 12)}`;

export function nativeSpecToLibrary(artifact: string, spec: NativeSubsystemSpec): {
  target: DecompiledTarget;
  feature: IdeFeatureRecord;
} {
  const id = liveNativeTargetId(artifact);
  const draft = spec.status === "draft";
  const target: DecompiledTarget = {
    id,
    name: spec.title,
    friendlyCategory: "Native binary (live decompilation)",
    tagline: spec.purpose,
    engineKind: "ghidra_native",
    artifactType: "native_binary",
    targetPath: `decomp-state/artifacts/${artifact.slice(0, 2)}/${artifact}`,
    sha256: artifact,
    description: `${spec.purpose} Specification ${draft ? "draft from a partial dossier" : "ready for review"}; ` +
      `${spec.requirements.length} requirements, ${spec.examples.length} observed examples.`,
    flowSteps: [
      { stepNumber: "01", title: "Runtime-seeded scope",
        description: "Frida observed which functions ran for each formula; scoped Ghidra decompiled only those." },
      { stepNumber: "02", title: "Drafted and independently reviewed claims",
        description: "Each function's behavior claims were checked against raw evidence by a separate review." },
      { stepNumber: "03", title: draft ? "Draft specification" : "Specification ready for review",
        description: draft
          ? "Evidence is incomplete, so reconstruction stays disabled until a run reaches ready_for_review."
          : "Can be adapted into a FeatureSpec and implemented as a clean-room engine." },
    ],
    highlights: spec.acceptance_criteria.slice(0, 3),
    files: [],
    nativeSpec: spec,
  };
  const feature: IdeFeatureRecord = {
    featureId: `${id}.subsystem`,
    builderId: "spaced-review",
    targetId: id,
    title: spec.title,
    sourceApp: spec.title,
    category: "Native subsystem",
    readiness: draft ? "needs_review" : "sample",
    friendlyStatusLabel: draft ? "Needs Review" : "Ready to Use",
    oracleStatus: "not_executable",
    engineStatus: "unimplemented",
    summary: spec.purpose,
    everydayBenefit: spec.behavior_steps[0] ?? spec.purpose,
    limitation: draft
      ? "Draft specification: the evidence is incomplete, so it cannot be reconstructed yet."
      : "Reconstructed from native decompilation; the native binary is not executed in the browser.",
    dependencies: [],
    plainRules: spec.requirements.map((r) => ({
      id: r.id, category: "How it works" as const, title: r.id, explanation: r.statement,
      exampleInput: "", exampleOutput: "",
    })),
    verifiedScenarios: [],
  };
  return { target, feature };
}

export interface DecompRunView {
  runId: string;
  stage: DecompStage;
  message: string;
  drafted: { done: number; total: number } | null;
  reviewed: { done: number; total: number } | null;
  log: string[];
  result: DecompRunResult | null;
  error: string | null;
  finished: boolean;
  ok: boolean | null;
}

export function initialRunView(runId: string): DecompRunView {
  return { runId, stage: "queued", message: "Queued", drafted: null, reviewed: null, log: [],
           result: null, error: null, finished: false, ok: null };
}

/** Folds one streamed event into the run view (pure, so it is unit-tested). */
export function applyDecompEvent(view: DecompRunView, event: DecompRunEvent): DecompRunView {
  switch (event.type) {
    case "stage": return { ...view, stage: event.stage, message: event.message };
    case "progress": {
      const value = { done: event.done, total: event.total };
      return event.label === "reviewed" ? { ...view, reviewed: value } : { ...view, drafted: value };
    }
    case "log": return { ...view, log: [...view.log, event.line].slice(-200) };
    case "result": return { ...view, result: event.result };
    case "error": return { ...view, error: event.message };
    case "done": return { ...view, finished: true, ok: event.ok, stage: event.ok ? view.stage : "failed" };
  }
}
