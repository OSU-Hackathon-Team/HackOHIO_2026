# Decompilation engine architecture

Status: implementation in progress. Updated 2026-10-24.

Implementation sequence: [DECOMP_IMPLEMENTATION_PLAN.md](DECOMP_IMPLEMENTATION_PLAN.md).
The earlier review of the separate Rev checkout is preserved as
[historical context](docs/archive/rev-engine-review-2026-10-24.md); its global FIFO,
exhaustive annotation, and project-publication policies do not govern this design.

## Objective and completion policy

Recover enough supported behavior to write a specification for a selected subsystem.
Support entire-project campaigns through multiple subsystem scopes and shared evidence.
The engine must support at least 16 concurrent reasoning workers, including workers on
separate hosts. A small request need not manufacture 16 tasks to occupy the fleet.

The deliverable is a behavioral dossier: interfaces, readable pseudocode, state transitions,
side effects, dependency contracts, evidence-linked claims, examples, and open questions.
Reconstructed C need not compile. Compilability, exact original names, exhaustive local
renaming, and cosmetic cleanup are not completion requirements.

A scope is ready for specification when its identified observable behaviors have supported
contracts, consequential dependency assumptions are resolved, and independent review finds
no unresolved blocker to specifying the requested behavior. Nonblocking unknowns remain
visible. Budget exhaustion produces a partial dossier, never a successful completion claim.
Readiness is relative to the declared boundary and evidence revision; it is not proof that
all possible runtime behavior was discovered.

Specification generation persists a draft for every dossier revision, even when original
cases are unavailable. Only reviewed, observable claims become draft requirements;
instruction counts, call-graph bookkeeping, virtual tables, and other compiler mechanics
stay in the private audit. A draft cannot feed implementation. The spec is promoted to
`ready_for_review` only after functional readiness gates pass and every included behavioral claim
has an agreeing original case or an explicitly specified expectation. Requirements describe
functional behavior independently of the source and destination languages; a C implementation
of behavior recovered from C++ is valid.

## Current implementation and remaining design

The Python engine now imports and indexes each binary by analysis identity, exports
immutable function evidence, discovers bounded scopes, and runs semantic and independent
review work through a durable PostgreSQL queue. Original-binary probes and partial
dossiers are implemented. The rename-attempt path remains a diagnostic with a private
Ghidra project per attempt.
Project intake can group executable and shared-library modules, reuse each module's analyzed
baseline, record declared and ELF `DT_NEEDED` dependencies, and identify static candidate
links from imported call thunks to functions in supplied modules. A project export aggregates
all discovered function evidence and preserves per-module failures and code-discovery gaps.
Project scopes now follow static cross-module candidates into bounded module scopes while
keeping those bindings unresolved. A project queue registers and drains their semantic tasks
through one reasoning pool; dossiers still operate on one module at a time. Cross-module
contract resolution and aggregate dossiers remain to be built. The static index records
executable memory, decoded instruction runs outside discovered functions, defined executable
data, and remaining unclassified bytes. Project scopes retain those gaps as unresolved work;
a successful export of all discovered functions alone does not establish whole-binary code
coverage. Unclassified bytes need adjudication because they may be code, padding, or data.
Bounded read-only range exports now capture raw bytes, instruction classifications, symbols,
and incoming references for that adjudication; inspected ranges appear in campaign status.

Conflict reconciliation, warm analysis pooling, multi-host recovery, and a durable job
API remain planned. The implementation plan lists their acceptance gates. Proposed
records there are design requirements, not proof of an implemented runtime interface.
A cleanroom implementation workbench and a brokered disclosure channel are implemented for
the functional and ready-spec implementation drivers; their interface and containment rules
are specified below. Live model-driven workbench acceptance and network policy remain open.

## Architecture

```mermaid
flowchart TD
    A[Project artifacts] --> B[Import and index once]
    B --> C[Immutable evidence store]
    Q[Subsystem request] --> D[Scope discovery]
    C --> D
    D --> E[Durable priority queue]
    E --> F[16 or more reasoning workers]
    C --> F
    F --> G[Claims and dependency contracts]
    F --> H[Targeted analysis requests]
    H --> I[Warm Ghidra analysis pool]
    I --> C
    G --> J[Validation and reconciliation]
    J --> K[Versioned subsystem dossier]
    J --> E
```

Use Python for the engine implementation alongside the launcher, PostgreSQL
for durable control state, and content-addressed files for immutable artifacts. Preserve
an artifact-store interface for later shared object storage. A future API or client should
consume engine job state rather than build a second scheduler. Logical components may run
in one service initially, while worker processes remain independently deployable.

The Studio EC2 path can also write through to a private S3 cache (`docs/decomp-s3-cache.md`).
It shares immutable artifacts and exact-campaign function, reviewed semantic, and spec
pointers. PostgreSQL remains the durable queue; the S3 cache is not a scheduler or a source
of readiness decisions. Scoped baselines and original runtime observations are rebuilt or
rerun per worker until their portability and environment identity can be verified.

