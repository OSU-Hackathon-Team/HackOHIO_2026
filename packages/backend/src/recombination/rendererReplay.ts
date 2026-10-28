import { z } from "zod";

export const RendererReplaySource = z.object({
  task: z.string(), archive_sha256: z.string().regex(/^[a-f0-9]{64}$/), workspace_root: z.string().min(1),
  summary: z.string().optional(), blockers: z.array(z.string()).default([]), model: z.string().optional(),
  requirements: z.array(z.object({ id: z.string(), statement: z.string().default(""), observation_ids: z.array(z.number().int()) })),
  observations: z.array(z.object({ id: z.number().int(), action: z.unknown(), result: z.unknown() })).max(1000),
});
export type RendererReplaySource = z.input<typeof RendererReplaySource>;

/** Compare a fresh original run without a model rewriting expectations after a mismatch. */
export async function replayRendererTrace(source: RendererReplaySource, workspace: string,
  initial: unknown, execute: (action: Record<string, unknown>) => Promise<unknown>,
  emit: (event: { type: string; [key: string]: unknown }) => void) {
  const checks: Array<{ observation_id: number; status: "passed" | "failed" | "not_compared"; fields: string[]; error?: string }> = [];
  const normalize = (value: unknown, root: string) => JSON.stringify(value)?.split(root).join("$WORKSPACE");
  for (const observation of source.observations) {
    const action = JSON.parse(JSON.stringify(observation.action).split(source.workspace_root).join(workspace)) as Record<string, unknown>;
    let actual: unknown;
    try {
      actual = action.action === "startup" ? initial : await execute(action);
      const expected = observation.result as Record<string, unknown>;
      const result = actual as Record<string, unknown>;
      const fields = ["title", "text", "rendered", "elements"].filter(field => field in expected);
      const differences = fields.filter(field => normalize(expected[field], source.workspace_root) !== normalize(result[field], workspace));
      const status = expected.error ? "not_compared" : result.error || differences.length ? "failed" : fields.length ? "passed" : "not_compared";
      checks.push({ observation_id: observation.id, status, fields, ...(status === "failed" ? { error: String(result.error ?? `Original replay differs in: ${differences.join(", ")}`) } : {}) });
    } catch (error) { checks.push({ observation_id: observation.id, status: "failed", fields: [], error: (error as Error).message }); }
    emit({ type: "replay_check", ...checks[checks.length - 1] });
  }
  const coverage = source.requirements.map(requirement => ({ id: requirement.id,
    verified_observation_ids: requirement.observation_ids.filter(id => checks.some(check => check.observation_id === id && check.status === "passed")),
  }));
  return { schema: 1, kind: "renderer_replay", archive_sha256: source.archive_sha256,
    status: checks.some(check => check.status === "failed") || !coverage.length || coverage.some(item => !item.verified_observation_ids.length) ? "failed" : "passed",
    checks, requirement_coverage: coverage, implementation_ready: false,
    limitations: ["This replays observed examples against the original; it is not held-out candidate verification or approval of requirement semantics"],
  };
}
