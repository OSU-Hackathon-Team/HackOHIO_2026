import { createHash } from "node:crypto";
import { SavedAnalysis, NativeExtractionPayload, NativeSubsystemSpec, type NativeExtractionRequest } from "@splice/contracts";
import { NativeDraft, nativeDraftProblems } from "./nativeDraft.js";
import { publicSpecContainsSource, sourceLikeText } from "./nativeSafety.js";

// Conservative input gate: retain omissions for the analyst instead of rewriting code-shaped facts.
const mechanics = /::|\b_Z[A-Za-z0-9_]+\b|\b(?:constructor|destructor|callee|register|stack slot|reference counting|memcpy|memmove|dereferenc\w*|quadword|bitfield)\b|\b(?:internal|object|memory) (?:field|buffer)|\b(?:pointer|offset)\b/i;

export class SavedEvidenceError extends Error {}

export function adaptSavedEvidence(raw: unknown, request: NativeExtractionRequest) {
  const analysis = SavedAnalysis.parse(raw);
  const selected = new Set(request.function_entries);
  for (const entry of selected) {
    if (!analysis.functions.some(fn => fn.entry === entry)) throw new SavedEvidenceError(`Function ${entry} is not in this saved analysis`);
  }
  const claim_sources: Array<{ id: string; function_entry: string; claim_index: number; statement: string; review_reason: string }> = [];
  const omitted_claims: Array<{ function_entry: string; claim_index: number; reason: string }> = [];
  analysis.functions.forEach((fn, functionIndex) => {
    if (selected.size && !selected.has(fn.entry)) return;
    fn.claims.forEach((claim, claimIndex) => {
      const reason = fn.review_state !== "reviewed" || claim.review?.outcome !== "supported_static"
        ? "Not independently supported by static review"
        : !claim.statement.trim() || sourceLikeText(claim.statement) || mechanics.test(claim.statement)
          ? "Contains implementation mechanics or source-like text" : null;
      if (reason) omitted_claims.push({ function_entry: fn.entry, claim_index: claimIndex, reason });
      else claim_sources.push({ id: `C${functionIndex + 1}_${claimIndex + 1}`, function_entry: fn.entry,
        claim_index: claimIndex, statement: claim.statement, review_reason: claim.review!.reason });
    });
  });
  if (!claim_sources.length) throw new SavedEvidenceError("No reviewed behavioral claims are available in this selection. Inspect the evidence or expand the analysis first.");
  const limitations = [
    "Static review supports these statements; claim-to-original-case links have not been established.",
    "Public observations are application-level context, not verified examples of the selected functions.",
    "Dependency, coverage and scope readiness have not been established by this extraction.",
  ];
  return { analysis, claim_sources, omitted_claims, limitations,
    analysis_sha256: createHash("sha256").update(JSON.stringify(analysis)).digest("hex"),
    input: {
      feature: request.intent.trim() || "Describe the supported observable behavior in these facts.",
      boundary: "subsystem", verified: false,
      // Function names, review prose and decompilation stay in the analyst record, outside the writer input.
      claims: claim_sources.map(({ id, statement }) => ({ id, statement })),
      original_examples: analysis.observed_cases.map(c => ({ name: c.id,
        input: { formula: c.formula, ...(c.cells ? { cells: c.cells } : { setup_unavailable: true }) }, expected_output: c.observed })),
      observation_limit: "Application observations are not linked to these facts. Do not infer new requirements from them.",
      excluded_behavior: [], deviations: [],
    },
  };
}

export function assembleSavedExtraction(prepared: ReturnType<typeof adaptSavedEvidence>, request: NativeExtractionRequest,
  answer: { draft: NativeDraft; model: string }, createdAt = Date.now()) {
  const draft = NativeDraft.parse(answer.draft);
  const problems = nativeDraftProblems(draft, prepared.claim_sources.map(c => c.id), prepared.input);
  if (problems.length) throw new Error(`Extracted specification failed validation: ${problems.join("; ")}`);
  const spec = NativeSubsystemSpec.parse({ ...draft, schema: 2, kind: "native_subsystem_spec", status: "draft", boundary: "subsystem",
    requirements: draft.requirements.map(({ id, statement }) => ({ id, statement })),
    // Application-level observations cannot become feature acceptance examples without validated links.
    examples: [] });
  if (publicSpecContainsSource(spec)) throw new Error("Extracted specification contains source-like text");
  return NativeExtractionPayload.parse({ schema: 1, analysis_id: prepared.analysis.id,
    analysis_sha256: prepared.analysis_sha256, created_at: createdAt, model: answer.model, intent: request.intent,
    spec, claim_sources: prepared.claim_sources, omitted_claims: prepared.omitted_claims,
    requirement_sources: draft.requirements.map(r => ({ requirement_id: r.id, claim_ids: r.claim_ids })),
    limitations: prepared.limitations });
}
