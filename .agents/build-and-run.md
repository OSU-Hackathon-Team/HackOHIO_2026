# Build and run

The [root README](../README.md) is the detailed CLI reference. Run commands from the repo
root. Python dependencies are in `requirements-decomp.txt`. Ghidra headless and a C compiler
are needed for native analysis and fixture builds. Queue checks need PostgreSQL.

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

The export and scope checks invoke Ghidra. Fixture builds write ignored data under
`decomp-state/fixtures/`. Model-backed checks may incur cost. Queue and findings checks
create disposable PostgreSQL databases; consult the root README for prerequisites.

Analyze a binary and discover a scope:

```sh
python launch.py analyze --binary /absolute/path/to/program
python launch.py status
python launch.py scope --manifest decomp-state/projects/<campaign>/manifest.json \
  --request fixtures/decomp/scope_request.json
```

Use `python launch.py --help` for the full CLI. Models come from `models.json` or a
`MODEL_<ROLE>` override. Keep credentials in the ignored `.env` or process environment.
The rename diagnostic uses Docker Compose and nested Podman:

```sh
docker compose build orchestrator
docker compose run --rm orchestrator python launch.py build
```

Outputs go to `runs/<attempt-id>/` (gitignored). Models come from `models.json` roles via
`model_config.py`. The planned `engine/` package and its gates are in `DECOMP_IMPLEMENTATION_PLAN.md`.

## Quick health check

```bash
npm run dev:backend
curl http://localhost:3001/api/health            # 200 JSON
curl -X POST http://localhost:3001/api/extract   # 404 JSON until Step 2 implements it
```

## Core Studio milestone

- `npm run seed:studio -w @splice/backend`: regenerate authored development seeds and run six local engine checks plus purity/conformance/bundle validation. No original-code oracle is run.
- Open `http://localhost:5173/?mode=development` for the fixed two-feature study-room demo. Live mode never silently falls back to this data.
- `npm run test:unit -w @splice/frontend`: POST-SSE and state regression tests.
- `npm run test:studio`: headless Edge browser checks on isolated port 5175; Sandpack needs internet.
- Current acceptance and blockers: `docs/STEP3_MILESTONE.md`.
