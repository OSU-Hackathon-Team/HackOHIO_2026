import { z } from "zod";
import {
  DiscoveredCapability, MAX_DISCOVERED_CAPABILITIES, NativeExtractionRequest, UnassignedClaim,
  type DiscoveryCandidate, type NativeDiscoveryEvent, type NativeExtraction, type SavedAnalysis,
} from "@splice/contracts";
import { continueWith, formatLlmError, LlmSchemaError } from "../llm/llm.js";
import { writeDraft } from "./writeDraft.js";
import { writeNativeDraft } from "./nativeDraft.js";
import { sourceLikeMatch } from "./nativeSafety.js";
import { adaptSavedEvidence, assembleSavedExtraction, SavedEvidenceError } from "./savedEvidence.js";

// Oversized evidence is rejected before model work rather than silently truncated.
export const MAX_DISCOVERY_CLAIMS = 300;
export const MAX_DISCOVERY_INPUT_CHARS = 60_000;
export const DISCOVERY_ATTEMPTS = 2;

export const DiscoveryAnswer = z.object({
  explanation: z.string(),
  capabilities: z.array(DiscoveredCapability),
  unassigned: z.array(UnassignedClaim),
});
export type DiscoveryAnswer = z.infer<typeof DiscoveryAnswer>;

const string = { type: "string" } as const;
const DISCOVERY_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    explanation: string,
    capabilities: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { id: string, name: string, purpose: string, claim_ids: { type: "array", items: string } },
      required: ["id", "name", "purpose", "claim_ids"] } },
    unassigned: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { claim_id: string, disposition: { type: "string", enum: ["supporting_only", "insufficient", "deferred"] }, reason: string },
      required: ["claim_id", "disposition", "reason"] } },
  },
  required: ["explanation", "capabilities", "unassigned"],
} as const;

const SYSTEM = `You are Splice's capability analyst. You receive reviewed behavioral facts recovered from a
native application, each with a stable ID, arranged in opaque groups. A group only means the facts
came from the same place; it does not imply that groups run in order, depend on each other or combine.
Identify at most ${MAX_DISCOVERED_CAPABILITIES} reusable capabilities that another application could adopt as a building block.
Prefer a few substantial capabilities over an exhaustive catalog. Facts from several groups may form one
capability, and a fact may support more than one capability when that is genuinely justified.
For each capability give id CAP-1 onward without gaps, a short product-style name (at most 80 characters),
a one or two sentence purpose (at most 400 characters) and the claim_ids that support it.
Do not propose two capabilities with the same set of facts or the same name.
Account for every supplied fact exactly once: either cite it in at least one capability, or list it in
unassigned with disposition supporting_only (context that only helps other facts), insufficient (too
weak or isolated for a feature) or deferred (useful but outside the chosen capabilities), and a short reason.
Do not infer execution order, dependencies or combined behavior that the facts do not state.
Return zero capabilities when the facts cannot support a useful feature, and then say why in explanation.
Otherwise explanation is one sentence summarizing the selection.
Write plain prose. Never write source code, symbols, addresses, key=value text or newlines, and do
not use semicolons, braces, backticks or equals signs.
Return only schema-shaped JSON.`;

/** Prose semicolons carry no source; joining clauses with commas keeps the remaining safety checks meaningful. */
export function tidyAnswer(answer: DiscoveryAnswer): DiscoveryAnswer {
  const prose = (value: string) => value.replace(/\s*;\s*/g, ", ").trim();
  return { explanation: prose(answer.explanation),
    capabilities: answer.capabilities.map(c => ({ ...c, name: prose(c.name), purpose: prose(c.purpose) })),
    unassigned: answer.unassigned.map(u => ({ ...u, reason: prose(u.reason) })) };
}

export type PreparedDiscovery = ReturnType<typeof prepareDiscovery>;

export function prepareDiscovery(raw: unknown) {
  const prepared = adaptSavedEvidence(raw, NativeExtractionRequest.parse({ confirm_cost: true }));
  if (prepared.claim_sources.length > MAX_DISCOVERY_CLAIMS) {
    throw new SavedEvidenceError(`This analysis has ${prepared.claim_sources.length} supported facts; discovery accepts at most ${MAX_DISCOVERY_CLAIMS}. Nothing was sent to a model.`);
  }
  // Opaque groups keep function names, addresses and review prose out of the discovery input.
  const groups: { group: string; claims: { id: string; statement: string }[] }[] = [];
  const byEntry = new Map<string, (typeof groups)[number]>();
  for (const claim of prepared.claim_sources) {
    let group = byEntry.get(claim.function_entry);
    if (!group) { group = { group: `G${groups.length + 1}`, claims: [] }; groups.push(group); byEntry.set(claim.function_entry, group); }
    group.claims.push({ id: claim.id, statement: claim.statement });
  }
  const input = { groups, limit: MAX_DISCOVERED_CAPABILITIES };
  const size = JSON.stringify(input).length;
  if (size > MAX_DISCOVERY_INPUT_CHARS) {
    throw new SavedEvidenceError(`The supported facts total ${size.toLocaleString("en-US")} characters; discovery accepts at most ${MAX_DISCOVERY_INPUT_CHARS.toLocaleString("en-US")}. Nothing was sent to a model.`);
  }
  return { ...prepared, discovery_input: input };
}

