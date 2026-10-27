# Recombination implementation: workstreams and gates

Companion to [`RECOMBINATION_PLAN.md`](RECOMBINATION_PLAN.md). The plan is the design; this file is
the execution board. It exists so agents can pick up independent work without re-deriving context.

## Ground rules

- Contracts are already written in `packages/contracts/src/{wire,canonical,capability,composition}.ts`.
  They are the build interface. Do not change them without updating this file and
  `agents/CONTRACTS.md` in the same commit.
- New backend code lives under `packages/backend/src/{capabilities,composition,state,verification,example,recombination}/`.
  Do not edit `server.ts`, `routes/step3/*`, `synthesis/*`, `native/*`, or frozen decompilation code.
- New workspace packages: `packages/runtime/` (host runtime) and `packages/desktop-host/` (Electron shell).
- Everything downstream is additive. Legacy Step 3 endpoints keep working.
- Tests use `node:test` + `node --import tsx --test`. They must not need network, AWS, Docker, or a
  display. Native tests may use `gcc` (present on this machine and in CI images that opt in).
- Persisted state goes under `SPLICE_STATE_DIR` (default `<repo>/.splice-state`, gitignored).
  Tests always pass a temporary directory.
- Fixtures authored for this work are labelled `authored_development`. Never present them as
  recovered or independently verified behavior.
- If a test needs a fact the code does not expose, add a typed seam and test it. Do not special-case
  the example app inside runtime/compiler code.

## Acceptance gates (from the plan)

| Gate | Proved by |
|---|---|
| M0 trustworthy intake | `intake.test.ts`: draft, unapproved, no-op, tampered, missing-identity inputs all rejected with actionable blockers |
| M1 common package format | one TS package and one native-origin definition load through one registry API; schema-derived clients compile |
| M2 native + stateful runtime | C sidecar and JS worker execute through one client; int64/NaN/error fidelity, timeout, cancellation, crash restart |
| M3 composition + durable state | two packages exchange data; mismatched units/IDs rejected; restart preserves revisions; stale/duplicate work cannot corrupt |
| M4 vertical slice | meeting notebook: transcript -> confirmed values -> workbook -> formula -> note; 60 then 80; failure cases |
| M5 Studio | library -> plan -> build job -> runtime-backed preview after reload; progress/cancel; blockers visible |
| M6 export/refine | exported app contains renderer, host, packages, binaries, migrations, lockfile; failed revision keeps last working app |
| M7 generality | second recipe + package replacement without compiler branches |

## Workstreams

### W1 · Host runtime — `packages/runtime/`

Deliver:

- `sidecarClient.ts`: spawn a package's sidecar executable, newline-delimited JSON protocol
  (`PROTOCOL.md`), request ids, deadlines, abort -> kill, pending rejection, bounded line size,
  stderr cap, restart policy, no shell interpolation.
- `jsWorker.ts` + `jsPackageWorker.mjs`: load a built ESM package in a worker thread, dispatch
  `operations[name](input, ctx)`, stream events, terminate on timeout/cancel, restart on demand.
- `client.ts`: one `CapabilityClient` for both runtime kinds, validating calls and results against
  `OperationSpec` wire schemas before/after transport.
- `host.ts`: `HostServices` with workspace-scoped storage root, fs blob store (content-addressed,
  size limits), clock, env secrets (allowlist), audio capture availability (not simulated),
  provider registry. Permission checks live here, not in generated UI.
- Tests: protocol round-trip, int64/NaN/bytes, timeout kills, abort, child crash containment,
  restart, malformed line, oversized frame, permission denial, worker memory isolation.

### W2 · Capabilities — `packages/backend/src/capabilities/`

Deliver:

- `identity.ts`: sha256(canonical JSON), content-addressed artifact writes, package id derivation.
- `intake.ts`: readiness envelope. Reject draft specs, `ready_for_review` without attestation,
  no-op tests (`assert.ok(true)` / zero assertions / zero operation calls), missing identity,
  artifact hash mismatch, `any` interfaces, missing error contracts, undeclared effects.
  Produce `IntakeBlocker[]` with `owner` and a precise `question`.
- `registry.ts`: filesystem registry keyed by hash; verifies artifact hashes on read; lists
  intakes and packages; never trusts an uploaded `verification` field (recomputes reference hash).
- `clientGen.ts`: schema-derived TypeScript client + host wrapper + README from a definition.
- `tsBuilder.ts`: esbuild bundle of implementation files (reject imports outside the package),
  run public tests in an isolated worker, mutation smoke check, produce `CapabilityPackage`.
