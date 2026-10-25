// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/02_ui_synthesis.md §6
// Implementation note: when fixes run out this throws BundleValidationError instead of returning a
// bundle with "Unresolved" warnings, so an app that fails validation never reaches Sandpack as ready.
import type { FeatureBlueprint, SynthesisBundle } from "@splice/contracts";
import type { ChatMessage, LlmPort } from "../engine/ports.js";
import { SYNTH_SYSTEM, SYNTH_DRAFT_SCHEMA, SynthDraft, formatSynthRequest } from "./prompt.js";
import { assembleBundle, duplicateEngineErrors } from "./assemble.js";
import { validateBundle } from "./validateBundle.js";
import { skillSession, type SkillCatalog } from "../skills/skills.js";

export interface SynthHooks {
  signal?: AbortSignal;
  onStage(stage: "designing" | "generating" | "validating" | "fixing", message: string): void;
  onProgress(outputChars: number): void;
  onValidation(ok: boolean, errors: string[]): void;
}

export const MAX_FIXES = 2;

export class BundleValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`The app still has ${errors.length} problem(s) after ${MAX_FIXES} fixes: ${errors[0] ?? "unknown"}`);
    this.name = "BundleValidationError";
  }
}

/** Only verified engines may be fused, and each at most once. */
export function fusionErrors(blueprints: FeatureBlueprint[]): string[] {
  return [
    ...duplicateEngineErrors(blueprints),
    ...blueprints
      .filter((b) => b.verification.status !== "passed")
      .map((b) => `Engine ${b.implementation.module_name} (${b.feature_id}) has not passed verification`),
  ];
}

export async function synthesize(
  blueprints: FeatureBlueprint[],
  prompt: string,
  bundleId: string,
  hooks: SynthHooks,
  deps: { llm: LlmPort; skills?: SkillCatalog },
): Promise<SynthesisBundle> {
  const invalid = fusionErrors(blueprints);
  if (invalid.length) throw new Error(invalid.join("; "));

  const skills = skillSession(SYNTH_SYSTEM, deps.skills, (message) => hooks.onStage("designing", message));
  let messages: ChatMessage[] = [{ role: "user", content: formatSynthRequest(blueprints, prompt) }];
  const call = () => {
    hooks.signal?.throwIfAborted();
    return deps.llm.structuredCall({
      role: "ui_synthesizer",
      ...skills.next(),
      messages,
      schema: SYNTH_DRAFT_SCHEMA,
      parse: (v) => SynthDraft.parse(v),
      effort: "medium",
      maxTokens: 48_000,
      signal: hooks.signal,
      onProgress: hooks.onProgress,
    });
  };

  hooks.onStage("designing", `Designing an app around ${blueprints.map((b) => b.spec.interface.module_name).join(" + ")}`);
  hooks.onStage("generating", "Generating React components…");
  let res = await call();

  for (let attempt = 0; ; attempt++) {
    const bundle = assembleBundle(blueprints, res.value.files, {
      bundle_id: bundleId, app_title: res.value.app_title, app_description: res.value.app_description, revision: 0, mode: "live",
    });
    hooks.onStage("validating", "Type-checking the bundle against the engines…");
    const v = validateBundle(bundle, blueprints);
    hooks.onValidation(v.ok, v.errors);
    if (v.ok) return bundle;
    if (attempt >= MAX_FIXES) throw new BundleValidationError(v.errors);

    hooks.onStage("fixing", `Fixing ${v.errors.length} problem(s): ${v.errors[0].slice(0, 120)}`);
    messages = deps.llm.continueWith(messages, res.assistantContent,
      `The app does not compile yet:\n<errors>\n${v.errors.join("\n")}\n</errors>\nReturn ALL your files again with the errors fixed. Remember: engines are fixed; adapt the UI to their exact interfaces.`);
    res = await call();
  }
}