### Import and evidence extraction

Hash each input artifact. Record architecture, compiler/language selection, Ghidra/backend
versions, analyzer settings, and analysis revision. A project manifest identifies all modules
and dependencies; function identity includes module identity, address space, and relative
address, with a generation for boundary changes.

Build a broad index of discovered functions, imports, strings, references, and call edges.
Decompile selected functions on demand. Cache immutable decompiler output, address mappings,
disassembly, relevant types, and P-code where needed. Include extraction failures and omitted
regions explicitly. Do not treat truncated evidence as a complete body.

Reuse warm decompiler contexts. Ghidra supports persistent `DecompInterface` instances and
parallel function decompilation. Use distinct interfaces for concurrent contexts. These API
capabilities must still be verified against the pinned backend/version in the integration gate.

Most workers need no writable project. Type, prototype, and function-boundary experiments
use isolated copies of a closed snapshot. Validated changes create a new analysis revision
and invalidate affected evidence. Never share one writable project across worker processes.

### Scope discovery

Locate candidate entry points from user seeds, symbols, strings, imports, routes, or traces.
Expand through calls, relevant data dependencies, callers, initialization, shared globals,
callback registration, and dispatch tables. A call graph alone is insufficient.

Record included entities, observable outputs, boundary contracts, exclusions with reasons,
and unresolved scope edges. Expansion stops at a dependency whose relevant behavior is
adequately established, rather than walking its entire implementation. New evidence may
expand or revise the boundary; preserve scope revisions and reasons for changes.

For project-wide campaigns, use multiple bounded scopes with shared helper contracts and
cross-module identities. Publish each ready subsystem progressively and retain unexplored
areas in the campaign inventory. Completion cannot be inferred from an empty ready queue.

### Tasks and scheduling

A task answers a question about an operation, function group, branch, state transition, or
uncertain dependency. Use independent tasks where possible; small recursive cycles may be
analyzed together. Large functions/cycles require bounded subquestions with explicit shared
state assumptions and a reconciliation task.

Prioritize scope relevance, uncertainty reduction, dependent work unlocked, and estimated
cost. Start with deterministic priority classes and aging to prevent starvation. Do not claim
numerical precision for an uncalibrated information-gain score.

Use transactional leases, attempt IDs, heartbeat renewal, fencing epochs, bounded retries,
and idempotent submissions. Deduplicate dependency requests. Persist partial findings before
finishing or timing out. A late result can be retained as stale evidence but cannot mutate a
newer lease. Every task pins its evidence and dependency contract versions.

Workers can proceed from provisional contracts if assumptions are explicit. Schedule review
when those assumptions change. Do not impose a global dependency barrier or repeatedly
retry unresolved cycles without new evidence. Stop with partial/stalled status when progress
or budget is exhausted.

### Evidence, findings, and publication

Keep raw tool evidence, semantic interpretation, and downstream specifications separate.
A ready dossier feeds the regular Step 2 spec writer through a behavioral handoff. The
public implementer specification contains natural-language interface and requirements,
high-level steps, original behavior examples, and acceptance criteria. It contains no
source code, assembly, executable tests, raw addresses, or draft pseudocode. An analyst-only
audit maps requirements to immutable evidence and reviews. Partial or disputed dossiers
fail closed; the generated spec is held for human quality and containment review.
A claim records its subject, statement, evidence references, assumptions, dependency versions,
review/probe results, and unresolved alternatives. Raw tool output is not automatically a
correct semantic interpretation.

Use immutable artifact hashes and binary addresses for native citations. Decompiled line
numbers are presentation references tied to one immutable rendering. Record original traces
with inputs, environment, outputs, and run identity.

The evidence/findings store is authoritative. Most semantic updates require short database
transactions, not Ghidra saves. Validate dependency versions and publish compatible findings
using conditional updates. Preserve conflicting claims for reconciliation; never resolve a
semantic disagreement by last-writer-wins. A canonical dossier references an immutable set
of accepted claim versions. Store artifacts first, then commit pointers and outbox events.

Ghidra names/comments are optional derived views. Analysis-affecting edits are a separate,
serialized revision path per program with isolation and persistence checks. A corrected type
or callee contract invalidates consumers through a reverse dependency index. Display-name
changes can refresh renderings without invalidating unchanged semantics.

### Cleanroom implementation and brokered disclosure

The implementer is a separate agent, not a downstream prompt inside the analysis worker.
It receives only the public specification, the public examples, and a test harness. It
never receives the original binary, a dossier, decompiler output, disassembly, source
addresses, review notes, or the analyst audit artifact.

