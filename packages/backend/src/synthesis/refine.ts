// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/04_refine_and_autofix.md §1-2
// Implementation notes: (1) changes accumulate across fix attempts — a fix that returns only the
// corrected file keeps the earlier edit to other files; (2) exhausted fixes throw
// BundleValidationError, so the caller keeps its previous working bundle.
import { z } from "zod";
import type { RefineRequest, SynthesisBundle } from "@splice/contracts";
import type { ChatMessage, LlmPort } from "../engine/ports.js";
import { FILE_SCHEMA, GeneratedFile, SYNTH_SYSTEM } from "./prompt.js";
import { assembleBundle, enginePath } from "./assemble.js";
import { validateBundle } from "./validateBundle.js";
import { BundleValidationError, MAX_FIXES, fusionErrors, type SynthHooks } from "./synthesize.js";
import { skillSession, type SkillCatalog } from "../skills/skills.js";

export const RefineDraft = z.object({
  summary: z.string().max(300),            // shown in the chat as the assistant's reply
  files: z.array(GeneratedFile).max(10),   // full content of every changed/new file
  delete_paths: z.array(z.string()),
});
export type RefineDraft = z.infer<typeof RefineDraft>;

export const REFINE_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    files: { type: "array", items: FILE_SCHEMA },
    delete_paths: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "files", "delete_paths"],
  additionalProperties: false,
} as const;

export const REFINE_SYSTEM = SYNTH_SYSTEM + `

# You are now EDITING an existing app
- You receive the current files you are allowed to change, the engines' interfaces, and either a user instruction or a runtime error.
- Return the FULL content of every file you change or add, plus delete_paths for files to remove. Do not return unchanged files.
- Keep everything that already works. Make the smallest change that fully satisfies the request.
- For a runtime error: find the root cause in the files and fix it; do not hide it with try/catch unless the error is genuinely expected.
- summary: one or two sentences, addressed to the user, describing what changed.`;

export function formatRefineRequest(req: RefineRequest): string {
  const editable = req.bundle.generated_paths
    .map((p) => `<file path="${p}">\n${req.bundle.files[p]}\n</file>`)
    .join("\n\n");
  const engines = req.blueprints
    .map((b) => `<engine module="${b.implementation.module_name}" path="/engines/${b.implementation.module_name}.ts">\n${b.spec.interface.types_code}\n</engine>`)
    .join("\n\n");
  const ask = req.kind === "fix"
    ? `<runtime_error>\n${req.runtime_error}\n</runtime_error>\nFix this error.`
    : `<user_request>\n${req.prompt}\n</user_request>`;
  return `${engines}\n\n${editable}\n\n${ask}`;
}

/** The request must refine the bundle built from exactly these verified engines. */
export function refineRequestErrors(req: RefineRequest): string[] {
  const errors = fusionErrors(req.blueprints);
  const ids = (xs: string[]) => [...xs].sort().join(",");
  if (ids(req.bundle.feature_ids) !== ids(req.blueprints.map((b) => b.feature_id))) {
    errors.push("blueprints do not match the bundle's features");
  }
  for (const b of req.blueprints) {
    if (req.bundle.files[enginePath(b)] !== b.implementation.portable_code) errors.push(`${enginePath(b)} in the bundle differs from its blueprint`);
  }
  if (req.kind === "fix" && !req.runtime_error?.trim()) errors.push(`kind "fix" needs runtime_error`);
  if (req.kind === "edit" && !req.prompt.trim()) errors.push(`kind "edit" needs a prompt`);
  return errors;
}

const withSlash = (p: string) => (p.startsWith("/") ? p : "/" + p);

export async function refine(
  req: RefineRequest,
  hooks: SynthHooks & { onSummary(summary: string): void },
  deps: { llm: LlmPort; skills?: SkillCatalog },
): Promise<SynthesisBundle> {
  const invalid = refineRequestErrors(req);
  if (invalid.length) throw new Error(invalid.join("; "));

  const skills = skillSession(REFINE_SYSTEM, deps.skills, (message) => hooks.onStage("generating", message));
  let messages: ChatMessage[] = [{ role: "user", content: formatRefineRequest(req) }];
  const call = () => {
    hooks.signal?.throwIfAborted();
    return deps.llm.structuredCall({
      role: "ui_synthesizer", ...skills.next(), messages, schema: REFINE_DRAFT_SCHEMA, parse: (v) => RefineDraft.parse(v),
      effort: "medium", maxTokens: 48_000, signal: hooks.signal, onProgress: hooks.onProgress,
    });
  };

  hooks.onStage("generating", req.kind === "fix" ? "Diagnosing the runtime error…" : "Applying your change…");
  let res = await call();

  const generated = new Map(req.bundle.generated_paths.map((p) => [p, req.bundle.files[p]]));
  for (let attempt = 0; ; attempt++) {
    for (const p of res.value.delete_paths.map(withSlash)) if (p !== "/App.tsx") generated.delete(p);
    for (const f of res.value.files) generated.set(withSlash(f.path), f.content);

    const bundle = assembleBundle(req.blueprints, [...generated].map(([path, content]) => ({ path, content })), {
      bundle_id: req.bundle.bundle_id,
      app_title: req.bundle.app_title,
      app_description: req.bundle.app_description,
      revision: req.bundle.revision + 1,
      mode: "live",
    });
    hooks.onStage("validating", "Type-checking…");
    const v = validateBundle(bundle, req.blueprints);
    hooks.onValidation(v.ok, v.errors);
    if (v.ok) {
      hooks.onSummary(res.value.summary);
      return bundle;
    }
    if (attempt >= MAX_FIXES) throw new BundleValidationError(v.errors);

    hooks.onStage("fixing", `Fixing ${v.errors.length} compile problem(s)…`);
    messages = deps.llm.continueWith(messages, res.assistantContent,
      `After your change the app does not compile:\n<errors>\n${v.errors.join("\n")}\n</errors>\nReturn the corrected files (full content).`);
    res = await call();
  }
}
