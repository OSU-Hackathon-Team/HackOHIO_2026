# Handoff: move every Opus role to Qwen

> Historical handoff. The Qwen/Studio milestone is implemented; see the update at the end and `docs/STEP3_MILESTONE.md` before acting on the original task list.

**Branch:** `feat/step3-backend` (not merged or pushed; ask the user before doing either)
**Last commit:** `36e1309`. Suite: 61/61 (`npm run test:unit -w @splice/backend`), `npm run typecheck` exits 0.
**Read first:** `.agents/README.md`, `.agents/gotchas.md` (section "Claude on Amazon Bedrock"), `development_guidelines.md`.

## Goal

Route every role that currently points at a Claude Opus model to Qwen on Bedrock. The team's AWS account
can't reach Claude:
- An org SCP denies `bedrock-mantle:CreateInference`.
- Opus 5.5, Opus 4.8 and Sonnet 5.5 return "not available for this account".
- Opus 4.6 worked once, then failed with "AWS Marketplace actions not authorized".

Qwen3 Coder 480B does work, and it's already the `engine_writer`.

## What already works

- `packages/backend/src/llm/llm.ts` has two paths, and `spliceModel(role)` in
  `packages/backend/src/models.ts` picks between them:
  - **`anthropic`:** Claude IDs.
  - **`converse`:** any non-Claude ID whose `models.json` option has `splice_compatible: true`.
- The Converse path uses `ConverseStreamCommand` and forces a `respond` tool whose `inputSchema` is the JSON
  schema. It returns the same `StructuredResult` shape, so callers don't change.
- Live check, one call per role: `npm run test:llm -w @splice/backend -- <role>`. It prints the resolved ID and
  API, and exits 0 if the model answers `{ answer: 391 }`.
- The verified Qwen ID is `qwen.qwen3-coder-480b-a35b-v1:0`. Use the **bare ID** in us-east-2; the `us.`
  inference profile is rejected.

## Opus instances to change

| Where | Current | Action |
|---|---|---|
| `models.json` `roles.spec_writer` | `anthropic.claude-opus-5-5` | → Qwen; update its `role_notes` ("Claude only" is no longer true) |
| `models.json` `roles.ui_synthesizer` | `anthropic.claude-opus-5-5` | → Qwen; update `role_notes` |
| `models.json` `roles.refusal_fallback` | `anthropic.claude-opus-4-8` | **Needs code changes, see below** |
| `models.json` `roles.legal_verification` | `anthropic.claude-opus-4-6-v1` | Belongs to the Python track (`model_config.py`); see below |
| `models.json` `$comment` | "refusal_fallback must be Claude" | Rewrite to match the new rule |
| `.env.example`, `packages/backend/.env.example` | commented `MODEL_*=…opus…` examples (root also has two **uncommented** lines, 24–25) | Point at Qwen or delete. Check that the uncommented root lines aren't overriding `models.json` for anyone |
| `compose.yaml:64`, `docker-compose.yml:64` | `MODEL_LEGAL_VERIFICATION` default is Opus 4.6 | Same decision as `legal_verification` |
| `README.md:30` | `legal_verification` table row | Same |
| Docs: `agents/1_reverse_engineering/01_…md:104-107`, `agents/2_requirements_extraction/02_llm_client.md:33-36,45,59-63`, `agents/README.md:174,223`, `agents/3_feature_implementation/09_demo_runbook.md:104` ("Which model?" answer) | Opus references | Update the examples, and fix the runbook's judge answer so it doesn't name Claude |

Find any others with `rg -i opus --glob '!node_modules' --glob '!dist' --glob '!docs/archive'`.

## Code changes the switch needs

1. **`refusal_fallback`:** this one doesn't work by editing `models.json` alone.
   - `bedrockModelId()` in `models.ts` throws for non-Claude IDs. `llm.ts` (around line 170) calls it for the
     fallback, and only on the Anthropic path.
   - The Converse path (around line 259) throws `LlmRefusalError` on `content_filtered` /
     `guardrail_intervened` and never retries.
   - Pick one of these:
     - (a) Route `refusal_fallback` to Qwen through `spliceModel` and add a one-shot retry to the Converse path.
     - (b) Leave the fallback Claude-only, since it's unreachable while every role is on Qwen, and document
       that.
   - (b) is smaller. Either way, update the `bedrockModelId` guard, the `models.json` comment and the
     `gotchas.md` entry, so the "must be Claude" rule isn't left half true.
