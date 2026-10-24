# Build and run

## Requirements

- **Node 22.19+**. `rea-agents@6.7.0` refuses older versions. Check with `node -v`.
- **AWS credentials with Bedrock access to the configured model (Qwen by default)** (for any live LLM step). Use the default AWS
  chain: `AWS_PROFILE` or session env vars in `packages/backend/.env`, copied from
  `packages/backend/.env.example`. Check with `aws sts get-caller-identity`.
- Windows works. Commands below are for Git Bash or PowerShell; the team develops on Windows.

## First-time setup

```bash
npm ci                       # installs exactly from package-lock.json (all workspaces)
npm run build:contracts      # contracts compile to packages/contracts/dist — backend & frontend import that
cp packages/backend/.env.example packages/backend/.env      # then fill AWS_* (never commit .env)
cp packages/frontend/.env.example packages/frontend/.env.development
```

Step-specific dependencies aren't installed yet. Install each when you implement its module,
with the exact command in its spec doc (e.g. `npm install -w @splice/backend --save-exact rea-agents@6.7.0`),
and commit the lockfile change in the same branch.

## Everyday commands (run from repo root)

| Goal | Command |
|---|---|
| Everything in dev mode (contracts watch + backend + frontend) | `npm run dev` |
| Backend only (tsx watch, :3001) | `npm run dev:backend` |
| Frontend only (Vite, :5173, proxies `/api` → :3001) | `npm run dev:frontend` |
| Frontend with **no backend** | set `VITE_API_MODE=mock` in `packages/frontend/.env.development`, then `npm run dev:frontend` |
| Rebuild contracts after editing them | `npm run build:contracts` (or keep `npm run dev` running) |
| Typecheck all packages | `npm run typecheck` |
| Production build (contracts → backend → frontend) | `npm run build` |
| Pack demo targets into `.asar` | `npm run build:targets` (needs `npm install -D --save-exact @electron/asar` at the root first) |

**Definition of "it compiles":** `npm run build:contracts && npm run typecheck` exits 0.

## Per-module scripts (`npm run <script> -w @splice/backend`)

Each script runs one module alone. "Done" for a module means its script passes.

| Script | Owner | Checks |
|---|---|---|
| `rea:catalog` | Eng 1 | Dumps REA's real tool list to `fixtures/rea/tools.json`. **Run this before writing any REA call** |
| `test:bridge` | Eng 1 | MCP connect, `binary_session`, analyze + trace Inkwell |
| `test:collector [feature_id]` | Eng 1 | Full Step 1 per feature → `fixtures/evidence/*.latest.json` |
| `seed:evidence` | Eng 1 | Hand-built seed evidence from target source → `fixtures/evidence/_seed/` |
| `record:evidence` | Eng 1 | Records live evidence for every feature |
| `fixtures:promote [id]` | anyone | Copies `*.latest.json` → golden `*.json` (only after a human reviewed it) |
| `test:llm` | Eng 2 | Bedrock smoke test (structured JSON) |
| `test:sandbox` | Eng 2 | Oracle/acceptance runner incl. cheating-adapter and infinite-loop cases |
| `test:spec [feature_id]` / `spec:all` | Eng 2 | Step 2 on recorded evidence; prints requirements + oracle results |
| `test:implement [feature_id]` | Eng 3 | Step 3a engine from a golden spec |
| `test:synthesis` | Eng 3 | The demo recipes → validated bundles |
| `test:unit` | all | `node:test` files `src/**/*.test.ts` |

## Runtime modes (backend `.env`)

| Var | Values | Effect |
|---|---|---|
| `REA_MODE` | `live` / `replay` / `auto` | `auto` tries live REA, then falls back to recorded evidence after 45 s or on error |
| `LLM_MODE` | `live` / `replay` | `replay` re-emits recorded transcripts with their timing; no Bedrock calls |

`mock` (the default in the Dockerfile, compose files and root `.env.example`, which CI uses) is
accepted as an alias for `replay`. Develop with `REA_MODE=auto LLM_MODE=live`. Without AWS access, use `LLM_MODE=replay` (needs
recorded transcripts) or frontend mock mode.

