# Qwen and core Studio milestone

## What works

All four Splice roles default to Qwen3 Coder 480B over Bedrock Converse. Python roles are unchanged.
Claude overrides remain supported. A refusal can use one distinct fallback, even across APIs;
the identical Qwen default is not called twice. Converse output is capped centrally at 16,384 tokens
according to the [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-480b-a35b-instruct.html).

The Studio implements pantry selection, parallel Harvest orchestration, activity logs, feature
cards and X-Ray, an accessible evidence drawer, fusion, and Sandpack preview/code views. Passing
engine verification is separate from specification verification. Unverified specs remain visible.
Failed streams cannot mark a feature ready; cancellation ignores late responses. Failed fusion
retains the previous working bundle. Generated engine files are read-only in the Studio.

## Run and reproduce

1. `npm ci`, then `npm run build:contracts`.
2. `npm run seed:studio -w @splice/backend` regenerates the authored seeds and validates them.
3. `npm run dev:frontend`; open `http://localhost:5173/?mode=development`.
4. Select **Wiki-link graph & backlinks** and **SM-2 spaced repetition**, then **Harvest 2 features**.
5. Inspect X-Ray and evidence; the original-code oracle is explicitly **Not run**.
6. Fuse both engines. Review a card, add a note containing `[[Cardiology]]`, then switch Code → Preview.

`VITE_API_MODE=mock` selects the same development adapter. This runs without a backend, but Sandpack
and Tailwind CDN still require internet. Live mode is the default and never falls back silently.
Development mode supports a fixed authored study room, not arbitrary prompt-driven generation.

## Measured checks

| Check | Observed result |
|---|---|
| Initial backend baseline | 61/61 tests; typecheck and production build passed |
| Qwen migration unit checks | 14/14 LLM tests, including four new cases |
| Live `spec_writer` smoke | Converse, answer 391, 0.5s |
| Live `engine_writer` smoke | Converse, answer 391, 0.5s |
| Live `ui_synthesizer` smoke | Converse, answer 391, 0.6s |
| Development seed checks | Six local acceptance checks, zero purity/conformance errors; bundle validation passed |
| Frontend regression suite | 10/10 tests, about 3.9s; split UTF-8/CRLF SSE, backend errors, incomplete streams, parallel features, cancellation, duplicate/stale work, failed fusion |
| Headless Edge | 5/5 tests, 19.3s on the final visual check; 390px layout, modal focus/Escape, live 503 visibility, three consecutive Sandpack boots with engine interaction and preserved tab state |
| Final backend suite | 65/65 tests, about 18.8s |
| Production checks | Health/SPA/blueprints 200; unknown API 404; malformed implement 400; valid implement 503 |

The seed checks use a small local VM harness for authored inputs, not the production sandbox.
They establish only those checked cases. Fixtures are under `_seed`, carry replay mode plus
development-specific labels, and have no invented REA calls, original source, or oracle successes. The authored example uses a few inline layout styles so the basic app remains usable if the Tailwind CDN is unavailable; model-generated UI still follows the documented Tailwind prompt.
Their targets use real archive hashes as identifiers; no original behavior was checked.

Run `npm run test:unit -w @splice/frontend`, `npm run test:unit -w @splice/backend`,
`npm run typecheck`, `npm run build`, and `npm run test:studio` to reproduce the automated gates.
Browser tests use installed Microsoft Edge on isolated port 5175, leaving port 5173 alone.

## Still pending

- Eng 2 sandbox and requirements extraction, followed by production wiring in `routes/step3/deps.ts`. Eng 1 SSE/configuration, archive/REA helpers, record/replay and pantry/health endpoints landed during final integration. Valid Step 3 requests still return 503 because the sandbox is not implemented.
- Live REA and model access acceptance remain separate from health. Health now conforms to the runtime schema. The Studio distinguishes disconnected/replay REA from unavailable health and shows the configured UI model without claiming model-access readiness.
- Genuine extraction recordings, golden specs/blueprints, live synthesis quality and timings,
  and full live Harvest → Fuse acceptance. Smoke arithmetic is not generation-quality evidence.
- Refinement chat, automatic repair, ZIP export, additional development feature seeds, and component
  isolation URLs remain later work. Existing backend refinement is retained.
- Team approval of the existing `HealthResponse.models` contract addition remains outstanding.

Existing hand-authored fixtures or historical journal rows are not recordings of live runs.
User-authored PLAN.md and the frontend-guidelines move are preserved separately from this milestone.

## Integration with latest dev

The incoming dev changes add hand-authored fixtures, contract schema tests, and improved static SPA serving. Both dependency additions are retained. The two Inkwell restorations differed only in the final source newline; dev's latest source/archive/hash set was kept together, and our seed metadata was regenerated to match. The Windows working-tree `npm ci` attempt hit a native Rollup file lock; dependencies were restored with `npm install --ignore-scripts` before post-merge checks.

Post-merge checks passed: production build, workspace typecheck, 13 incoming contract tests, 65 backend unit tests, 10 frontend tests, and 5 browser tests (38.5s under concurrent build/test load). Both target archive checksums match; Inkwell source is byte-identical to its archived module. Production HTTP checks again returned 200/200/404/200 and implement 400/503 as expected. The Windows file-lock cleanup warnings concern ignored node_modules only.

A subsequent teammate push (`8380f3d`) supplied the Step 1 helpers and tests. The initial Step 1 run passed 22/24 and exposed a Windows archive separator bug. The shared reader now converts validated POSIX keys to host separators for asar extraction; the existing two archive-reading cases cover the fix. Step 3 production wiring still waits on the missing sandbox.

Final integrated checks: 24/24 Step 1 tests after the Windows fix, 13/13 contract tests, 65/65 Step 3 backend unit tests, 10/10 frontend unit tests, 5/5 browser tests (26.2s), production build, workspace typecheck and production HTTP gate all passed. `GET /api/pantry` now also returns 200. The implement 503 diagnostic lists only the missing sandbox.
