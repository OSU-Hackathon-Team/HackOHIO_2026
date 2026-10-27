# Recombination implementation: workstreams and gates

Companion to [`RECOMBINATION_PLAN.md`](RECOMBINATION_PLAN.md). The plan is the design; this file is
the execution board. It exists so agents can pick up independent work without re-deriving context.

## Current evidence and remaining gates (2026-10-27)

The downstream implementation now has intake and artifact integrity checks, TS and C package
builders, a shared runtime client, SQLite state, explicit bindings/workflows, a Studio route and
view, and an Electron source export. Package reuse now includes source files, compiler settings,
and the public test suite in its hash-checked build input identity. The authored meeting notebook
passes service and HTTP integration, live Studio build/preview/export after a browser reload, and
a real Electron renderer run and restart on Linux x64. Run `npm run test:recombination:desktop`
for the opt-in display smoke; it requires Xvfb and Electron installed locally. The existing
`npm run test:studio -- --grep-invert "Sandpack boots"` browser suite also passes (12 checks).
This Ubuntu 26.04 host needs `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` and a browser
installed on the scratch drive; the CI Ubuntu runner uses its supported Chromium build.

This is **development evidence, not full M0–M7 acceptance**. The notebook uses authored formula,
Markdown and recorded-segment fixtures. It does not consume an approved upstream native or
Electron-origin package or recover Notion's transcription behavior. An optional AWS Transcribe
Streaming adapter now recognizes an imported mono PCM16 WAV through the backend and streams
partial/final segments to Studio. A short synthetic speech sample completed the live AWS call;
the final result was imperfect ("A 320 and the total is 60."). The same stream populated the
notebook workflow input and its preview persisted the transcript with formula value 60. This
proves external transport and downstream wiring, not quality on human audio, microphone capture,
provider recovery after a server crash, or live transcription in the exported app. The
native-origin intake test uses a synthetic artifact and approval solely to exercise the gate;
it is not an upstream review result. On Linux, JS and native packages now run as separate
processes inside bubblewrap user, PID, mount and network namespaces. Tests confirm package
files are visible while host scratch files and a host TCP listener are unavailable. Host-effect
brokering and equivalent isolation on other operating systems remain open. A separate two-package
budget board recipe now validates, executes, persists, previews and exports with a replacement
formula package and an authored budget renderer. Its explicit binding, different workflow and
document shape need no compiler changes. Its own export launches under Electron, computes 60
then 108, and reads both the total and report after restart. Workflow
writes now merge from the exact revision they compare; concurrency tests cover intervening edits
and a multi-document rollback on a stale result. Two source exports have launched on Linux x64.
Build jobs persist typed, hash-checked requests and replay from a safe build boundary after a
server restart under the original job ID; Studio reconnects to an active job after reload. A
SQLite migration ties each saved app revision to its build job, so replay after the app commit
returns that revision without creating another. Checkpoints are diagnostic, not resumable compiler
state. The app commit and job-result file are still separate writes; recovery replays the request
to reconcile them. A durable active revision now supports same-schema rollback through Studio;
the previous revision and shared documents remain stored. A schema or durable package-state change
needs an explicit data migration before activation. Builds and switches compare the active revision
again inside the SQLite transaction, so a concurrent change returns a conflict. Activation also
revalidates package availability, file hashes, the application hash and bundled migrations.
Platform builds, delivery updates, and realistic
performance budgets remain open. The `verified` application status means its current package, scenario and export checks passed; it
does not assert any of those open acceptance gates passed.
The CI workflow is configured to run the live Studio and exported Electron smokes on its Linux runner.
The production Docker image builds locally, starts, serves the frontend, and returns healthy API
responses. Its runner includes the runtime package and the TypeScript templates needed to compile
Electron exports. A diagnostic `--privileged` container seeded four authored packages, built the
notebook app, and previewed value 60. Docker's default security profile blocks bubblewrap's nested
namespaces, so package build and preview do **not** work in a normal container. Broad container
privileges are not a production deployment solution; a separately reviewed sandbox deployment
design is still required for container-hosted recombination. The CI container smoke checks startup,
the capabilities API, and compiler template bundling, not nested sandbox execution.

### Optional live transcription

Set `SPLICE_TRANSCRIPTION_PROVIDER=aws` with AWS credentials, a supported `AWS_REGION`, and a
separate random `SPLICE_TRANSCRIPTION_ACCESS_TOKEN` of at least 32 characters. Give that workspace
access key to authorized Studio users; it is distinct from AWS credentials and is not persisted in
browser storage. Then
open the active notebook in Studio and import a mono signed 16-bit PCM WAV (8–48 kHz, up to 10 MB).
The POST-SSE route `/api/recombination/transcription` stores the uploaded PCM in the workspace blob
store and emits `started`, timestamped partial/final `segment`, and terminal `done`/`error` events.
The route requires `X-Splice-Transcription-Token` before it accepts the upload; serve Studio over
HTTPS when users connect remotely so the workspace key stays private in transit.
Studio inserts finalized segments into the workflow input; run preview to save them in the meeting
document. `npm run test:recombination:transcription:live -- <mono-pcm16.wav>` checks the actual
provider without Studio. The synthetic sample above is a plumbing check; a labeled human-audio
latency/quality test remains required. AWS Transcribe needs permission to start a streaming
transcription and is an external provider substitution, not a Notion implementation.