function unsafe(field: string, value: string): string | null {
  const match = sourceLikeMatch(value) ?? (value.includes("\n") ? "newline" : null);
  return match ? `source-like content in ${field}: ${JSON.stringify(match.slice(0, 60))}` : null;
}

export function discoveryProblems(answer: DiscoveryAnswer, eligible: string[]): string[] {
  const errors: string[] = [];
  const known = new Set(eligible), assigned = new Set<string>(), sets = new Set<string>(), names = new Set<string>();
  if (answer.capabilities.length > MAX_DISCOVERED_CAPABILITIES) errors.push(`at most ${MAX_DISCOVERED_CAPABILITIES} capabilities are allowed`);
  answer.capabilities.forEach((capability, index) => {
    if (capability.id !== `CAP-${index + 1}`) errors.push(`capability ${index + 1} has wrong ID`);
    const name = capability.name.trim().toLowerCase();
    if (names.has(name)) errors.push(`${capability.id} repeats the name ${JSON.stringify(capability.name)}`);
    names.add(name);
    if (new Set(capability.claim_ids).size !== capability.claim_ids.length) errors.push(`${capability.id} cites a fact twice`);
    for (const id of capability.claim_ids) {
      if (!known.has(id)) errors.push(`${capability.id} cites invented fact ${id}`);
      else assigned.add(id);
    }
    const key = [...new Set(capability.claim_ids)].sort().join(",");
    if (sets.has(key)) errors.push(`${capability.id} duplicates another capability's facts`);
    sets.add(key);
    for (const [field, value] of [["name", capability.name], ["purpose", capability.purpose]] as const) {
      const problem = unsafe(`${capability.id}.${field}`, value);
      if (problem) errors.push(problem);
    }
  });
  const recorded = new Set<string>();
  for (const item of answer.unassigned) {
    if (!known.has(item.claim_id)) errors.push(`unassigned lists invented fact ${item.claim_id}`);
    else if (assigned.has(item.claim_id)) errors.push(`fact ${item.claim_id} is both assigned and unassigned`);
    else if (recorded.has(item.claim_id)) errors.push(`fact ${item.claim_id} is unassigned twice`);
    recorded.add(item.claim_id);
    const problem = unsafe(`unassigned ${item.claim_id}.reason`, item.reason);
    if (problem) errors.push(problem);
  }
  for (const id of eligible) if (!assigned.has(id) && !recorded.has(id)) errors.push(`fact ${id} is not accounted for`);
  if (!answer.capabilities.length && !answer.explanation.trim()) errors.push("explain why no capability is supported");
  const problem = unsafe("explanation", answer.explanation);
  if (problem) errors.push(problem);
  return errors;
}

export async function discoverCapabilities(input: PreparedDiscovery["discovery_input"], eligible: string[],
  hooks: { signal?: AbortSignal; onProgress?: (chars: number) => void } = {}): Promise<{ answer: DiscoveryAnswer; model: string }> {
  let messages: Parameters<typeof writeDraft>[0]["messages"] = [{ role: "user", content: JSON.stringify(input) }];
  for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt++) {
    hooks.signal?.throwIfAborted();
    let result;
    try {
      result = await writeDraft({ system: SYSTEM, messages, schema: DISCOVERY_SCHEMA,
        parse: (value) => tidyAnswer(DiscoveryAnswer.parse(value)), maxTokens: 8_192, signal: hooks.signal, onProgress: hooks.onProgress });
    } catch (error) {
      if (!(error instanceof LlmSchemaError) || attempt === DISCOVERY_ATTEMPTS - 1) throw error;
      messages = [{ role: "user", content: `${JSON.stringify(input)}\n\nThe previous answer failed schema validation: ${error.message}. Return every required field with valid types.` }];
      continue;
    }
    const problems = discoveryProblems(result.value, eligible);
    if (!problems.length) return { answer: result.value, model: result.model };
    if (attempt === DISCOVERY_ATTEMPTS - 1) throw new Error(`capability discovery failed validation: ${problems.join("; ")}`);
    messages = continueWith(messages, result.assistantContent,
      `Repair the complete answer: ${problems.join("; ")}. Account for every fact exactly once and use plain prose.`);
  }
  throw new Error("capability discovery failed validation");
}

/** The adapter's prepared evidence narrowed to one capability, so the writer must cover exactly its facts. */
export function preparedForCapability(prepared: PreparedDiscovery, capability: DiscoveredCapability) {
  const ids = new Set(capability.claim_ids);
  const claim_sources = prepared.claim_sources.filter(claim => ids.has(claim.id));
  return { ...prepared, claim_sources, input: { ...prepared.input,
    feature: `${capability.name}. ${capability.purpose}`,
    claims: claim_sources.map(({ id, statement }) => ({ id, statement })) } };
}

