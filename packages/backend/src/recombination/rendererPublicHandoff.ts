import { z } from "zod";
import { RendererReplaySource } from "./rendererReplay.js";

const ReplayReport = z.object({
  schema: z.literal(1),
  kind: z.literal("renderer_replay"),
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["passed", "failed"]),
  checks: z.array(z.object({
    observation_id: z.number().int(), status: z.enum(["passed", "failed", "not_compared"]),
    fields: z.array(z.string()), error: z.string().optional(),
  })),
  requirement_coverage: z.array(z.object({ id: z.string(), verified_observation_ids: z.array(z.number().int()) })),
  implementation_ready: z.boolean(),
  limitations: z.array(z.string()),
});

const privatePath = /(?:file:\/\/)?\/(?:home|tmp|mnt|opt|usr|var|root|workspace)[^\s"'<>)]*/g;
const windowsPath = /\b[A-Z]:\\(?:[^\s"'<>)]*\\?)*[^\s"'<>)]*/gi;

function publicText(value: unknown, workspaceRoot: string, limit = 20_000): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(workspaceRoot).join("$WORKSPACE")
    .replace(privatePath, "$LOCAL_PATH")
    .replace(windowsPath, "$LOCAL_PATH")
    .slice(0, limit);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function publicAction(value: unknown, workspaceRoot: string) {
  const action = object(value);
  if (action.action === "capture_case") return { kind: "renderer_case", case_id: action.case_id,
    input_markdown: publicText(action.value, workspaceRoot, 100_000) };
  if (typeof action.fixture === "string") {
    const relative = action.fixture.replaceAll("\\", "/").split("/").filter(part => part && part !== "." && part !== "..").join("/");
    return {
      kind: "fixture_input",
      path: relative.slice(0, 300),
      ...(typeof action.content === "string" ? { content: publicText(action.content, workspaceRoot, 100_000) } : {}),
      ...(typeof action.directory === "boolean" ? { directory: action.directory } : {}),
    };
  }
  if (action.host_input !== undefined) {
    const host = object(action.host_input);
    return { kind: "native_dialog_action", action: publicText(host.action, workspaceRoot, 80) ?? "unknown" };
  }
  return {
    kind: "ui_action",
    ...(typeof action.action === "string" ? { action: publicText(action.action, workspaceRoot, 80) } : {}),
    ...(typeof action.selector === "string" ? { selector: publicText(action.selector, workspaceRoot, 300) } : {}),
    ...(typeof action.value === "string" ? { value: publicText(action.value, workspaceRoot, 10_000) } : {}),
    ...(typeof action.content === "string" ? { content: publicText(action.content, workspaceRoot, 100_000) } : {}),
  };
}

function publicObservationResult(value: unknown, workspaceRoot: string) {
  const result = object(value);
  const output: Record<string, string> = {};
  for (const field of ["title", "text", "rendered", "elements", "error"] as const) {
    const sanitized = publicText(result[field], workspaceRoot, field === "rendered" || field === "elements" ? 20_000 : 10_000);
    if (sanitized !== undefined && sanitized.length) output[field] = sanitized;
  }
  return output;
}

/** Build a source-free, path-redacted draft handoff from a replayed UI trace. */
export function buildRendererPublicHandoff(discoveryId: string, rawSource: unknown, rawReplay: unknown) {
  const sourceEnvelope = object(rawSource);
  if (sourceEnvelope.schema !== 1 || sourceEnvelope.status !== "draft")
    throw new Error("Public handoff requires a saved renderer discovery draft");
  const source = RendererReplaySource.parse(rawSource);
  const replay = ReplayReport.parse(rawReplay);
  if (replay.status !== "passed" || replay.implementation_ready)
    throw new Error("Public handoff requires a passed original replay; replay does not approve implementation readiness");
  if (source.archive_sha256 !== replay.archive_sha256)
    throw new Error("Discovery and replay archive identities do not match");

  const checkById = new Map(replay.checks.map(check => [check.observation_id, check]));
  const coverageById = new Map(replay.requirement_coverage.map(item => [item.id, item]));
  const observationById = new Map(source.observations.map(observation => [observation.id, observation]));
  const citedIds = new Set<number>();
  const requirements = source.requirements.map(requirement => {
    const coverage = coverageById.get(requirement.id);
    const verifiedIds = new Set(coverage?.verified_observation_ids ?? []);
    const citations = requirement.observation_ids.map(id => {
      citedIds.add(id);
      const observation = observationById.get(id);
      if (!observation) throw new Error(`${requirement.id} references missing observation ${id}`);
      return { observation_id: id, replay_status: checkById.get(id)?.status ?? "not_compared" };
    });
    if (!citations.some(citation => verifiedIds.has(citation.observation_id) && citation.replay_status === "passed"))
      throw new Error(`${requirement.id} has no cited observation confirmed by the original replay`);
    return {
      id: requirement.id,
      statement: publicText(requirement.statement, source.workspace_root, 4_000) ?? "",
      citations,
    };
  });

  const observations = [...citedIds].sort((a, b) => a - b).map(id => {
    const observation = observationById.get(id)!;
    return {
      observation_id: id,
      replay_status: checkById.get(id)?.status ?? "not_compared",
      action: publicAction(observation.action, source.workspace_root),
      observed_output: publicObservationResult(observation.result, source.workspace_root),
    };
  });
  const cases = source.observations.flatMap(observation => {
    const action = object(observation.action), result = object(observation.result);
    if (action.action !== "capture_case" || result.input_verified !== true || !citedIds.has(observation.id) || checkById.get(observation.id)?.status !== "passed") return [];
    if (typeof action.value !== "string" || typeof result.rendered !== "string" || typeof action.case_id !== "string")
      throw new Error("Renderer case has incomplete original evidence");
    const input = publicText(action.value, source.workspace_root, 100_000);
    const output = publicText(result.rendered, source.workspace_root, 100_000);
    if (input !== action.value || output !== result.rendered) throw new Error("Renderer case contains local paths or exceeds the public evidence limit");
    return [{ case_id: action.case_id, observation_id: observation.id, input_markdown: input, expected_html: output,
      input_verification: result.input_verification === "saved_document" ? "saved_document" : "editor_dom",
      output_projection: "sanitized_document_dom_v1" }];
  });

  return {
    schema: 1,
    kind: "renderer_public_handoff",
    status: "draft",
    implementation_ready: false,
    discovery_id: discoveryId,
    objective: publicText(source.task, source.workspace_root, 4_000) ?? "",
    provenance: {
      basis: "Original-app UI observations replayed against the same packaged application archive",
      archive_sha256: source.archive_sha256,
      replay_status: replay.status,
      replayed_observations: replay.checks.filter(check => check.status === "passed").length,
      cited_observations: observations.length,
      limitations: [
        "This artifact contains observed examples, not candidate implementation results or held-out checks.",
        "A passed original replay confirms trace repeatability; it does not approve requirement semantics or implementation readiness.",
        ...(cases.length ? ["Captured DOM omits script, style and SVG nodes, event attributes and inline styles; these cases do not establish pixel parity or omitted markup behavior."] : []),
      ],
    },
    requirements,
    observations,
    cases,
  };
}
