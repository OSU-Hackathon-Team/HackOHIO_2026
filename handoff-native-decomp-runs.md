# Handoff: native decompilation runs from Studio

Updated 2026-10-25, about 01:30 America/New_York. This is for the next agent picking up this work.
Read root `AGENTS.md`, `.agents/README.md` and `development_guidelines.md` first. Ignore the older
`handoff-scoped-native-analysis.md`: it describes code that has since been committed and merged.

## Where things stand

Everything below is merged and pushed to `dev` (last merge `a04b4cd`). Nothing is uncommitted
except the stale `handoff-scoped-native-analysis.md`.

**A LibreOffice run is in flight:** `run-258f6ec3-91b4-4976`, 40 functions, started from the Studio
UI. At handoff time it was in the `setup` stage (`npm ci` for the spec writer).

Check it:

```bash
curl -s http://localhost:3001/api/decomp/runs/run-258f6ec3-91b4-4976
curl -sN http://localhost:3001/api/decomp/runs/run-258f6ec3-91b4-4976/events   # replays history, ends with done
node decomp-state/ec2-tools/remote.mjs                                         # worker instance state
```

The backend that owns the run was started from `packages/backend` with `npx tsx src/server.ts`. If
it was restarted, it resumes polling unfinished runs from `decomp-state/runs/<id>.json`. The worker
stops itself when finished; the shutdown backstop is about 75 minutes after start.

**Things to check when it finishes:**
- `result.spec_writer`:
  - a Qwen model id means the LLM writer ran;
  - `cleanroom-spec-synthesizer` means `npm ci` failed in the container, so look at `console.log`
    in the results.
- `result.spec_status`: probably `draft`. That's expected while the dossier is partial.
- Whether 40 functions at depth 3 reach the operator arithmetic. The 20-function run did not:
  `ScSub` was a two-instruction stub jumping to a function outside scope.
- `docs/handoffs/libreoffice-formula/` is rewritten by the import. Review it before committing.

## What exists (all on dev)

| Piece | Where |
|---|---|
| Studio "Analyze a native application" card | `packages/frontend/src/ide/AnalyzeNative.tsx`, mounted in `ide/AppLibrary.tsx` |
| Live native specs in the app library | `ide/data/liveNative.ts` (pure mapping + event reducer), `store/useIdeStore.ts` (`loadLiveNativeSpecs`, `startDecompRun`, `followDecompRun`) |
| API | `packages/backend/src/routes/decompRuns.ts`: `GET /api/decomp/targets`, `POST /api/decomp/runs`, `GET /api/decomp/runs/:id[/events]` |
| Run service | `packages/backend/src/decomp/`: `payload.ts` (git-tracked whitelist), `ec2.ts` (`DecompWorker`), `progress.ts`, `importRun.ts` (hash-verified), `runs.ts` |
| Contract | `packages/contracts/src/decompRun.ts`, documented in `agents/CONTRACTS.md` §4b |
| Worker runner | `infra/decomp-ec2/run-scoped-pipeline.sh` (LF enforced by `.gitattributes`) |
| Pipeline | `engine/lo_pipeline.py`: `spec_for_dossier` writes `draft` specs for partial dossiers, and `write_handoff` |
| Engineer 2 guide | `docs/decomp-runs.md` |

**Config:** `packages/backend/.env` has `DECOMP_EC2_ENABLED=1`, `DECOMP_EC2_INSTANCE_ID` and
`DECOMP_EC2_BUCKET`. It's gitignored. Never print, copy or commit it.

**Tests at handoff:** backend 162/162, frontend 45/45, typecheck 0 errors, Python suite green.
Run Python in WSL:

```bash
wsl.exe bash -lc 'cd "/mnt/c/Desktop/Coding Projects/HackOHIO_2026" && PYTHONPATH=. python3 -m unittest tests.test_scoped_analysis tests.test_native_engine tests.test_model_runtime'
```

## Next work: the approved plan

Plan file: `C:\Users\pohfe\.claude\plans\yeah-rename-the-branch-federated-eclipse.md`.
The phases are:
- **Phase 0:** AWS Batch on spot EC2 plus ECR and CodeBuild, defined in CDK TypeScript under
  `infra/cdk/`. Replace `ec2.ts` with `batch.ts` behind the same `DecompWorker` interface.
- **Phase 1:** target registry `fixtures/decomp/targets/<id>.json` plus a Studio dropdown.
- **Phase 2:** generic command-line driver for packaged programs.
- **Phase 3:** user-uploaded binaries (presigned S3, GuardDuty scan, static analysis by default).

Agreed separately, to make the payload richer (extraction stays app-agnostic):
- follow tail jumps in `engine/analysis/scripts/ScopedAnalysis.java` (they're only recorded as
  frontier today);
- runtime-guided scope expansion;
- link claims to the formula cases that exercised them;
- larger budgets.

## Rules (from the user)

- **Ask before:**
  - every paid model run;
  - `cdk deploy` or any new AWS resource;
  - commits, merges and pushes. The user has said "push everything to dev" for finished,
    tested work in this stream.
- **Git:**
  - Use feature branches merged into dev with `--no-ff`.
  - Stage files explicitly. Never `git add -A`/`.`.
  - Use the commit trailer from the system reminder.
- **Files owned by others:**
  - Engineer 2 (25kgozon) owns the Studio files (`AppLibrary.tsx`, `useIdeStore.ts`).
  - Engineer 1 owns the engine/decomp files and `worker.Dockerfile`.
  - Flag any edits to these.
  - Contract changes need sign-off from all three engineers.
- **Gates:**
  - Never fabricate oracle observations.
  - Don't weaken `nativeAdapter.ts`'s refusal of draft specs.
  - Never expose held-out cases.
- The user owns `tests/test_lo_pipeline.py`. Don't create it.

## Pitfalls already paid for

- **Windows line endings** killed the first Studio run: bash rejected the CRLF runner. LF is now
  enforced and the backend strips CR too.
- **Stale backend:** a backend started before new routes existed returns 404, and the card used to
  hide itself. Restart the backend after pulling backend changes.
- **Docker containers on the worker:**
  - They need `--cap-add=SYS_PTRACE --security-opt seccomp=unconfined`, or Frida can't attach.
  - Leave `AWS_PROFILE` unset (boto3 rejects a missing profile).
  - The older image needs a runtime `boto3` install. `worker.Dockerfile` now has it, but the image
    on the instance hasn't been rebuilt.
- **Frida and debug symbols:** Frida ignores separate debug files. Hooks are passed as explicit
  offsets from `hook_offsets()`.
- **Warm-up case:** a discarded warm-up case absorbs LibreOffice's lazy first-formula setup.
- **Payload:** hand-made file lists go stale (that's how `engine/behavior.py` went missing). Use
  `buildPayload` (git ls-files).
- **Reviewer model:** use the `decomp_worker` (Qwen3 Coder) role. `decomp_reviewer`
  (Qwen3 32B) in `models.json` is unverified in us-east-2.
- **Tooling on this machine:**
  - Windows has no Python, so run Python in WSL with `MSYS_NO_PATHCONV=1` for paths.
  - The engine needs `fcntl`, so it's Linux only.
- **`agents/CONTRACTS.md`** isn't valid UTF-8. Edit it at byte level; the scratchpad
  `contracts_insert.py` shows how.

## Spend so far today

Bedrock comes to about $0.65 in total; the current 40-function run is estimated at $1.20 and is
approved. EC2 time is a few dollars. The worker is i-01fbcb94645a47036 (m7i.2xlarge, us-east-2).
