# Subsystem decompilation engine implementation plan

Status: implementation in progress; all milestone acceptance gates remain open.
Updated: 2026-10-24.
Architecture and decision rationale: [DecompPileline.md](DecompPileline.md).

## Current execution boundary

The user resumed the native specification handoff on 2026-10-24 after an end-to-end run
exposed an unsafe schema 1 report-style artifact. M5 work may now proceed for a bounded,
ready dossier. Partial dossiers, including the reported telemetry revision, must not
publish an implementer spec. The downstream implementation and campaign/job API remain
separate acceptance work.

The public spec is a behavioral instruction document. The evidence dossier and audit
artifact stay analyst-side. A separate implementer receives only the public schema 2
artifact and may not browse the dossier, binary, disassembly, raw source, review notes,
or audit artifact. This separation is a workflow control, not a legal conclusion.

## Required outcome

- Support at least 16 concurrently leased reasoning tasks, with a path to multiple hosts.
- Optimize for subsystem scope; support project-wide campaigns through shared subsystem work.
- Deliver readable, evidence-backed behavior sufficient to write a specification.
- Never require reconstructed C to compile or all variables to be renamed.
- Preserve uncertainty, partial results, and recovery state through failures.

The first end-to-end acceptance run must produce a subsystem dossier with traceable claims,
independently checked behavior, and successful recovery after a worker is killed during a
16-worker campaign. Scale and quality are separate gates: occupied workers alone do not pass.

## Implementation boundaries

Keep the current rename command as an integration diagnostic. Introduce the engine in a
Python package and expose orchestration through `launch.py`; retain `model_config.py` as the
role resolver. A future API client may consume engine job state after contract work.
Use PostgreSQL for tasks, attempts, claims, dependency indexes, and outbox events. Begin with
local immutable artifacts behind a storage interface, then add shared storage for remote workers.

Engine layout (some components are still planned):

```text
engine/
  models.py             # internal records and validation (implemented)
  intake.py             # module inventory and static symbol candidates (implemented)
  project_scope.py      # bounded scopes across candidate module calls (implemented)
  project_queue.py      # module task registration, baseline validation, project progress (implemented)
  artifacts.py          # immutable local artifacts (implemented)
  analysis/             # Ghidra evidence and local warm pool (implemented; M1 gate open)
  scope.py              # seed discovery and bounded expansion (implemented)
  queue.py              # leases, retries, fencing, deduplication (implemented)
  worker.py             # bounded semantic analysis and checkpoints (implemented)
  findings.py           # conditional publication and invalidation (implemented)
  validation/           # static review, dependency checks, original probes (implemented)
  dossier.py            # immutable assembly and readable rendering (implemented)
  service.py            # job API and event delivery (planned)
migrations/             # PostgreSQL schema migrations
scripts/                # independent CLI checks and benchmarks
fixtures/decomp/        # source-known evaluation targets and expected behavior
```

Avoid a graph database, custom workflow platform, full project merging on every result,
and a second implementation of scheduling in the web backend. Introduce infrastructure only
when the corresponding milestone demonstrates its need.

## Proposed data records

These are design requirements, not all implemented records. Implement internal schemas
first. The native public spec has a versioned schema 2 contract; the broader campaign/job
API records remain planned.

| Record | Required information |
| --- | --- |
| Campaign | Input/module manifest hashes, analysis configuration, budgets, state |
| ScopeRequest | Mode, query, seeds, explicit inclusions/exclusions, expected observables |
| ScopeRevision | Entries, included entities, boundary contracts, unresolved edges, expansion reasons |
| EvidenceArtifact | Hash, kind, module/function identity, analysis revision, address/line mapping, tool provenance, omissions |
| AnalysisTask | Scope/question, subject entities, priority, deduplication key, dependencies, pinned versions, budget |
| Attempt | Task ID, worker identity, lease epoch, deadlines, model/runtime versions, usage, checkpoints, terminal reason |
| BehaviorClaim | Statement, subject, evidence refs, assumptions, dependencies, alternatives, review and probe records |
| DependencyContract | Interface, relevant effects, preconditions, evidence, version, known limitations |
| ProbeResult | Original target identity, input/state/environment, adapter/harness version, expected and observed output, outcome |
| SubsystemDossier | Scope/claim versions, contracts, pseudocode, state/effects/errors, examples, coverage inventory, blockers, readiness |

Use separate dimensions for review, evidence support, probe execution, and readiness. Proposed
readiness values: `partial`, `ready_for_spec`, `blocked`. Campaign outcomes also distinguish
`completed`, `budget_exhausted`, `stalled`, and infrastructure failure. These must not collapse
into one unqualified `verified` boolean.

## M0 — Establish evidence and quality baselines

Deliverables:

