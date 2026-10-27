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
Streaming adapter now recognizes an imported or Studio-recorded mono PCM16 WAV through the backend
and streams partial/final segments after capture ends. Studio asks the browser for microphone
permission, limits recording to five minutes, and converts it to a bounded upload; its browser
smoke covers capture and denied permission. A short synthetic speech sample completed the live AWS call;
the final result was imperfect ("A 320 and the total is 60."). The same stream populated the
notebook workflow input and its preview persisted the transcript with formula value 60. This
proves external transport and downstream wiring, not quality on human audio or streaming during
microphone capture. The exported Electron source app now imports bounded WAV files through a
narrow preload API and runs the optional AWS provider in its host process. A live synthetic WAV
completed in the exported renderer, populated the meeting document and workflow input, and
persisted after a full Electron restart. The host test exercises interrupted-job replay,
cancellation and a concurrent edit conflict with a deterministic provider. The Studio path now creates a
durable transcription job before connecting to SSE. Its latest segments and status survive reload;
the browser reconnects with the workspace key. A simulated provider interruption replays the
saved audio under the original job ID and replaces old partials. A real AWS stream also finished
on attempt 2 after the backend process was stopped with a partial segment and restarted using
the same state directory. Blob writes now flush data and metadata before renaming and flush the
containing directories before returning a reference; abandoned data and metadata temps are
removed by the store sweep. Crash timing during SQLite/blob writes remains untested. The notebook
plan now declares an initial meeting document and a provider projection. Each partial/final event
updates its timestamped, stable-ID transcript array in the same SQLite transaction as the session
snapshot. A simulated concurrent document edit rejects the later event without overwriting the
edit; restart retains the document. The
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
the previous revision and shared documents remain stored. An additive, declared document migration
can initialize a new composition-owned document atomically with build or activation and preserve it
through rollback. Other schema and durable package-state changes still require a data migration.
Builds and switches compare the active revision
again inside the SQLite transaction, so a concurrent change returns a conflict. Activation also
revalidates package availability, file hashes, the application hash and bundled migrations.
An opt-in Ubuntu x64 `.deb` now bundles the verified app and Electron, installs the Chromium
sandbox helper with root ownership, and launches on hosts that permit bubblewrap's required
namespaces without `npm install` or a Splice server. Its display smoke verified workbook and note
state after restart, installed a UI-only revision over the first package, and preserved both
documents through that upgrade and a second restart. A fresh Debian bookworm container without
Node or a repo checkout installed
the package, launched it as an ordinary user, and drove the saved workbook, formula and note
through 60 then 80. The package test also builds an authored C multiplication capability,
checks its verified binary remains executable in the registry and `.deb`, and calls it through
the exported host before and after an upgrade and inside the clean container. This found and
fixed a missing execute bit on registry sidecars. Registry reads now restore that bit on
previously stored, hash-verified sidecars. A clean Ubuntu 24.04.5 VM installed the package
without Node or a repo checkout. Its default AppArmor policy blocked bubblewrap's user namespace
capabilities, so the first native call failed. After the VM administrator enabled Ubuntu's
optional bubblewrap profile, the installed native and notebook workflows ran through 60 then 80
and preserved both documents after a full app restart. This is a tested host prerequisite, not
an out-of-box clean VM pass; the launcher now reports a namespace policy blocker before opening
the app. Other platform builds, delivery updates, and realistic performance budgets remain
open. The `verified` application status means its current package, scenario and export checks passed; it
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
An additional nonroot container probe used the current production image with all capabilities
dropped, a read-only root filesystem, a writable `/tmp`, `no-new-privileges`, and Docker seccomp
and AppArmor set to `unconfined`. The API was healthy, but `/api/recombination/seed` failed while
running public tests: bubblewrap could not mount `/proc` (`Operation not permitted`). A direct
`bwrap --unshare-user` probe in the same container failed while setting its UID map. Host kernel
audit records show the container process entering the generic `unprivileged_userns` AppArmor
profile and denial of the UID-map write and namespace capabilities. The earlier simple bubblewrap
probe did not cover this namespace setup. Assigning the host's `bwrap` profile to the entire
container also failed, since its child `unpriv_bwrap` profile strips the capabilities needed
during setup. The host's executable-specific bubblewrap profile works for the installed desktop
app, but did not apply to the container's overlay executable in this run. A container
deployment therefore still needs a reviewed seccomp/AppArmor policy that permits bubblewrap's
setup and confines the resulting worker, followed by the full seed/build/preview acceptance run.
An opt-in [candidate policy and probe](../infra/recombination-container/README.md) now pass that
development run on this host. The runner used a Moby-default-derived seccomp allowlist with
namespace/mount additions, a custom AppArmor profile, Docker `systempaths=unconfined`, UID 65532,
all capabilities dropped, `no-new-privileges`, a read-only root and a dedicated state mount. The
probe verified the container's confinement and the nested worker's zero effective capabilities,
hidden `/app`, and isolated loopback network. It seeded four authored packages, built the notebook,
previewed 60, restarted with the saved state, then previewed 80. This replaces the earlier
functionality blocker with a security review and host-compatibility gate: the candidate permits
mount operations throughout the container and unmasks Docker's system paths, and has only been
tested on this Ubuntu/AppArmor host. It is not an approved production policy.

