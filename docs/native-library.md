# Saved native analyses and building blocks

The App library reads a private S3 catalog through the backend. No Docker volume or new EBS
disk is required. The catalog works while the analysis worker is stopped and does not require
local analysis files after publication.

Set `DECOMP_LIBRARY_BUCKET` on the backend, or reuse its `DECOMP_EC2_BUCKET`. The backend's AWS
identity needs `s3:ListBucket` for `library/*` and `s3:GetObject` / `s3:PutObject` on
`arn:aws:s3:::<bucket>/library/*`. Keep the bucket private. Browsers receive selected data through
the API, never AWS credentials, archive downloads, or public bucket URLs. Library reads do not
require `DECOMP_EC2_ENABLED=1`.

For local development, Vite proxies `/api` to `http://127.0.0.1:3001`, the backend's default.
If you change the backend `PORT`, set `VITE_API_PROXY_TARGET` in
`packages/frontend/.env.development` to the matching URL and restart Vite. After pulling new
backend routes, restart the backend too. An empty HTTP 500 from Vite usually means its proxy
cannot reach the backend; a JSON 404 on `/api/library` from the backend indicates an older
server process. S3 catalog failures return JSON 503 with the storage error.

## Storage and lifecycle

- `library/analyses/<run-id>/evidence.json`: public handoff functions, review verdicts, unknowns,
  hash-verified Ghidra decompilation, original public observations, and a spec when available.
- `library/analyses/<run-id>/manifest.json`: discoverable run summary, published after evidence.
- `library/blocks/<sha256>.json`: a passing `FeatureBlueprint`, keyed by its complete JSON hash.
- Existing `results/<run-id>/results.tgz` archives stay private and retain the full analysis data.
  Held-out cases in those archives are never copied into the catalog or served by this API.

Successful run imports publish their analysis automatically. A rejected spec does not prevent
the evidence from being saved. Successful live Step 3 implementations save passing engines as
building blocks. Failed engines are rejected; authored fixtures and replay events are not
automatically uploaded. Publication errors remain visible as failures rather than falling back
to demonstration data. Local run state and Ghidra scratch files still support the existing
worker orchestration; this feature replaces neither the queue nor those working files.

For a run completed before this feature, publish it without starting EC2 or calling a model:

```sh
node --import tsx packages/backend/src/scripts/publishNativeLibrary.ts <run-id>
```

Set `DECOMP_STATE_DIR` if the run lives outside the checkout. An optional second positional
argument selects the repository containing its current handoff files. The function count must
match the completed run. A missing or tampered referenced artifact fails publication.

## API contract (additive)

Schemas are in `packages/contracts/src/nativeLibrary.ts`.

- `GET /api/library` → `NativeLibrary`: `enabled`, analysis summaries, and passing building blocks.
  An unconfigured backend returns `enabled:false`; S3 or schema failures return 503.
- `GET /api/library/analyses/:id` → `SavedAnalysis`: detailed public evidence. Invalid IDs return
  400, missing objects 404, and storage failures 503.

Saved analyses remain read-only. A `partial` dossier or missing spec is never promoted to a
building block. Engine-test status and source-spec status are displayed separately. **Use in app
builder** loads the exact stored engine into the existing fusion test bench; it does not rerun
decompilation or mark original behavior verified.

Engineer 2 surface changed: `AppLibrary.tsx` mounts the new `SavedNativeLibrary` component.
The contract additions need normal cross-engineer review. The existing draft-spec refusal and
held-out-case boundary are unchanged.

## Observed validation, 2026-10-25

The existing private bucket now contains `run-258f6ec3-91b4-4976`. Read-back through the actual
Express routes returned 200 for the catalog and detail: 40 functions, 40 Ghidra decompilations,
22 public cases, partial readiness, no spec, and zero reusable blocks. This publication used
existing results; it did not start EC2 or make model calls.