- Record current rename startup/import/verification time and resource use.
- Create small source-known native fixtures: arithmetic boundaries, shared mutable state,
  structs/aliasing, recursion, callbacks, initialization, and error paths.
- Build stripped binaries with multiple optimization settings. Keep source/debug metadata
  available to evaluators and unavailable to analysis workers.
- Define the expected observable behaviors and independently held-out probe cases.
- Define a small subsystem, a subsystem with at least 16 useful tasks, and a project-wide case.

Acceptance:

- A repeatable CLI run records input hashes, versions, elapsed time, peak memory, and outputs.
- Evaluation distinguishes incorrect claims, missing behavior, and unsupported claims.
- Baseline report clearly labels static inspection versus executed verification.

## M1 — Analyze once and export reusable evidence

Depends on M0.

Deliverables:

- Campaign/module identity and configuration-aware import cache.
- Function/string/import/reference index and scoped decompilation requests.
- Executable-region, unassigned-instruction, and unclassified-byte inventory, so
  discovered-function export coverage does not conceal code outside known function bodies.
- Bounded immutable evidence for executable gaps, including raw bytes, classifications,
  incoming references, and symbol context.
- Immutable evidence exports with native address mappings and explicit omission/error records.
- Multi-module export inventory with per-module completion and unresolved code regions.
- Warm analysis service with bounded concurrency, per-operation timeouts, and restart handling.
- Narrow engine-owned read interfaces: inspect function, references, data/types, and evidence.
  These are wrapper contracts; discover actual backend tools instead of inventing tool names.

Acceptance:

- Multiple requests for the same binary/configuration reuse the analyzed baseline.
- Repeat function requests reuse identical evidence artifacts.
- Concurrent calls do not mix programs or sessions; a hung function does not lose other results.
- Toolchain/options changes create distinct cache entries.
- Type/prototype experiments use an isolated closed snapshot and cannot alter baseline evidence.

## M2 — Scope discovery and one useful semantic worker

Depends on M1.

Deliverables:

- Scope request/revision records and seed ranking.
- Project requests that generate bounded module scopes and retain candidate cross-module
  bindings as unresolved questions.
- Durable registration, shared-pool semantic draining, and status for all module tasks reached
  by a project scope.
- Bounded expansion through calls, data, callers, initialization, and callbacks.
- Behavioral task schema and prompts that require citations, assumptions, and alternatives.
- Worker output includes contracts and readable pseudocode, with no C compilation gate.
- Partial checkpoints and targeted requests for additional evidence.
- First dossier renderer from persisted records.

Acceptance:

- A worker explains one subsystem's inputs, outputs, state, errors, and relevant dependencies.
- A shared helper's contract can terminate expansion without analyzing its entire implementation.
- Unresolved indirect dispatch appears as a potential blocker, not a fabricated target.
- Project-wide scopes retain decoded executable instructions outside discovered functions as
  unresolved regions until their role is established.
- Relevant persistence/timing effects survive extraction.
- Exhausted budgets return partial findings with a concrete unresolved question.

## M3 — Durable parallel execution and reconciliation

Depends on M2; final evaluation requires M4 quality checks.

Deliverables:

- PostgreSQL queue with transactional dispatch, leases, heartbeat renewal, fencing epochs,
  task deduplication, retry classification, and idempotent result submission.
- Configurable reasoning concurrency of at least 16; separately sized analysis/review pools.
- Priority classes for boundary discovery, blocking dependencies, behavior extraction, and
  reconciliation; aging prevents starvation.
- Worker-owned model sessions, bounded context/tool/time/token budgets, and partial checkpoints.
- Conditional claim publication, immutable dossier revisions, reverse dependency invalidation,
  and transactional outbox events.
- Preserve conflicting findings; schedule a bounded reconciliation task using both evidence sets.

Acceptance:

- Demonstrate 16 simultaneous active leases on meaningful tasks with distinct worker identities.
- Kill a worker, let its lease expire, and recover its task and checkpoints.
- Deliver a result twice: one accepted effect. Deliver an expired result: no newer lease mutation.
- Restart the scheduler without losing completed findings or duplicating active assignments.
- Concurrent helper requests deduplicate. Conflicting claims do not silently overwrite one another.
- Correct a dependency contract: consumers become stale, unrelated findings remain usable.
- Crash between artifact storage and database commit: no published pointer references missing data.
- Bound validation backlog and provider throttling through admission control.

## M4 — Semantic quality and original-behavior validation

Depends on M2; integrate with M3 before declaring parallel acceptance.

Deliverables:

- Structural validation for evidence identity, reference bounds, required fields, and versions.
- Independent reviewer tasks grounded in raw evidence, focused on observable claims and assumptions.
- Original-execution probes through a harness/application interface where available.
- Boundary, error, and state-sequence cases; counterexample probes for conflicting interpretations.
- Adapter review and regression cases where the adapter calls the original but discards its output.
- A behavior inventory linking claims to identified branches/state transitions and probe cases.
  Label unobserved/unknown paths instead of asserting complete coverage.