2. **Token limits:** `synthesize.ts:56` and `refine.ts:83` ask for `maxTokens: 48_000`, and `implement.ts:36`
   asks for 24 000.
   - Check Qwen3 Coder's maximum output tokens on Bedrock. If 48k is above it, the request fails or truncates
     (`LlmTruncatedError`).
   - If needed, lower the limit and note it in `02_llm_client.md`.
3. **Effort and caching:** both are silently dropped on Converse. Nothing to fix, but the spec/UI prompts were
   written with `effort: "high"`/`"medium"` in mind. Expect quality differences and judge them on real output.
4. **Qwen model choice:** only Qwen3 Coder is in `models.json` `options`.
   - `spec_writer` is mostly prose plus requirements, so a general Qwen model may suit it better than the coder
     model. Probe any candidate with `test:llm` before adding it.
   - Add every ID you use to `options` with `family: "qwen"` and `splice_compatible: true`, plus a `note`
     saying where it was verified.
   - Never write `latest` and never hard-code IDs in code (`.agents/README.md` rules).
5. **`legal_verification`:** this is the Python decomp track (`model_config.py`, OpenCode `provider/model`
   format), not `llm.ts`. Switching it only means changing the ID, but it's not our step. Ask the user before
   changing it, and say so in the commit.
6. **Tests:**
   - `llm.test.ts` asserts Claude-path behaviour (for example, no `thinking` in the request). Those tests still
     hold, because they inject the model.
   - Add a test that `spliceModel("spec_writer")` and `spliceModel("ui_synthesizer")` resolve to `converse`
     with the new `models.json`.
   - Change any test that relied on the old refusal-fallback rule.

## Verification

1. `npm run build:contracts && npm run typecheck` exits 0.
2. `npm run test:unit -w @splice/backend` passes. Record the count.
3. Run `npm run test:llm -w @splice/backend -- spec_writer`, then the same with `ui_synthesizer` and
   `engine_writer`. All three should report `(converse)` and answer 391.
4. Record the actual output in `docs/archive/implementation_frontend/accomplishments.md` (per-commit table),
   and add a row to `agents/JOURNAL.md` for the decision.

## Credentials

`packages/backend/.env` is gitignored and holds the user's **temporary** AWS SSO session credentials, with
`AWS_REGION=us-east-2`.
- `ExpiredTokenException` means the credentials need refreshing; ask the user for new ones.
- Never commit `.env` or paste the credentials anywhere.

## Git

- Make atomic conventional commits and stage files explicitly (never `git add -A` / `git add .`).
- Suggested split:
  - `feat(backend): route all Splice roles to Qwen on Bedrock`: `models.json`, `models.ts`, `llm.ts`, tests.
  - `docs: …`: specs, gotchas, README, journal, accomplishments.
- End each commit with the `Co-Authored-By` trailer the session gives you.
- Leave the user's untracked `PLAN.md` and their `frontend_guidelines.md` move alone.

## Still open after this (not part of this task)

- `sandbox/runTests.ts` (Eng 2) and a labelled `_seed` spec in `fixtures/specs/_seed/`. These are needed before
  `npm run test:implement` can produce a verified engine.
- Wiring `routes/step3/deps.ts`, which waits on Eng 1's sse/recorder/replay/config.
- Frontend specs 05–08.
- Team approval of the `HealthResponse.models` contract change (`78362ef`).

## Update: Qwen and core Studio milestone

The migration described above is now implemented for all four **Splice** roles. Python legal_verification is intentionally unchanged, as agreed with the user. Qwen smoke calls pass for the three primary roles. Fallback dispatch supports either API once and skips same-model retry; Converse is capped at 16,384 output tokens. Core Studio development mode implements Harvest, evidence, Fuse, and working Sandpack preview/code. See `docs/STEP3_MILESTONE.md` for reproduction commands, measured checks, and remaining live dependencies. Refinement/auto-fix/export are next milestone. The user explicitly authorized merging and pushing the verified milestone to dev.
