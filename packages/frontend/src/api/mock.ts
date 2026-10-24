import { FeatureSpec, FeatureBlueprint, SynthesisBundle, Pantry, NativeSubsystemSpec } from "@splice/contracts";
import type { Api } from "./client";
import manifest from "../../../../targets/manifest.json";
import sm2 from "../../../../fixtures/specs/_seed/recall.sm2_scheduler.json";
import links from "../../../../fixtures/specs/_seed/inkwell.wikilink_graph.json";
import sm2Blueprint from "../../../../fixtures/blueprints/_seed/recall.sm2_scheduler.json";
import linkBlueprint from "../../../../fixtures/blueprints/_seed/inkwell.wikilink_graph.json";
import studyRoom from "../../../../fixtures/bundles/_seed/study-room.json";

const mockHex64 = "0".repeat(64);
const mockNativeSpec: NativeSubsystemSpec = {
  schema: 1,
  kind: "native_subsystem_spec",
  campaign: mockHex64,
  binary_sha256: mockHex64,
  scope_id: mockHex64,
  scope_revision: 1,
  title: "Task Priority Scoring Subsystem (offline fixture)",
  status: "ready_for_review",
  boundary: {
    mode: "subsystem",
    included: [{ entry: "004012a0", name: "score_task_priority" }],
    boundaries: [],
    exclusions: [],
    unresolved_edges: [],
    expected_observables_to_investigate: ["priority score calculation"],
  },
  requirements: [
    {
      id: "REQ-1",
      subject: "004012a0",
      draft_artifact: mockHex64,
      claim_index: 0,
      statement: "Score must be non-negative and capped at 200.",
      evidence: [{ artifact: mockHex64, address: "004012a0" }],
      assumptions: [],
      alternatives: [],
      review_state: "supported_static",
      reviews: [{ outcome: "supported_static", model: "development-offline-fixture" }],
      execution_state: "case_agreement",
      probe_links: [{ case_id: "completed_zero", agreement: true }],
    },
    {
      id: "REQ-2",
      subject: "004012a0",
      draft_artifact: mockHex64,
      claim_index: 1,
      statement: "Completed tasks must evaluate to priority 0.",
      evidence: [{ artifact: mockHex64, address: "004012a8" }],
      assumptions: [],
      alternatives: [],
      review_state: "supported_static",
      reviews: [{ outcome: "supported_static", model: "development-offline-fixture" }],
      execution_state: "case_agreement",
      probe_links: [{ case_id: "completed_zero", agreement: true }],
    },
  ],
  function_descriptions: [
    {
      entry: "004012a0",
      name: "score_task_priority",
      draft_artifact: mockHex64,
      inputs: "TaskView* task, int64_t now_epoch",
      outputs: "int score",
      state: "stateless",
      side_effects: "none",
      errors: "clamped",
      unknowns: [],
      evidence_requests: [],
    },
  ],
  dependency_contracts: [],
  original_cases: [
    {
      case_id: "completed_zero",
      target: "score_task_priority",
      input: { completed: 1 },
      expected: 0,
      observed: 0,
      outcome: "agreement",
    },
  ],
  unresolved_claims: [],
  review_gaps: [],
  blockers: [],
  coverage: { claims: 2, supported_static: 2, case_agreements: 2 },
  provenance: {
    dossier_artifact: mockHex64,
    dossier_revision: 1,
    dossier_readiness: "partial",
    dossier_schema: 1,
    analysis: null,
    scope_artifact: mockHex64,
    draft_artifacts: [mockHex64],
    review_artifacts: [mockHex64],
    probe_report_artifacts: [mockHex64],
    probe_link_artifacts: [mockHex64],
    dependency_resolution_artifacts: [],
    gap_adjudication_artifacts: [],
    generator_sha256: mockHex64,
  },
};

import mockPrioritySpecJson from "../../../../fixtures/specs/_seed/mockpriority.priority_score.json";
import mockPriorityBpJson from "../../../../fixtures/blueprints/_seed/mockpriority.priority_score.json";

const mockPrioritySpec = FeatureSpec.parse(mockPrioritySpecJson);
const mockPriorityBlueprint = FeatureBlueprint.parse(mockPriorityBpJson);