The notebook now stores confirmed numeric values in a revisioned workbook document. Its formula
step reads `workbook.cells` with a stale-result guard, and the 60-to-80 acceptance scenario edits
that workbook, restarts, and checks the saved cells and rendered note. Studio preview exposes
explicit document edits. The exported Electron renderer offers an editable cell table backed by
schema validation and optimistic revisions in the host; the Linux display smoke saves cells,
recalculates, and verifies both documents after restart. The separate budget-board recipe keeps
its own input contract. These are authored development fixtures and do not establish source-app
behavioral equivalence.

### Optional live transcription

Set `SPLICE_TRANSCRIPTION_PROVIDER=aws` with AWS credentials, a supported `AWS_REGION`, and a
separate random `SPLICE_TRANSCRIPTION_ACCESS_TOKEN` of at least 32 characters. Give that workspace
access key to authorized Studio users; it is distinct from AWS credentials and is not persisted in
browser storage. Then
open the active notebook in Studio and record a microphone clip or import a mono signed 16-bit PCM
WAV (8–48 kHz, up to 10 MB). Browser capture requires microphone permission and a secure context
(HTTPS or localhost); it creates a 16 kHz WAV after recording stops.
`POST /api/recombination/transcription/jobs` stores the uploaded PCM and starts a durable job.
The response identifies a `TranscriptionSession` and its `JobRecord`; authenticated session and
event routes expose the latest ordered segments and replayable job events. Closing Studio detaches
observation without cancelling the provider. Studio saves the session ID locally for reconnect,
but keeps the access key in memory only. Blob reads verify their saved content hash and size before
a provider replay. The earlier POST-SSE route
`/api/recombination/transcription` remains an ephemeral compatibility path. Both POST routes
require `X-Splice-Transcription-Token` before accepting an upload; serve Studio over HTTPS when
users connect remotely so the workspace key stays private in transit.
When an active app has a declared provider projection, Studio sends its app and provider IDs and
each accepted segment is saved to the composition document immediately. The session retains the
document revision so a later edit causes a conflict rather than an overwrite. Studio also inserts
finalized segments into the workflow input for the later formula and Markdown preview. Standalone
uploads without app/provider IDs still produce a durable session without a document projection.
`npm run test:recombination:transcription:live -- <mono-pcm16.wav>` checks the actual
provider without Studio. The synthetic sample above is a plumbing check; a labeled human-audio
latency/quality test remains required. AWS Transcribe needs permission to start a streaming
transcription and is an external provider substitution, not a Notion implementation.

The exported Electron source app needs `SPLICE_TRANSCRIPTION_PROVIDER=aws`, `AWS_REGION`, and
AWS credentials in its host environment; it does not use the Studio access key. Its renderer
imports a WAV through the preload bridge and sees partial/final snapshots while the host stores
the audio and session under Electron `userData`. The plan's `workflow_input` declaration maps
final transcript segments into the notebook workflow input. Closing the app leaves an unfinished
job for replay on the next launch. To repeat the live exported-app check, run
`SPLICE_TEST_EXPORTED_TRANSCRIPTION_WAV=<mono-pcm16.wav> AWS_REGION=<region> npm run test:recombination:desktop`.