## CI

`.github/workflows/ci.yml` runs on pushes to dev/main and manual dispatch:

1. Install with `npm ci`, build, and run `npm run typecheck`.
2. `npm test` runs Step 1 integration and contract tests (24 + 13 cases).
3. `npm run test:unit --workspaces --if-present` runs backend and frontend unit tests (65 + 10 cases). Quoted globs preserve nested route tests on Linux.
4. Install pinned Playwright Chromium and run the two core Studio browser checks. Failed runs upload screenshots/traces for seven days. Local runs still use Edge.
5. Docker build and endpoint smoke tests run only after both regression and browser jobs pass. The builder includes frontend fixture/manifest imports, models.json is shipped to the runner, and TypeScript remains a production dependency because the backend imports its compiler API at runtime. Docker checks health/pantry/blueprint schemas, configured model roles, malformed-request 400 behavior and the existing SPA/API guard.

All automatic tests use replay mode and need no AWS credentials or live REA/model calls. Manual dispatch with **sandpack=true** runs all five Studio tests, including three external Sandpack boots; those require internet access to Sandpack. The default browser gate excludes them.

Reproduce the CI browser selection locally (PowerShell): set `$env:CI='true'`, run `npx playwright install chromium`, then `npm run test:studio -- --grep-invert "Sandpack boots"`. Clear CI afterward. See [Playwright CI guidance](https://playwright.dev/docs/ci-intro).

Before pushing backend changes, run `npm run build`. Start the production server and check health/SPA 200 and unknown API 404. Actual Docker execution requires a Docker-enabled machine.

## Decompilation engine track (Python, Docker only)

From the root `README.md`. The host runs Docker Compose only:

```bash
docker compose build orchestrator
docker compose run --rm orchestrator python launch.py build          # builds the Ghidra worker image (slow, GBs)
docker compose run --rm orchestrator python launch.py rename \
  --binary /workspace/path/to/binary --address 0x401126 --new-name parse_packet
```

Outputs go to `runs/<attempt-id>/` (gitignored). Models come from `models.json` roles via
`model_config.py`. The native `engine/` package and its gates are in `DECOMP_IMPLEMENTATION_PLAN.md`.

For native analysis and queue commands, see the root `README.md`. Install
`requirements-decomp.txt`; fixture builds need a C compiler, export and scope checks need
Ghidra headless, and queue checks need PostgreSQL.

Generate a native spec from a dossier with `python launch.py spec --dossier-artifact <sha256>`;
run `python scripts/check_decomp_spec.py` for the handoff check. Backend callers use
`POST /api/native-specs` and `GET /api/native-specs/:artifact` with `DECOMP_STATE_DIR` pointing
at the engine state directory if needed.

## Quick health check

```bash
npm run dev:backend
curl http://localhost:3001/api/health            # 200 JSON (connectivity & model routing metadata)
curl http://localhost:3001/api/pantry            # 200 JSON (available targets and feature list)
curl http://localhost:3001/api/nonexistent       # 404 JSON (API 404 guard)
curl -X POST http://localhost:3001/api/extract   # 400 JSON without body; active POST SSE route
```

## Core Studio milestone

- `npm run seed:studio -w @splice/backend`: regenerate authored development seeds and run six local engine checks plus purity/conformance/bundle validation. No original-code oracle is run.
- Open `http://localhost:5173/?mode=development` for the fixed two-feature study-room demo. Live mode never silently falls back to this data.
- `npm run test:unit -w @splice/frontend`: POST-SSE and state regression tests.
- `npm run test:studio`: browser checks on isolated port 5175. Default channel is MS Edge; for CI / headless Chromium run `CI=true npx playwright test --grep-invert "Sandpack boots"` (install Chromium with `npx playwright install chromium`). Full Sandpack boot tests require internet.
- Current acceptance and blockers: `docs/STEP3_MILESTONE.md`.