const specs = [sm2, links, mockPrioritySpecJson].map(value => FeatureSpec.parse(value));
const blueprints = [sm2Blueprint, linkBlueprint, mockPriorityBpJson].map(value => FeatureBlueprint.parse(value));
const bundle = SynthesisBundle.parse(studyRoom);
let sequence = 0;
async function pause(signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 180);
    signal?.addEventListener("abort", abort, { once: true });
  });
  signal?.throwIfAborted();
}
export const mockApi: Api = {
  async health() { return { ok: true, rea: { connected: false, version: null, tool_count: 0 }, rea_mode: "replay", llm_mode: "replay", model: "authored-development-seed", models: {} }; },
  async pantry() { return Pantry.parse(manifest); },
  async extract(_appId, featureId, on, signal) {
    const spec = specs.find(s => s.feature_id === featureId);
    if (!spec) throw new Error(`No development seed for ${featureId}. Only wiki links and SM-2 are available in this milestone.`);
    const run_id = `development-${++sequence}`;
    await pause(signal);
    on({ type: "stage", run_id, feature_id: featureId, ts: Date.now(), stage: "specifying", message: "Development data: loading an authored specification; REA and oracle are not running." });
    await pause(signal);
    on({ type: "spec", run_id, feature_id: featureId, ts: Date.now(), spec });
    on({ type: "done", run_id, feature_id: featureId, ts: Date.now(), ok: true, replayed: true });
  },
  async implement(spec, on, signal) {
    const blueprint = blueprints.find(b => b.feature_id === spec.feature_id);
    if (!blueprint) throw new Error("No locally checked development engine for this feature.");
    const run_id = `development-${++sequence}`, base = { run_id, feature_id: spec.feature_id };
    await pause(signal);
    on({ type: "stage", ...base, ts: Date.now(), stage: "implementing", message: "Development data: loading stored local seed-check results; no model call." });
    await pause(signal);
    for (const t of blueprint.verification.tests) on({ type: "test_result", ...base, ts: Date.now(), name: t.name, kind: "acceptance", passed: t.passed, error: t.error });
    on({ type: "blueprint", ...base, ts: Date.now(), blueprint });
    on({ type: "done", ...base, ts: Date.now(), ok: true, replayed: true });
  },
  async synthesize(selected, _prompt, on, signal) {
    if (JSON.stringify(selected.map(b => b.feature_id).sort()) !== JSON.stringify([...bundle.feature_ids].sort())) throw new Error("The authored study-room demo requires both wiki links and SM-2. Arbitrary generation requires the live backend.");
    const run_id = `development-${++sequence}`;
    on({ type: "stage", run_id, ts: Date.now(), stage: "generating", message: "Loading the authored study-room example; no model generation." });
    await pause(signal);
    on({ type: "bundle", run_id, ts: Date.now(), bundle: { ...bundle, bundle_id: run_id } });
    on({ type: "done", run_id, ts: Date.now(), ok: true });
  },
  async refine(req, on, signal) {
    const run_id = `development-${++sequence}`;
    on({
      type: "stage",
      run_id,
      ts: Date.now(),
      stage: "generating",
      message:
        req.kind === "fix"
          ? "Development demo: repairing preview error..."
          : `Development demo: applying edit "${req.prompt}"...`,
    });
    await pause(signal);
    const updatedBundle: SynthesisBundle = {
      ...req.bundle,
      revision: req.bundle.revision + 1,
    };
    on({ type: "bundle", run_id, ts: Date.now(), bundle: updatedBundle });
    on({
      type: "stage",
      run_id,
      ts: Date.now(),
      stage: "complete",
      message: req.kind === "fix" ? "Repaired runtime preview error." : `Applied: ${req.prompt}`,
    });
    on({ type: "done", run_id, ts: Date.now(), ok: true });
  },
  async blueprints() {
    return blueprints;
  },
  async nativeSpec(dossierArtifact) {
    await pause();
    return {
      artifact: mockHex64,
      spec: {
        ...mockNativeSpec,
        provenance: {
          ...mockNativeSpec.provenance,
          dossier_artifact: dossierArtifact || mockHex64,
        },
      },
    };
  },
  async getNativeSpec(_artifact) {
    await pause();
    return mockNativeSpec;
  },
  async listNativeSpecs() {
    return [{ artifact: mockHex64, spec: mockNativeSpec }];
  },
  async adaptNativeSpec(req) {
    await pause();
    return {
      ...mockPrioritySpec,
      feature_id: req.feature_id ?? mockPrioritySpec.feature_id,
    };
  },
};