- `nativeBuilder.ts`: generate the C shim from operation wire schemas, compile with pinned gcc
  flags, run public C cases through the real sidecar, run boundary cases (int64 min/max, division
  by zero), produce a native package.
- Legacy adapters: `fromBlueprint.ts` and `fromNativeSpec.ts` producing definitions + intake
  records without editing upstream schemas. A `FeatureBlueprint` becomes a TS package; a native
  spec without approved review and executable operations is rejected.
- Tests: every M0 rejection, tamper detection, TS build, native build, client generation compile.

### W3 · Composition and durable state — `packages/backend/src/{composition,state}/`

Deliver:

- `plan.ts`: validate a `CompositionPlan` against the registry. Structural + meaning checks
  (units, id domain, timezone, ordering, null, cardinality), unambiguous port selection,
  permissions, provider requirements, document ownership, workflow DAG and event cycles,
  UI references. Reject with `PlanError[]`.
- `bindings.ts`: compile bindings to executable adapters with tests and provenance; unit
  bridges only when declared; no invented transforms.
- `state/store.ts`: SQLite (`node:sqlite`) repository behind an interface. Tables for app records,
  documents with revisions, package lock, jobs, outbox, migrations. WAL, transactions,
  optimistic revision checks, migration runner, export/import, backup.
- `workflows.ts`: execute a plan workflow with ordering, timeouts, retries/idempotency,
  cancellation, failure propagation, stale-result rejection, outbox for cross-process work.
- `compiler.ts`: produce an `ApplicationBundle` with renderer descriptor, host entry, package
  lock, migrations, launch instructions, verification placeholders filled by real checks.
- `appStore.ts`: app revisions; failed builds never replace the last verified revision.
- Tests: mismatched units/ids rejected; cycle rejected; two packages exchange data; restart keeps
  state; stale response rejected; duplicate transcript event deduped; failed revision keeps app.

### W4 · Example vertical slice — `packages/backend/src/example/`

Authored development capabilities, no source-app claims:

- `formula`: decimal/integer formula evaluator with cell refs, arithmetic, typed errors, options.
- `markdown`: declared Obsidian-flavoured subset (headings, emphasis, code, lists, links,
  paragraphs) to a render model; escapes raw HTML; never claims rendering parity.
- `transcription`: provider port with a deterministic recorded provider plus a live provider
  adapter configured by env; ordered segments, cancellation, disconnect/duplicate handling.
- Notebook composition plan + scenarios: confirm 3 × 20, `=B2*C2` -> 60, edit to 4 -> 80,
  formula error, denied microphone, provider disconnect, duplicate events, worker crash,
  restart persistence, package replacement.

Integration test drives the real registry, runtime, store, workflows, compiler and preview.

### W5 · API, Studio and export

- `routes/recombination.ts`: intake, build job, package list, composition validate, app build,
  revisions, export, preview, job SSE/poll. Mount in `server.ts` (owner: orchestrator).
- Frontend `RecombinationView` + store: real registry after reload, plan builder, blockers,
  build progress/cancel, runtime-backed notebook preview, export.
- `packages/desktop-host/`: Electron main lifecycle, sandboxed preload generated from the
  manifest, host services, sidecar supervision. Export ships it plus binaries and migrations.
- Tests: route contracts with supertest-style fetch? (no extra deps: use `app.listen(0)`),
  reload keeps packages, failed job leaves revision, export file completeness, preview executes.

### W6 · Verification

- `verification/gates.ts`: capability (public + mutation), boundary (transport fidelity),
  composition (scenario must fail if an operation is removed), application (renderer + backend
  compile and run), distribution (export completeness), generality (second recipe + replacement).
- Wire these gates into build/compile results; `not_run`/`unknown` stay distinct from `passed`.

## Known environment facts

- Node 22.22, gcc 15, no Docker required for these tests.
- `node:sqlite` is available but prints an experimental warning; tests may silence it.
- `npm ci` installs into a bind-mounted scratch disk. Contracts tests now use `tsx`.
- The repo has no `data/` runtime dir; use `SPLICE_STATE_DIR`.
- Existing Studio fixtures stay untouched; the new view reads the real API.

## Working agreement

- Before starting, read `AGENTS.md`, `.agents/README.md`, and the two contract source files.
- Claim one workstream, work only inside its directories, and report any required shared-file edit
  instead of making it.
- Run `npm run build:contracts && npm run typecheck` before reporting done, plus the workstream tests.
- Record anything that cost you more than ten minutes in `docs/recombination/friction-log.md`.
  If the pipeline made you stuck, fix the pipeline (docs, script, test helper) in the same change.
