# Native decompilation runs from Studio

For Engineer 2. Studio can now start a native decompilation run itself, follow it live and show
the result in the app library. This page covers how that works, where the results land, and what
changed in your Studio files.

## Using it

1. In Studio, open **App library**. The **Analyze a native application** card sits above the
   application list.
2. Pick a function budget: 20 (about $0.50) or 40 (about $1.20). Click **Analyze** and confirm the
   cost.
3. The card shows the stage (runtime observation, decompiling, drafting and reviewing claims,
   LibreOffice oracle, evidence, specification) with drafted/reviewed counters. Stage lines also
   appear in the bottom-panel terminal.
4. When it finishes, the new specification appears as a library entry next to Mock Task Board.
   **View the result** selects it.

A run takes roughly 10 to 20 minutes. Only one run can be in progress at a time, because there is
one worker instance. Reloading the page doesn't lose the run: the backend keeps its history under
`decomp-state/runs/`.

## Backend setup

Runs are off by default. In `packages/backend/.env` (never committed):

```
DECOMP_EC2_ENABLED=1
DECOMP_EC2_INSTANCE_ID=<worker instance id>
DECOMP_EC2_BUCKET=<results bucket>
AWS_REGION=us-east-2
```

The backend's AWS credentials need EC2 start/describe, SSM send-command, and S3 read/write on
that bucket. The worker uses its own instance role for Bedrock; no keys are sent to it.
For reusable analyst-side caching, grant the worker role scoped `s3:ListBucket` plus
`s3:GetObject` and `s3:PutObject` on `cache/v1/*`, then set `DECOMP_CACHE_ENABLED=1` on the backend. See
[`decomp-s3-cache.md`](decomp-s3-cache.md). The flag is off until those permissions exist.

## What happens in a run

```
Studio  -> POST /api/decomp/runs  -> backend packages the analysis code (git-tracked files only),
                                     uploads it, starts the worker, launches
                                     infra/decomp-ec2/run-scoped-pipeline.sh
Studio <-  SSE /api/decomp/runs/:id/events <- backend polls S3 progress every 10 s
worker:  Frida runtime seeds -> scoped Ghidra -> Qwen drafts -> independent Qwen review
         -> real LibreOffice oracle -> dossier -> Qwen spec writer -> uploads results, stops itself
backend: downloads results, re-hashes every artifact, imports into decomp-state/,
         copies the handoff to docs/handoffs/libreoffice-formula/
```

## Where results land

- **Specification:** `decomp-state/artifacts/`. `GET /api/native-specs` lists it, and Studio
  shows it.
- **Handoff:** `docs/handoffs/libreoffice-formula/`.
  - `README.md` is a readable summary of each function's claims with its review verdict.
  - `evidence.json` holds the claims, dependencies, unknowns, readiness blockers, and the public
    cases with real LibreOffice results.
  - `raw_agent_outputs.json` holds the drafter and reviewer JSON exactly as the models returned it.
  - `native_spec.json` is the specification itself.
  - Held-out cases are never written.

## Draft vs ready

- A run produces a `draft` specification when the evidence is still incomplete. So far every run
  has been partial: calls lead outside the function budget, and claims aren't yet linked to
  oracle cases.
- The backend adapter (`nativeAdapter.ts`) refuses drafts. Studio therefore shows a draft's
  requirements and observed cases, but disables **Reconstruct Engine** with an explanation.
- A `ready_for_review` specification enables Reconstruct, and the run goes through your existing
  adapt → implement → `setNativeHandoff` flow unchanged.
- Treat draft requirements as a starting point for a hand-authored `FeatureSpec`, not as verified
  behavior. The review catches real errors, but its own reasoning can be wrong. See the
  `ScGreater` verdict in `raw_agent_outputs.json`.

## Changes in your files

- `ide/AppLibrary.tsx`:
  - lists bundled fixtures plus live specs;
  - loads live specs on mount;
  - renders the new `AnalyzeNative` card;
  - disables Reconstruct for drafts.
  - The reconstruction flow itself is untouched.
- `ide/store/useIdeStore.ts`: adds `liveNativeTargets`/`liveNativeFeatures`,
  `loadLiveNativeSpecs()`, and the `decompRun` slice with `startDecompRun`/`followDecompRun`.
- New: `ide/AnalyzeNative.tsx` and `ide/data/liveNative.ts` (a pure mapping and event reducer,
  with tests in `tests/liveNative.test.ts`).
- Other views (Decompiled, Specs, Studio) still read only the bundled fixtures.

## Open questions

- `models.json` on dev has a `decomp_reviewer` role (Qwen3 32B) that hasn't been verified in
  us-east-2. Runs pass `--review-model-role decomp_worker` (Qwen3 Coder 480B) instead.
- New contract `packages/contracts/src/decompRun.ts`, documented in `agents/CONTRACTS.md` §4b.
  Contract changes need sign-off from all three engineers.
