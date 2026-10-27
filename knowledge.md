# Project knowledge

## What this project is

**Splice** reconstructs desktop Electron applications from their packaged `app.asar` and a
subsystem-decompilation engine for native binaries. This checkout (`/home/ubuntu/electron-spec`)
focuses on the Electron track: a packaged app is observed behaviorally, a public specification is
written, and an independent agent implements the app from that specification alone.

## Stack & conventions

- Node 22.19+ (ESM `.mjs` scripts, CommonJS generated projects), TypeScript workspaces in
  `packages/`, Python 3 for the decompilation engine track.
- `opencode` (v2) is the agent runtime; models come from `models.json` roles, never literals in code.
- Bedrock credentials come from AWS SSO: write `AWS_*` into a gitignored `.env` with
  `aws configure export-credentials --format env`.
- Work on a scoped branch off `dev`; small conventional commits; stage explicit files; never
  commit `.env`, credentials or generated state.

## Commands the agents should use

- Install: `npm ci`
- Build: `npm run build:contracts` (or `npm run build` for everything)
- Test (Electron track): `npm run test:electron-general` — no credentials needed
- Typecheck: `npm run typecheck`
- Python tests: `npm run test:python`
- Run the Electron pipeline:
  `npm run electron:reconstruct -- <app.asar> <out> [--spec-rounds 2] [--impl-rounds 2] [--state <dir>] [--only <channel[,channel|*]>] [--scope-label <text>]`
  (`--only` reconstructs one subsystem of a large app; the report marks the run scoped and never
  claims whole-app readiness)
- Static inventory only: `npm run electron:analyze -- <app.asar>`
- Desktop smoke test of a generated project: `npm run electron:smoke -- <out>`
- AWS check: `aws sts get-caller-identity`

## Layout

- `scripts/electron/` — the reconstruction pipeline: `oracle.mjs` (mocked Electron host),
  `cases.mjs` (case generation, coverage, partitioning), `spec.mjs` (specification + public
  handoff), `agent-tools.mjs` (specification stage), `implement-tools.mjs` (implementation stage),
  `agent.mjs` (OpenCode stages), `project.mjs` (assembly), `pipeline.mjs` (orchestration).
- `targets/` — demo apps (source and built `app.asar`); `fixtures/` — recorded replay data.
- `packages/` — Splice backend/frontend/contracts (the Studio demo), unrelated to a pipeline run.
- `agents/` — step specs that govern the Studio contracts; `.agents/` — agent onboarding.
- `docs/electron-generalization.md` — how the Electron pipeline works and what it promises.

## Gotchas

- **Two stages are not negotiable.** The implementation agent must never receive the oracle,
  archive path or archive files. If it needs to probe the original, the specification stage is
  incomplete.
- **Sealed final partition.** Final held-out failures/counts never go into agent feedback.
- **Run OpenCode with `--standalone`.** A background service keeps the first run's agent list and
  reports `Agent not found: "spec"` for later stages.
- **No `status` field in a provider model config.** It silently invalidates the config and the
  custom agent disappears.
- Agent context/output defaults: `ELECTRON_AGENT_CONTEXT` 196608, `ELECTRON_AGENT_OUTPUT` 16384.
- Generated cases freeze the clock at `2026-10-25T12:00:00.000Z`; storage roots are `userData`,
  `documents`, `logs`, `temp`.
- Keep large run state (`--state`) on `/mnt/nvme1n1/scratch`, not `/tmp`; the root disk is small.

## Definition of done

- `npm run test:electron-general` passes (CI runs it).- A pipeline run finishes with `readiness.ready: true` in `reconstruction-report.json`: public,
  repair and final partitions all match, no coverage gaps, no observation failures, no declared blocker.
  `readiness.whole_app_ready` additionally requires no exclusions and no `--only` scope.
- The generated project starts with Electron and serves the reconstructed IPC channels.
- Documentation and report labels state the verified scope, exclusions and blockers honestly.