Production build and workspace typecheck passed. Offline checks passed: 98 backend source
tests, 161 backend regressions, 45 frontend units, and 2 desktop browser tests. The two
previously reproduced baseline failures were excluded explicitly: native Python spec generation
on Windows and the mocked-live extraction check under replay mode. S3 tests use a fake client;
the live read-back above separately checks the real bucket and API. Browser tests cover saved
evidence, reload, keyboard close/focus restoration, storage errors, and refresh recovery.

## Extracting draft features from saved evidence

> Studio now uses **Discover building blocks** (below) instead of this prompt-driven form. The
> extraction endpoint, its records and library membership remain supported for compatibility.

Open a saved analysis in App library, then use **Extract features**. Supply an optional
natural-language capability and choose all reviewed functions or a single function. Every
request requires a fresh paid-call confirmation. Drafts are listed beneath the controls and
reload from S3. They show requirements, supporting facts, independent static-review reasons,
omissions and readiness limitations. They cannot be used as verified building blocks.

`spec/savedEvidence.ts` adapts saved handoff data to Engineer 2's existing `writeNativeDraft`.
Only independently supported statements pass; contradicted, uncertain and code-shaped or
mechanical statements are omitted with reasons. Stable IDs retain function/claim positions.
Raw Ghidra code, function symbols and review prose do not enter the writer input. Public
observations remain explicitly unlinked context; missing spreadsheet setup is marked unknown.
No application-level observation is silently converted into a function acceptance example.

The same native-draft validation and source-text safety checks apply. New progress/cancellation
hooks preserve existing CLI callers. The extraction output always has `status:draft`: the saved
library does not establish dependency readiness, claim-to-case links or semantic completeness.
Even a saved run labeled ready does not bypass those missing checks through this endpoint.

- `POST /api/library/analyses/:id/extract` takes `NativeExtractionRequest`: `confirm_cost:true`,
  optional `intent` (2,000 characters maximum), and optional `function_entries` (empty means all).
  It emits typed POST-SSE `stage`, `progress`, `extraction`, `error`, and terminal `done` events.
  Invalid requests return 400, unknown functions/no eligible facts 422, missing analyses 404,
  duplicate per-analysis work 409, and disabled storage/model mode 503 before model work.
- `GET /api/library/analyses/:id/extractions` lists saved, hash-checked records. No model runs.
- `library/analyses/<id>/extractions/<sha256>.json` stores the draft and separate analyst audit.
- `library/analyses/<id>/snapshots/<sha256>.json` retains the exact public evidence revision used.

Model work is disabled with `LLM_MODE=replay`. Live requests have a three-minute deadline,
propagate client cancellation, and use the existing writer's three-attempt bound. One backend
process rejects simultaneous extraction for the same analysis. Multiple backend replicas would
need a shared lock before accepting paid work. Model or storage failures never become fake
successes. Cancellation during an already-started S3 write can leave a saved result; **Refresh
drafts** recovers the history without making another model call.

A read-only adapter check on the actual 40-function S3 entry selected 73 facts and omitted 19
claims, with 22 public context observations. It made no model call. Live extraction acceptance
remains pending a separately approved paid run.

Final adapter checks passed: production build, workspace typecheck, 103 backend source tests,
161 compiled backend regressions, 45 frontend units, and 4 desktop browser journeys. The same
two known baseline cases described above were excluded explicitly. Browser extraction responses
and writer/S3 tests are mocked; they establish integration behavior, not live model quality.
Native source safety now also rejects mangled C++ symbols and qualified C++ names, so those
cannot silently enter an extracted draft. The spec writer's existing repair gate enforces this
rule rather than weakening validation.

## Building-block workspace and library membership

Saved applications expand in App library to show **Create building blocks**, **Inspect saved
evidence**, and candidate features already added to the library. Creation uses the main detail
pane. Each extraction produces a candidate card using the writer's actual title and purpose.
Details show inputs, outputs, state, behavior rules, supporting facts, review reasons and checks
still needed. Multiple extracted capabilities can be inspected independently under one app.