const DISCOVERY_LIMITATIONS = [
  "Capabilities are model proposals over statically reviewed facts; they do not establish execution order, dependencies or combined behavior.",
];

export interface DiscoveryDeps {
  discover: typeof discoverCapabilities;
  writer: typeof writeNativeDraft;
  saveExtraction: (payload: unknown, snapshot: SavedAnalysis) => Promise<NativeExtraction>;
  /** Aborts on cancellation or the overall deadline; its reason explains which. */
  signal: AbortSignal;
  /** Aborted only when the user cancels, so cancellation is reported distinctly from a timeout. */
  cancelled: AbortSignal;
  draftTimeoutMs: number;
  emit: (event: NativeDiscoveryEvent) => void;
  now?: () => number;
}

const reason = (signal: AbortSignal) => String((signal.reason as Error | undefined)?.message ?? "Discovery cancelled");

/** Discovers capabilities, then writes and saves one draft per capability. Returns the report payload to persist. */
export async function runDiscovery(prepared: PreparedDiscovery, deps: DiscoveryDeps) {
  const now = deps.now ?? Date.now;
  const eligible = prepared.claim_sources.map(claim => claim.id);
  const base = { schema: 1 as const, analysis_id: prepared.analysis.id, analysis_sha256: prepared.analysis_sha256,
    eligible_claims: eligible.length, omitted_claims: prepared.omitted_claims.length,
    limitations: [...prepared.limitations, ...DISCOVERY_LIMITATIONS] };
  deps.emit({ type: "stage", message: `Reviewing evidence: ${eligible.length} supported facts from ${prepared.discovery_input.groups.length} functions` });
  deps.emit({ type: "stage", message: "Identifying capabilities" });
  let discovered;
  try {
    discovered = await deps.discover(prepared.discovery_input, eligible, { signal: deps.signal,
      onProgress: output_chars => deps.emit({ type: "progress", output_chars }) });
    deps.signal.throwIfAborted();
  } catch (error) {
    const message = deps.signal.aborted ? reason(deps.signal) : formatLlmError(error);
    return { ...base, created_at: now(), model: null, status: deps.cancelled.aborted ? "cancelled" as const : "failed" as const,
      explanation: "", capabilities: [], unassigned: [], candidates: [], error: message };
  }
  const { answer, model } = discovered;
  deps.emit({ type: "capabilities", capabilities: answer.capabilities, unassigned: answer.unassigned, explanation: answer.explanation });
  const candidates: DiscoveryCandidate[] = [];
  for (const [index, capability] of answer.capabilities.entries()) {
    if (deps.signal.aborted) {
      candidates.push({ capability_id: capability.id, status: "not_attempted", reason: reason(deps.signal) });
      continue;
    }
    deps.emit({ type: "stage", message: `Writing draft ${index + 1} of ${answer.capabilities.length}: ${capability.name}` });
    const draftTimeout = new AbortController();
    const timer = setTimeout(() => draftTimeout.abort(new Error("Draft exceeded its three-minute limit")), deps.draftTimeoutMs);
    const draftSignal = AbortSignal.any([deps.signal, draftTimeout.signal]);
    const narrowed = preparedForCapability(prepared, capability);
    const request = NativeExtractionRequest.parse({ confirm_cost: true, intent: narrowed.input.feature });
    try {
      const written = await deps.writer(narrowed.input, { signal: draftSignal,
        onProgress: output_chars => deps.emit({ type: "progress", output_chars }) });
      draftSignal.throwIfAborted();
      const record = await deps.saveExtraction(assembleSavedExtraction(narrowed, request, written, now()), prepared.analysis);
      candidates.push({ capability_id: capability.id, status: "saved", extraction_id: record.id });
      deps.emit({ type: "draft", capability_id: capability.id, extraction: record });
    } catch (error) {
      // One failed draft never discards the drafts already saved or stops the remaining candidates.
      const message = deps.signal.aborted ? reason(deps.signal)
        : draftSignal.aborted ? "Draft exceeded its three-minute limit" : formatLlmError(error);
      candidates.push({ capability_id: capability.id, status: "failed", error: message });
      deps.emit({ type: "candidate_failed", capability_id: capability.id, message });
    } finally { clearTimeout(timer); }
  }
  const saved = candidates.filter(candidate => candidate.status === "saved").length;
  const status = deps.cancelled.aborted ? "cancelled" as const
    : !answer.capabilities.length ? "empty" as const
    : saved === answer.capabilities.length ? "complete" as const
    : saved ? "partial" as const : "failed" as const;
  return { ...base, created_at: now(), model, status, explanation: answer.explanation,
    capabilities: answer.capabilities, unassigned: answer.unassigned, candidates,
    error: deps.signal.aborted ? reason(deps.signal) : null };
}
