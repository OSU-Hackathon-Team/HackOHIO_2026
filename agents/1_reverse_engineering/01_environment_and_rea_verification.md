# 01 — Environment & REA Verification (H0–H1)

Goal: by the end of hour 1, the team knows **exactly** which REA tools exist and what arguments
they take, so nobody writes code against guesses.

## 1. Machine prerequisites (all three engineers)

| Tool | Version | Check |
|---|---|---|
| Node.js | **22.19.0+** (REA rejects older) | `node -v` |
| npm | 10+ | `npm -v` |
| Git | any | – |
| Anthropic API key | in `packages/backend/.env` | `ANTHROPIC_API_KEY=...` |

Eng 1 only, and only for the stretch native target: a JDK 21 and Ghidra. **Don't install these
before CP2.**

## 2. Install REA as a pinned backend dependency

Don't use `npx -y rea-agents@latest` at runtime: it downloads on every cold start, which is slow
and risky on venue wifi, and `latest` can change mid-hackathon.

```bash
npm install -w @splice/backend --save-exact rea-agents@6.7.0
npx rea-agents --version          # or: node node_modules/rea-agents/scripts/rea.mjs --version
```

Smoke test the CLI path (no MCP yet):

```bash
npm run build:targets              # from 02 — produces targets/build/inkwell/app.asar
npx rea-agents analyze-javascript-application "$(pwd)/targets/build/inkwell/app.asar" --json > /tmp/inkwell.json
```

If this fails, **stop and fix it before anything else**. Everything downstream depends on it.
Common issues:
- Relative path: REA wants **absolute** paths.
- Windows: run from Git Bash or PowerShell, not WSL with a Windows path.

## 3. Dump the MCP catalog — `src/scripts/reaCatalog.ts`

This script is the ground truth for every `// VERIFY` in the other docs.

```ts
// packages/backend/src/scripts/reaCatalog.ts
import fs from "node:fs/promises";
import path from "node:path";
import { rea } from "../rea/reaClient.js";
import { REPO_ROOT } from "../config.js";

async function main() {
  await rea.start();
  const tools = await rea.listTools();
  const session = await rea.callRaw("binary_session", {});

  const outDir = path.join(REPO_ROOT, "fixtures/rea");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "tools.json"), JSON.stringify(tools, null, 2));
  await fs.writeFile(path.join(outDir, "session.json"), JSON.stringify(session, null, 2));

  // Human-readable summary for the team channel
  for (const t of tools) {
    const props = Object.keys((t.inputSchema as any)?.properties ?? {});
    const req = ((t.inputSchema as any)?.required ?? []) as string[];
    console.log(`${t.name.padEnd(36)} required=[${req.join(", ")}] optional=[${props.filter(p => !req.includes(p)).join(", ")}]`);
  }
  console.log(`\n${tools.length} tools. Wrote fixtures/rea/tools.json and session.json`);
  await rea.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

`package.json` script: `"rea:catalog": "tsx src/scripts/reaCatalog.ts"`.

## 4. The verification checklist (post results in team chat at H1)

Fill this table from `tools.json` / `session.json` and paste it into `03_mcp_bridge.md` §4:

| Question | Where to look | Answer |
|---|---|---|
| Arg name for the target path in `analyze_javascript_application` | `inputSchema.properties` | `________` |
| Does `analyze_javascript_application` accept `detail: "summary"`? | same | yes / no |
| Arg names for `trace_application_feature` (`application`, `seed`?) | same | `________` |
| Valid `seed.kind` values | enum in schema | `________` |
| Does `inspect_analysis_view` take `evidence_id` + a page/cursor? | same | `________` |
| Is `trace_javascript_semantics` available? | `session.json → tool_availability` | yes / no |
| Where does `limitations` live in the result? | run one call, inspect `structuredContent` | `________` |
| Where are module paths in the trace result? | same | `________` |

Then do **one manual live call per tool** using `testBridge.ts` (07) against Inkwell and save
the raw results as `fixtures/rea/sample_<tool>.json`. Eng 2 reads these to see what real REA
output looks like.

## 5. Environment file — `packages/backend/.env.example`

```bash
ANTHROPIC_API_KEY=
SPLICE_MODEL=claude-opus-5-5
PORT=3001
REA_MODE=auto              # live | replay | auto
LLM_MODE=live              # live | replay
REA_VERSION=6.7.0
REA_CALL_TIMEOUT_MS=60000  # per tool call
REA_RUN_BUDGET_MS=45000    # whole collection; auto mode falls back to replay after this
REA_MAX_RESULT_CHARS=60000 # bridge truncates tool text beyond this
```

## 6. Known risks and mitigations

| Risk | Mitigation |
|---|---|
| Venue wifi dies | REA runs locally; pinned install means no download. Anthropic calls need internet → `LLM_MODE=replay` fallback |
| REA output shape differs from docs | All shape-dependent code is isolated in `rea/normalize.ts` and `rea/reaArgs.ts` |
| First REA call is slow (cold worker) | `server.ts` calls `rea.start()` + `binary_session` at boot ("pre-warm") |
| Windows process cleanup leaves zombie REA workers | `rea.close()` on `SIGINT`/`SIGTERM`; testBridge checks process count before and after |