**Add to App library** persists a reference to an existing extraction, without a new model call.
The backend loads the immutable record from S3 rather than accepting a browser-provided title,
description or spec. Repeating a save is idempotent. Failed writes remain visible and retryable.
Reloaded membership appears nested beneath the original saved application.

- `GET /api/library/features` returns `{features: NativeExtraction[]}` for library members.
- `POST /api/library/features` takes strict `AddLibraryFeatureRequest` with `analysis_id` and
  `extraction_id`, and returns `{feature: NativeExtraction}`. Unknown records return 404;
  invalid bodies return 400; storage and integrity failures return 503.
- `library/features/<extraction-id>.json` stores only those two reference IDs. Referenced content
  is checked against its content hash whenever it is loaded.

Library membership does not promote a draft or unlock app reuse. Passing engines retain their
separate existing S3 storage and fusion action. No authored example cards are uploaded or
presented as results of live extraction.

Observed UI validation: all 10 desktop Studio browser journeys passed, including candidate
descriptions, independent detail selection, S3 membership/reload, failed-save retry and the
existing chat/library/native-preview flows. All 105 selected backend source tests and 45 frontend
unit tests passed. Production build and typecheck passed. The existing Windows native-Python
source-test case was excluded explicitly. These new generation/save journeys use mocked model
and S3 responses; no paid extraction or additional AWS resource was created for this UI work.

## Discovering building blocks

Open a saved application, choose **Create building blocks**, approve model usage and press
**Discover building blocks**. No prompt or function selection is needed. The flow:

1. **Reviewing evidence.** The backend loads and pins the saved S3 analysis revision and reuses the
   saved-evidence adapter. Unsupported, contradicted, mechanical and source-like claims are
   excluded exactly as for extraction.
2. **Identifying capabilities.** One structured call on the configured `spec_writer` model
   (`spec/discovery.ts`) receives only supported statements with stable claim IDs, arranged in
   opaque groups (`G1`, `G2`, …). Function names, addresses, decompilation and review prose stay
   out. It returns at most five capabilities (name, purpose, claim IDs) and must account for
   every eligible claim, either by assigning it or by recording it as `supporting_only`,
   `insufficient` or `deferred` with a reason. Shared claims are allowed.
   - Validation rejects invented or duplicate IDs, identical claim sets, repeated names,
     unaccounted claims and source-like text. One repair attempt follows a failure.
   - Zero capabilities is a valid answer, but it must come with an explanation.
3. **Writing draft N of M.** Each capability's claims, and only those, go to Engineer 2's
   `writeNativeDraft`. The draft keeps that writer's requirement validation, source safety,
   three attempts and draft-only status, and is saved as an ordinary immutable
   `NativeExtraction` recording the answering model and the pinned analysis hash.
   - Capabilities run one at a time.
   - A failed draft is recorded and the next capability is still attempted.
4. **Report.** `library/analyses/<id>/discoveries/<sha256>.json` records the assignments,
   unassigned claims, saved extraction IDs, failures, discovery model and completion status. It
   is saved even after cancellation.

**Limits:**
- 5 capabilities, 2 discovery attempts and 3 writer attempts per capability, so at most 17 model
  attempts.
- A ten-minute overall deadline, and three minutes per draft.
- Evidence over 300 facts or 60,000 characters is rejected before model work rather than
  truncated.
- Discovery and extraction share the per-analysis lock.

**What discovery doesn't do:**
- It doesn't infer execution order, dependencies or combined behavior.
- Public observations stay context, not acceptance examples.
- **Add to App library** remains an explicit user action. Discovery never promotes a draft or
  creates an engine.

**Studio states:**
- **Complete** and **partial** (with per-capability failures).
- **Empty:** "no useful capabilities", with the model's explanation and the unassigned facts.
- **Insufficient evidence:** no supported facts. The button is disabled, and the API returns 422
  before model work.
- **Cancelled:** drafts saved before cancelling remain available.
- **Failed:** backend, model or storage failures. An incomplete stream counts as a failure.
