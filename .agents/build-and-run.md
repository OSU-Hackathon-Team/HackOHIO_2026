# Build and run

## Requirements

- **Node 22.19+**. `rea-agents@6.7.0` refuses older versions. Check with `node -v`.
- **AWS credentials with Bedrock access to Claude** (for any live LLM step). Use the default AWS
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

Develop with `REA_MODE=auto LLM_MODE=live`. Without AWS access, use `LLM_MODE=replay` (needs
recorded transcripts) or frontend mock mode.

## Quick health check

```bash
npm run dev:backend
curl http://localhost:3001/api/health            # 200 JSON
curl -X POST http://localhost:3001/api/extract   # 404 JSON until Step 2 implements it
```
