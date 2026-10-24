import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const record = z.record(z.unknown());

export const NativeSpecRequirement = z.object({
  id: z.string().regex(/^REQ-\d+$/),
  subject: z.string(),
  draft_artifact: digest,
  claim_index: z.number().int().nonnegative(),
  statement: z.string(),
  evidence: z.array(z.object({ artifact: digest, address: z.string() })).min(1),
  assumptions: z.array(z.union([z.string(), record])),
  alternatives: z.array(z.union([z.string(), record])),
  review_state: z.literal("supported_static"),
  reviews: z.array(record).min(1),
  execution_state: z.enum(["unmapped", "case_agreement", "case_disagreement"]),
  probe_links: z.array(record),
});
export type NativeSpecRequirement = z.infer<typeof NativeSpecRequirement>;

export const NativeSubsystemSpec = z.object({
  schema: z.literal(1),
  kind: z.literal("native_subsystem_spec"),
  campaign: digest,
  binary_sha256: digest,
  scope_id: digest,
  scope_revision: z.number().int().positive(),
  title: z.string(),
  status: z.enum(["partial", "ready_for_review"]),
  boundary: z.object({
    mode: z.enum(["subsystem", "project"]),
    included: z.array(record),
    boundaries: z.array(record),
    exclusions: z.array(record),
    unresolved_edges: z.array(record),
    expected_observables_to_investigate: z.array(z.string()),
  }),
  requirements: z.array(NativeSpecRequirement),
  function_descriptions: z.array(record),
  dependency_contracts: z.array(record),
  original_cases: z.array(record),
  unresolved_claims: z.array(record),
  review_gaps: z.array(record),
  blockers: z.array(record),
  coverage: record,
  provenance: z.object({
    dossier_artifact: digest,
    dossier_revision: z.number().int().positive(),
    dossier_readiness: z.enum(["partial", "ready_for_spec", "blocked"]),
    dossier_schema: z.literal(1),
    analysis: z.object({ drafts: z.array(record), reviews: z.array(record) }).nullable(),
    scope_artifact: digest,
    draft_artifacts: z.array(digest),
    review_artifacts: z.array(digest),
    probe_report_artifacts: z.array(digest),
    probe_link_artifacts: z.array(digest),
    dependency_resolution_artifacts: z.array(digest),
    gap_adjudication_artifacts: z.array(digest),
    generator_sha256: digest,
  }),
});
export type NativeSubsystemSpec = z.infer<typeof NativeSubsystemSpec>;