## Ground rules

- Contracts are already written in `packages/contracts/src/{wire,canonical,capability,composition}.ts`.
  They are the build interface. Do not change them without updating this file and
  `agents/CONTRACTS.md` in the same commit.
- New backend code lives under `packages/backend/src/{capabilities,composition,state,verification,example,recombination}/`.
  The recombination router is mounted in `server.ts`; keep `routes/step3/*`, `synthesis/*`,
  `native/*`, and frozen decompilation code untouched.
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
- `jsWorker.ts` + `jsSidecarRunner.mjs`: load a built ESM package in an isolated process, dispatch
  `operations[name](input, ctx)`, stream events, terminate on timeout/cancel, restart on demand.
- `client.ts`: one `CapabilityClient` for both runtime kinds, validating calls and results against
  `OperationSpec` wire schemas before/after transport.
- `host.ts`: `HostServices` with workspace-scoped storage root, fs blob store (content-addressed,
  size limits), clock, env secrets (allowlist), audio capture availability (not simulated),
  provider registry. Permission checks live here, not in generated UI.
- Tests: protocol round-trip, int64/NaN/bytes, timeout kills, abort, child crash containment,
  restart, malformed line, oversized frame, permission denial, process filesystem/network isolation.

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
  run public tests in an isolated process, mutation smoke check, produce `CapabilityPackage`.
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

Route surface (all JSON unless noted; SSE is POST-friendly via `fetch` anywhere a job runs):

| Method/path | Body/result |
|---|---|
| `GET /api/capabilities` | `CapabilityListResponse` |
| `POST /api/capabilities/intake` | `CapabilityIntakeRequest` → `CapabilityIntakeRecord` |
| `POST /api/capabilities/build` | `CapabilityBuildRequest` → `JobRecord` |
| `GET /api/capabilities/:packageId` | `CapabilityPackage` |
| `POST /api/recombination/seed` | idempotently install authored development packages → `CapabilityListResponse` |
| `GET /api/recombination/transcription` | `TranscriptionAvailabilityResponse` for optional external provider |
| `POST /api/recombination/transcription` | mono PCM16 WAV upload → POST-SSE `TranscriptionEvent` stream |
| `POST /api/compositions/validate` | `CompositionValidateRequest` → `CompositionValidateResponse` |
| `POST /api/apps` | `ApplicationBuildRequest` → `JobRecord` |
| `GET /api/apps` | `ApplicationListResponse` |
| `GET /api/apps/:appId/revisions` | `ApplicationRevisionListResponse` with active revision |
| `GET /api/apps/:appId/revisions/latest` | `ApplicationRecord` |
| `GET /api/apps/:appId/revisions/:revision` | `ApplicationRecord` |
| `POST /api/apps/:appId/revisions/:revision/activate` | `ApplicationRecord`; rejects incompatible state |
| `POST /api/apps/:appId/preview` | `PreviewRequest` → `PreviewResponse` |
| `GET /api/apps/:appId/export` | `ApplicationExportResponse` |
| `GET /api/jobs/:jobId` | `JobRecord` |
| `GET /api/jobs/:jobId/events` | `text/event-stream` of `JobEvent` |
| `POST /api/jobs/:jobId/cancel` | `JobRecord` |

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

## Public test harness formats

`PublicTestCase.code` is executable, not prose. Intake rejects tests that do not exercise the
capability.

- **TypeScript (`harness: "ts"`)** — the body of an async function receiving `ctx`:
  `const { sum } = await ctx.call("add", { a: 1, b: 2 }); ctx.assert.equal(sum, 3);`
  `ctx.call` validates against the operation's wire schemas and counts as a real call.
  `ctx.assert` is the Node `assert/strict` surface and counts assertions. Imports are not allowed;
  the builder wraps the body in `new AsyncFunction("ctx", code)` inside a bubblewrap process.
- **C (`harness: "c"`)** — a JSON document:
  `[{"op":"add_i64","args":{"a":{"$int":"1"},"b":{"$int":"2"}},"expect":{"sum":{"$int":"3"}}}]`
  or `[{"op":"divide","args":{"a":1,"b":0},"expect_error":{"code":"division_by_zero"}}]`.
  The builder drives the real sidecar and compares decoded values, so int64 and error fidelity are
  tested through transport rather than by inspecting source.

A test with zero `ctx.call`/`ctx.assert` (or an empty C case list, or only `assert.ok(true)`) is a
no-op and blocks intake.

## Known environment facts

- Node 22.22, gcc 15, bubblewrap and prlimit; no Docker required for these tests.
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