### Linux x64 install package

The source export can also be packaged as a Debian archive on Linux x64. Build the app in a
persistent `SPLICE_STATE_DIR`, then run
`npm run package:recombination:linux -- <state-dir> <app-id> <output-dir>` from this repo with
Electron 45 installed in `node_modules`. The command verifies each exported file hash, the
plan/lock/application hash, the selected platform and the Electron version before creating
`<output-dir>.deb`. Install it with `sudo dpkg -i <output-dir>.deb` and launch the generated
`splice-app-<app-id-hash>` command. Its launcher checks that bubblewrap can create the required
namespaces and exits with code 78 and a diagnostic if host policy blocks them. The package
contains Electron, the host, renderer, locked capabilities, binaries and migrations; users do not
run `npm install`, install Node separately, or start the Splice server. Isolated JavaScript
capabilities use Electron's embedded Node mode,
with only the required Electron runtime files mounted inside bubblewrap.
The package declares bubblewrap, util-linux and core Electron library dependencies. Its
setuid Chromium sandbox helper requires root ownership and mode 4755, which `dpkg` sets at
installation; unpacking the app directory as an ordinary user is not an equivalent install.
The package can be removed with `sudo dpkg -r splice-app-<app-id-hash>`; user data stays under
Electron's per-user application directory. `npm run test:recombination:linux-package` builds,
installs, launches, restarts and removes the package on a Linux host with `sudo`, Xvfb and
`dpkg-deb`. The smoke also installs a UI-only revision over the first package and confirms its
workbook and note data remain editable and durable. This passed on Ubuntu 26.04 x64. A separate
Ubuntu 24.04.5 VM installation is conditional on its optional bubblewrap AppArmor profile;
other Linux distributions remain unverified, and the `.deb` does not cover Windows or macOS.
`npm run test:recombination:linux-clean` adds a disposable Debian bookworm
container install without Node or a repository checkout. It checks that the app starts as an
ordinary user and runs the workbook-to-formula-to-note workflow to 60 then 80, plus an authored
C sidecar that computes 60 then 80. The container test uses Docker `--privileged` so
nested sandboxing works; that is diagnostic isolation, not a production deployment design.

On a fresh Ubuntu 24.04.5 VM, the package installed, but Ubuntu's default
`kernel.apparmor_restrict_unprivileged_userns=1` policy denied capabilities needed by
`/usr/bin/bwrap`. The first native workflow returned a sidecar `EPIPE`. Ubuntu ships a
purpose-built profile in the optional `apparmor-profiles` package; that profile is disabled by
default because enabling it can affect other applications. For this disposable VM, the
administrator installed that package, copied its `bwrap-userns-restrict` profile into
`/etc/apparmor.d/`, and loaded it with `apparmor_parser -r`. With that profile active,
`npm run test:recombination:linux-vm -- <CDP URL> initial` verified the renderer's workbook,
formula, note and native sidecar at 60 then 80. After a systemd service restart, the same command
with `restart` verified saved workbook and note data and another native call. The discovery used
`.deb` SHA-256 `9402d39e4c6303057c4c9d5f696ce9f68c7c00930a1cbb03909aed728c122cf3`.
A rebuilt package with SHA-256 `2a000395fd20a176f093ef1187770e3460c2b4dccffe7031abe93e0182a47708`
exited with code 78 and an actionable message under the default policy; after the profile was
restored, a fresh VM user passed both `initial` and `restart` with the rebuilt package. The
temporary VM was Ubuntu 24.04.5 x64 on EC2 t3.large. This evidence does not clear the
default-policy M6 gate. See the
[Ubuntu 24.04 release notes](https://documentation.ubuntu.com/release-notes/24.04/) and
[Ubuntu's AppArmor profile guidance](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007).

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
| `POST /api/recombination/transcription/jobs` | mono PCM16 WAV upload → `TranscriptionStartResponse` and durable provider job |
| `GET /api/recombination/transcription/jobs/:sessionId` | authenticated `TranscriptionSession` snapshot |
| `GET /api/recombination/transcription/jobs/:sessionId/events` | authenticated replayable `JobEvent` SSE |
| `POST /api/recombination/transcription/jobs/:sessionId/cancel` | cancel provider job; return `JobRecord` |
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
