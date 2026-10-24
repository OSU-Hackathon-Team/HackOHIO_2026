# Native-engine gotchas

- Ghidra's indexed function count is discovery coverage for that analysis revision,
  not behavioral completeness. Export errors and unresolved edges remain visible.
- Scopes are bounded and versioned. Boundary or evidence changes create a new revision;
  do not silently rewrite evidence attached to earlier attempts.
- Workers use stripped analysis inputs. Fixture source and debug companions belong to
  the evaluator. Model claims need citations into immutable exported evidence.
- `static_only` means an independent reviewer supported a claim from static evidence.
  Original execution needs a separately linked probe; one case proves only that case.
- A helper dependency must bind to the caller's actual direct-call target and the
  active contract version. A supported helper claim does not resolve a misbound call.
- Queue lease epochs fence expired workers. Keep checkpoint and rejected draft artifacts;
  retries and reassessment have different meanings.
- Publish claims into explicit semantic slots. Conflicts stay open and contract revisions
  invalidate indexed consumers.
- `queue-init` applies migrations and backfills review jobs. Run it after upgrading an
  existing queue; do not assume earlier accepted tasks are dependency-complete.
- Compose and `worker.Dockerfile` run the rename diagnostic using nested Podman. They
  do not deploy the PostgreSQL reasoning queue.

## Models on Amazon Bedrock
- Client: `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`. No Anthropic API key exists.
- Models are routed **per role** in root `models.json`, overridable with `MODEL_<ROLE>` env vars,
  and resolved by `packages/backend/src/models.ts` (TS) / `model_config.py` (Python). Splice roles
  (`spec_writer`, `engine_writer`, `ui_synthesizer`, `refusal_fallback`) resolve with
  `spliceModel(role)` → `{ id, api }`. Claude IDs use the Anthropic Messages API (Mantle client:
  structured outputs, effort). A non-Claude ID is allowed only if its `models.json` option has
  `splice_compatible: true`; `llm.ts` then uses the **Bedrock Converse API** with a forced `respond`
  tool for schema-shaped JSON (no effort, no prompt caching). All four Splice roles now default to Qwen. Refusal fallback resolves through `spliceModel`; a distinct fallback is attempted once, and same-model retries are skipped. `bedrockModelId` remains the Claude-specific guard for overrides.
- **Account access (verified 2026-10-24, team SSO session creds, us-east-2):** an org SCP denies
  `bedrock-mantle:CreateInference`, and Opus 5.5 / Opus 4.8 / Sonnet 5.5 are "not available for this
  account". **Qwen3 Coder 480B works** (`qwen.qwen3-coder-480b-a35b-v1:0`, bare ID, us-east-2;
  the `us.` profile is rejected), so all four Splice roles are routed to it. `npm run test:llm -w
  @splice/backend -- <role>` checks any role in one call.
- Bedrock has **no server-side `fallbacks`**. Shared dispatch retries refusals once on a distinct `refusal_fallback` model, through either API. Identical defaults are not retried. Describe tasks as analyzing our own demo apps.
- Opus 5.5: **don't send `thinking`** (disabled / `budget_tokens` → 400). Control depth with
  `output_config.effort`; the default is `medium`, so set it explicitly. Forced `tool_choice` → 400,
  and assistant prefill → 400. Get JSON via `output_config.format: { type: "json_schema", schema }`.
- Structured-output JSON Schemas are hand-written: every object needs
  `additionalProperties: false` + full `required`. Zod adds the stricter checks afterwards.
- Repair loops must be **append-only**: push the assistant's full `content` back unchanged
  (`continueWith`), never edit earlier turns.
- Session credentials (`ASIA…`) expire. `ExpiredTokenException` means refresh them, not a bug.

- Converse requests are capped at 16,384 output tokens, matching the [AWS Qwen model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-480b-a35b-instruct.html). Truncation remains a typed error; shorten output rather than requesting above the cap.

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