Acceptance:

- Seed a plausible but wrong semantic claim and show it is rejected or flagged.
- Reject invalid citations and detect unsupported claims despite valid citation locations.
- Catch the discarded-original-result adapter case; a positive call count alone must not pass it.
- Report static-only support separately from execution agreement.
- A missing observable behavior prevents readiness when it blocks writing the specification.
- Cases unavailable for execution remain explicit limitations; probes do not substitute guessed outputs.

## M5 — Dossier-to-spec handoff and API integration (in progress)

Depends on M3 and M4.

Deliverables:

- Versioned dossier and scope schemas for the new external API. Define provenance,
  validation status, and coverage fields explicitly.
- A durable campaign/job API with separate create, status, result, and event-subscription operations.
  Transport disconnects must not silently discard durable work; cancellation is an explicit operation.
- The regular Step 2 spec writer consumes reviewed behavioral facts and original examples only
  after readiness gates pass. Render draft pseudocode for analysts in the dossier only.
  Publish prose requirements, a descriptive interface, high-level steps, acceptance criteria,
  and original input/output examples as the public implementer artifact.
- Store citations, claim mappings, model/runtime provenance, reviews, and unresolved work in
  a separate analyst audit artifact. Reject source-like output and old schema 1 specs.
- Native probe statuses distinguish executable cases from unavailable ones.
- Model/runtime/schema provenance in the analyst audit; recorded deviations in the public spec.

Acceptance:

- A separate implementer can answer held-out behavior questions using the public spec alone.
- Open blockers survive the handoff and cannot be relabeled as verified requirements.
- Exclusions and pure-function adaptations preserve an audit trail of observable behavior.
- API consumers can distinguish static support, probe agreement, and unresolved blockers.
- Reconnecting to a job reports the same durable results without restarting analysis.

## M6 — Benchmark, tune, and prove multi-host operation

Depends on M3–M5.

Run the same workloads at 1, 4, 8, 16, and 32 reasoning workers. Separate cold import time from
warm analysis and reasoning time; report both. Repeat runs with fixed input/configuration and
record model nondeterminism. Compare a shared-evidence baseline with the existing per-attempt
project approach where tasks are comparable; rename success is not a semantic-quality baseline.

Measure:

- Time to first usable dossier and total campaign time.
- Accepted supported behavior per minute and per dollar.
- Incorrect, missing, contradicted, and reopened claims on held-out fixtures.
- Duplicate work, evidence cache hits, task latency, and validation backlog.
- Model throttling, token usage, CPU, JVM/native memory, and artifact I/O.
- Recovery time after worker, analysis-service, and scheduler failures.

Acceptance:

- The 16-worker run improves warm useful-work throughput over the 8-worker run on the
  sufficiently parallel fixture, without increased measured semantic error rate. If quotas or
  hardware prevent this, identify the bottleneck and rerun after adjustment; do not claim scaling.
- Report quality counts and sample sizes rather than a fabricated confidence percentage.
- Run at least 16 total workers across two hosts with shared durable state and artifacts.
- Loss of one host leaves completed findings intact and reclaims unfinished leases.
- Choose default pool sizes and model routing from recorded results. Document the point where
  more workers stop helping, including import/serial coordination costs.

## Task lifecycle and failure rules

```text
queued -> leased -> result_pending -> validated -> accepted
              |             |            |
              |             |            +-> needs_reconciliation / rejected
              +-> checkpoint + retryable failure -> queued (new attempt/epoch)
              +-> budget exhausted -> partial result + explicit campaign decision
```

Retain failed and rejected attempts with reasons. Infrastructure retries differ from semantic
reassessment: unchanged evidence plus repeated no-progress must not generate endless tasks.
A terminal campaign requires accounting for running attempts, pending reviews, conflicts,
and unexamined scope edges. Short database transactions publish findings; analysis-affecting
Ghidra changes use their own isolated revision path.

## Completion checklist

- [ ] M0 baseline and held-out behavior fixtures recorded.
- [ ] M1 reusable evidence and warm analysis pool verified.
- [ ] M2 first subsystem dossier produced with explicit boundaries and unknowns.
- [ ] M3 sixteen-worker recovery and concurrency gates pass.
- [ ] M4 semantic and original-behavior checks pass.
- [ ] M5 shared contracts and specification handoff integrated; the native dossier-to-spec
  artifact path is implemented, while the external API and acceptance gates remain open.
- [ ] M6 measured scaling and two-host recovery demonstrated.

Do not mark these complete based on documentation, worker counts, rename persistence,
compilable pseudocode, or passing only model-authored tests.
