# Gotchas (read before writing code in these areas)

## REA (`rea-agents`)
- The MCP server is the **`mcp` subcommand**: `rea-agents mcp`. **Not `--mcp`.** On Windows,
  launch through `cmd.exe /d /c …` or run `node <rea-agents>/scripts/rea.mjs mcp`.
- Real tool names include `binary_session`, `analyze_javascript_application`,
  `trace_application_feature`, `trace_javascript_semantics` and `inspect_analysis_view`.
  `survey_program`, `function_inventory`, `trace_callees` and `decompile` **do not exist**.
- Verified arguments: `analyze_javascript_application { input_path, format, detail }`,
  `trace_application_feature { application, seed, direction? }`. Catalog: `fixtures/rea/tools.json`;
  real replies: `fixtures/rea/sample_*.json`. All argument building lives in `rea/reaArgs.ts`.
- **With `detail: "summary"`, analyze returns a summary record.** Pass
  `structuredContent.normalized_result.parent_evidence_id` to trace tools. Its own `evidence_id`
  is rejected with `invalid_request` ("Expected authenticated JavaScript analysis…").
- Cold start via `npx` takes ~30 s (warm ~5 s). Install `rea-agents` locally and pre-warm at boot.
- Errors arrive as `isError: true` with a JSON text block `{error:{code, message, details.issues[]}}`,
  not as thrown exceptions.
- `evidence_id` references (`ev_<64 hex>`) only work on the **same MCP connection**. Keep one
  long-lived connection; a restart invalidates them.
- REA wants **absolute** paths. Use `detail: "summary"` on the first analyze call, since a full
  graph can be megabytes.
- Through REA, native targets need Ghidra/IDA/Hopper, and REA's Windows Ghidra support is
  experimental. So the **Electron demo's** live path is `.asar` only, and REA native targets are
  replay-only there. **Native subsystem analysis is a primary goal of the Python engine**, which
  runs Ghidra headless in a Linux Podman worker (no Windows Ghidra involved). Follow
  `DecompPileline.md` for that work, not this file.
- Requires Node 22.19+. Pin `rea-agents@6.7.0` everywhere; never `@latest`.

## Claude on Amazon Bedrock
- Client: `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`. No Anthropic API key exists.
- Models are routed **per role** in root `models.json`, overridable with `MODEL_<ROLE>` env vars,
  and resolved by `packages/backend/src/models.ts` (TS) / `model_config.py` (Python). Splice roles
  (`spec_writer`, `engine_writer`, `ui_synthesizer`, `refusal_fallback`) are **Claude only**: get
  their Bedrock ID with `bedrockModelId(role)`, which strips OpenCode's `amazon-bedrock/` prefix and
  throws on non-Claude IDs. The Mantle client speaks the Anthropic Messages API (structured
  outputs, effort), so Qwen3 Coder 480B, Nova and DeepSeek (listed in `models.json` `options`) are
  for the Python/OpenCode roles only.
- Bedrock has **no server-side `fallbacks`**. `llm.ts` retries a `stop_reason: "refusal"` once on
  the `refusal_fallback` role. Describe tasks as analyzing *our own demo apps*, to avoid tripping the
  cyber safety classifier.
- Opus 5.5: **don't send `thinking`** (disabled / `budget_tokens` → 400). Control depth with
  `output_config.effort`; the default is `medium`, so set it explicitly. Forced `tool_choice` → 400,
  and assistant prefill → 400. Get JSON via `output_config.format: { type: "json_schema", schema }`.
- Structured-output JSON Schemas are hand-written: every object needs
  `additionalProperties: false` + full `required`. Zod adds the stricter checks afterwards.
- Repair loops must be **append-only**: push the assistant's full `content` back unchanged
  (`continueWith`), never edit earlier turns.
- Session credentials (`ASIA…`) expire. `ExpiredTokenException` means refresh them, not a bug.

## Streaming (SSE)
- Our streams are **POST** responses, so the browser can't use `EventSource`. Use
  `fetch` + a stream reader (`frontend/src/api/sse.ts`).
- `server.ts` applies `compression()` but skips it when the request sends
  `Accept: text/event-stream`. **The frontend client must send that header**, or the stream
  gets buffered.
- Detect client disconnect with `res.on("close")` and abort work with the `SseWriter.signal`.

## Contracts and TypeScript
- `@splice/contracts` resolves to `dist/`. **After editing contracts, rebuild them**
  (`npm run build:contracts`), or the backend and frontend will see stale types.
- zod **3** (`z.record(z.string(), z.unknown())` style). No `z.toJSONSchema`.
- The backend is ESM (`"type": "module"`) with NodeNext, so relative imports need `.js`.
  `sandbox/worker.cjs` is plain CommonJS and is not compiled by `tsc`. Copy it to `dist/` for
  production builds.

## Demo targets and fixtures
- `targets/src/**` is LF-only (`.gitattributes`) and frozen after specs are recorded. Line
  numbers are cited in requirements, and the `.asar` sha256 goes into provenance.
- `recall/src/scheduler/sm2.js` must stay exactly 34 lines (CONTRACTS.md §9 cites `L4-L31`).
- Never hand-write transcripts or "live" evidence. Only `_seed/` inputs may be hand-built, and
  they carry `mode: "replay"`.

## Sandbox
- Engine/adapter code and tests run in **one** `vm` context inside a worker thread. Cross-realm
  objects break `deepEqual`, so don't split contexts.
- In oracle mode, a test that never calls original code fails on purpose (call counter). Don't
  "fix" this by removing the counter.
- Step 3 prompts must **never** include `provenance.snippets` or `oracle.adapter_code`. The
  engine is built from the spec alone, and the pitch depends on that.

## Sandpack and frontend
- Tailwind v3 on both sides (Studio config file + Play CDN inside Sandpack's `/public/index.html`).
- Sandpack 2.20's `react-ts` template defaults to **React 19**. Always send `react`/`react-dom`
  `18.3.1` in `customSetup.dependencies`, because the validator type-checks against React 18 types.
- Remount `SandpackProvider` with `key={bundle_id + revision}` on every new bundle.
- Sandpack needs a parent with real height, or it collapses.
- The Sandpack bundler and the Tailwind CDN need internet. Offline demo = the backup video.

## Windows
- `npm` scripts can't run things in parallel with `&`. The root `dev` script uses `concurrently`.
- `asar.listPackage` returns backslash paths with a leading separator; normalize them.
- To check for orphaned REA processes: `Get-Process node`.