The implementer runs in a disposable sandbox container with full shell access to that
container. This is deliberate: the agent must compile, run, inspect, and revise its own
candidate without a human relaying results. The container mounts only a materialized
workspace built from public artifacts; it does not mount the repository, the engine
state directory, the binary, or any private evidence. The public test harness exercises
only the published cases. Held-out cases remain outside the container and run once after
the agent stops.

Network egress is a separate channel from file admission. The container needs model
access, and the mount allowlist cannot prevent full shell access from fetching public
upstream material by name. Deployments that treat public source as in-scope must provide
only a provider-side proxy or no egress; enabling a general network is a recorded
deployment choice, not a cleanroom guarantee.

The only channel from the sandbox to the decompilation side is a broker. The broker:

1. Accepts a bounded natural-language question plus public failure context over a
   dedicated socket or mailbox.
2. Rejects requests for source, decompiler output, disassembly, bytes, addresses,
   symbol names, or implementation mechanics. These are refused as disclosure attempts,
   not answered partially.
3. Answers behavior questions from reviewed claims, dependency contracts, public
   observations, and, where needed, a broker model that may read private evidence. The
   broker may not expose held-out cases or alter evidence, claims, readiness, or probe
   outcomes.
4. Applies a deterministic disclosure filter to every response. Code fences, assembly,
   hexadecimal addresses, source-like identifiers, paths, and any verbatim line copied
   from private material fail the response; an answer that cannot be expressed as prose
   behavior is refused rather than sanitized by deletion.
5. Records every request, refusal, response, and source set in an append-only audit
   outside the sandbox. The implementation agent cannot read or edit that audit.

Broker Q&A is not evidence. It can focus the next iteration, but it cannot add a
requirement, promote a claim, or make a dossier ready. The public spec remains the only
implementation contract, and a broker answer that conflicts with an observed public case
is ignored by the driver.

### Worker output and validation

Dossiers include scope, inputs/outputs, units, encodings, pseudocode, state transitions,
side effects, errors, boundary cases, dependency contracts, examples, and open questions.
Preserve observable widths, signedness, overflow, rounding, byte order, aliasing, mutation
order, and synchronization behavior. Consult disassembly/P-code for ambiguous decompiler
renderings; do not require pseudocode to compile.

Validation has distinct layers:

1. Structural: schema, references, identities, versions, and required dossier sections.
2. Semantic: independent review against raw evidence; challenge consequential claims and
   compare competing explanations.
3. Behavioral: original-execution probes where feasible, covering boundaries, errors, and
   state sequences. Use original binaries/modules through a harness or application interface.

A small native harness is permitted; reconstructed compilable C is unnecessary. Execution
requires a controlled environment suitable for the target, with recorded limits and context.
If execution is unavailable, retain reviewed static findings with explicit limitations.

A source citation proves location validity only. Requirement IDs in test names measure
traceability only. A call counter can detect failure to invoke original code, but cannot prove
that an adapter uses its result. Review adapters and vary probes. Report static support,
review, probe outcomes, and unresolved questions separately. Passing examples never proves
complete equivalence. No fabricated confidence percentages.

Persistence, timers, networking, and platform state belong in the dossier when observable
within the selected scope. A downstream pure-function API may adapt them only through
explicitly recorded deviations; blanket removal of platform behavior loses specification data.

## Capacity and cost

Start with 16–32 reasoning slots, a separately bounded warm analysis pool (initial experiment:
2–4 contexts), and reserved validation capacity. These are hypotheses to benchmark. Increase
analysis concurrency to 16+ when workload and hardware justify it. Multiple requests can share
the fleet when one subsystem has insufficient independent work.

Admission accounts for model requests/tokens, CPU, JVM/native memory, artifact I/O, and
validation backlog. Apply bounded queues and backpressure, rate limiting, retry jitter, and
per-campaign budgets. Track effective throughput rather than container count.

Route models through `models.json`; evaluate role quality on held-out cases. Cheap extraction
must not become an unchecked source of semantic claims. Escalate ambiguous state/control
flow and failed probes to stronger reasoning. Cache reusable evidence and contracts before
optimizing model price alone.

Cache raw artifacts by input and toolchain/configuration revision; cache semantic outputs by
evidence, contract, prompt/schema, and model versions. Use measured invalidation boundaries.

## References

- [Ghidra persistent decompiler interface](https://ghidra.re/ghidra_docs/api/ghidra/app/decompiler/DecompInterface.html)
- [Ghidra parallel decompiler](https://ghidra.re/ghidra_docs/api/ghidra/app/decompiler/parallel/ParallelDecompiler.html)
- [Ghidra P-code semantics](https://ghidra.re/ghidra_docs/languages/html/pcoderef.html)
- [PostgreSQL SELECT and SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
- [Current Ghidra MCP upstream](https://github.com/mrphrazer/ghidra-headless-mcp)
