# Step 2 — Requirements Extraction (Owner: Engineer 2)

> **Subsystem integration:** The new upstream output is a behavioral dossier with evidence,
> scope boundaries, dependency contracts, and unresolved questions. See
> [the implementation plan](../../DECOMP_IMPLEMENTATION_PLAN.md) for the remaining schema migration.
> `NativeSubsystemSpec` now carries the dossier-to-spec handoff through
> `POST /api/native-specs` and `GET /api/native-specs/:artifact`.
> Existing examples below use the Electron `RawEvidence`/`FeatureSpec` contract. Preserve
> externally observable persistence, timing, network, and state behavior when it belongs to the
> requested subsystem. Test-name coverage is traceability, and passing oracle cases establishes
> agreement only for those cases; neither proves completeness.

**Input:** `RawEvidence` from Step 1: the real source REA located, plus how it was found.
**Output:** a `FeatureSpec` (`../CONTRACTS.md` §4) containing:
- numbered **requirements**, each citing source lines
- a TypeScript **interface** (`types_code`) the implementation must satisfy
- **acceptance tests** written against that interface
- an **oracle adapter** that implements the interface by calling the *original* module, so the
  acceptance tests can be **run against the original app's code**
- a computed **coverage** map and a `verified` / `unverified` status

Step 2 never writes the engine itself. Its job is to answer one question: *"what exactly does
this feature do?"*, and to prove the answer against the original.

```
RawEvidence ──▶ requirements prompt (Claude, structured JSON)
                     │ SpecDraft
                     ▼
               static checks ── refs point into real lines? every REQ tested? exports declared?
                     │
                     ▼
               oracle run: acceptance tests × adapter × ORIGINAL modules (sandbox)
                     │   each test must actually call original code (call counter)
          fail ◀─────┤
   repair (≤2) ──────┘ pass
                     ▼
               FeatureSpec { status: verified | unverified }
```

Why the oracle matters (this is the pitch): the LLM writes tests, but the **original app**
decides whether they're right. A test that expects behaviour the original doesn't have fails, and
gets repaired, before any implementation exists. The reference example in `CONTRACTS.md` §9
shows the kind of invented requirement this catches.

## Docs in this folder (read in order)

| # | File | What you build | Done by |
|---|---|---|---|
| 01 | `01_pipeline_and_route.md` | `POST /api/extract` (Step 1 + Step 2 in one stream), `GET /api/specs`, modes | H8 (CP1) |
| 02 | `02_llm_client.md` | **Shared** `llm/llm.ts`: structured JSON calls, streaming progress, refusals, caching. Eng 3 uses it too | **H4 — Eng 3 depends on it** |
| 03 | `03_requirements_prompt.md` | System prompt, evidence formatting, the `SpecDraft` JSON schema | H6 |
| 04 | `04_sandbox_runner.md` | **Shared** `sandbox/`: TS→JS, worker + vm isolation, test harness, `original()` loader with call counters. Eng 3 uses it too | **H4 — Eng 3 depends on it** |
| 05 | `05_oracle_coverage_and_repair.md` | Static checks, oracle run, coverage, repair loop, assembling `FeatureSpec` | H10 |
| 06 | `06_testing_and_acceptance.md` | CLI scripts, quality rubric per feature, acceptance gate | continuous |

## Files you own

```
packages/backend/src/
├── llm/llm.ts                   # shared (02)
├── llm/schemas.ts               # JSON Schemas for structured outputs (03; Eng 3 adds theirs)
├── sandbox/runTests.ts          # shared (04)
├── sandbox/workerSource.ts      # shared (04)
├── spec/prompt.ts               # (03)
├── spec/formatEvidence.ts       # (03)
├── spec/staticChecks.ts         # (05)
├── spec/buildSpec.ts            # (05) RawEvidence → FeatureSpec
├── spec/store.ts                # save/load fixtures/specs (01)
├── routes/step2/index.ts        # (01)
└── scripts/
    ├── testSandbox.ts           # (06)
    ├── testSpec.ts              # (06)
    └── specAll.ts               # (06)
```

## Interfaces you provide

```ts
// to Eng 3 (by H4)
export async function structuredCall<T>(opts: StructuredCallOpts<T>): Promise<StructuredResult<T>>;   // llm/llm.ts
export async function runTests(input: RunTestsInput): Promise<RunTestsResult>;                       // sandbox/runTests.ts

// to the route / scripts
export async function buildSpec(evidence: RawEvidence, app: PantryApp, feature: PantryFeature, hooks: SpecHooks): Promise<FeatureSpec>;
```

## What you consume from Eng 1

`collectEvidence`, `loadRecordedEvidence`, `saveEvidence`, `createTranscript`,
`replayTranscript`, `openSse`, `newRunId`, `loadPantry`, `config`. Until Step 1 is live, use
`fixtures/evidence/_seed/*.json` (Eng 1 writes them at H2 with `npm run seed:evidence`).
