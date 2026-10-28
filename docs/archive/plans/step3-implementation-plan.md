# Step 3 implementation and Studio delivery plan

## Goal and agreed direction

Deliver the complete Step 3 workflow: implement engines from specifications, fuse them into a working React app, inspect the evidence, refine the UI, and export a runnable project.

Use the documented dark Studio with amber, sky, and green pipeline stages. Start with wiki-link graph plus SM-2, then cover all four pantry features. Passing engines may enter fusion when their specs are unverified, with that status and its open issues clearly visible.

Shared infrastructure remains with Engineers 1 and 2. Local checks and live integration are separate acceptance gates.

## Checkpoints and milestones

Effort ranges are initial estimates for one implementer, excluding upstream delivery waits. Re-estimate after each checkpoint using actual results.

| Checkpoint | Deliverable | Measurable exit gate | Estimated effort |
|---|---|---|---|
| **CP0 — Foundation and handoffs** | Dependency agreement, baseline checks, labeled development fixtures, minimal Studio shell | Existing build/typecheck results recorded; shared interfaces documented; mock Studio opens without a backend; missing fixtures produce explicit errors | 3–4 hours |
| **CP1 — Verified engine generation** | Engine prompt, purity and conformance checks, sandbox integration, repair loop, implement and blueprint endpoints | SM-2 passes every acceptance test with zero purity/type errors; failing cases terminate after at most two repairs; prompt isolation checks pass | 5–8 hours |
| **CP2 — Working fusion** | Bundle assembly, virtual TypeScript validator, synthesis endpoint, minimal Sandpack preview | Wiki-link plus SM-2 app validates with zero errors; engine contents remain byte-identical; app boots successfully three consecutive times | 6–8 hours |
| **CP3 — Complete Studio workflow** | Pantry, streaming terminal, cards, evidence drawer, fusion controls, preview/code tabs | Select two features → Harvest → inspect results → Fuse → interact with app; failures remain isolated to their feature; usable at 390 px | 6–9 hours |
| **CP4 — Refinement and export** | Edit/fix endpoint, refine chat, bounded automatic repair, ZIP export | One requested edit works; one automatic fix occurs per bundle chain; engines remain unchanged; exported project installs and builds | 5–7 hours |
| **CP5 — Integration and demo readiness** | Four-feature coverage, recorded replay, performance measurements, rehearsal | All four engines pass; both demo recipes validate and boot three times each; complete live workflow and replay fallback demonstrated | 4–6 hours |

**Milestone A: CP1** proves spec-to-engine reconstruction.  
**Milestone B: CP2** produces the first usable fused application.  
**Milestone C: CP3** delivers the complete user journey.  
**Milestone D: CP5** completes acceptance and demo preparation.

A checkpoint can pass its local checks while its live integration gate remains pending. Test doubles never satisfy a live gate.

## Implementation approach

### Foundation and ownership

- Keep changes within Step 3 backend modules and the frontend. Coordinate shared helper or contract changes explicitly.
- Confirm handoffs for configuration/model routing, structured LLM calls and append-only continuations, sandbox execution, SSE cancellation, transcript recording/replay, pantry, and extraction.
- Use injectable dependencies for local tests; production wiring uses the shared implementations. Do not create competing production helpers.
- Build schema-valid development fixtures under `_seed`, visibly labeled as development data and replay. Never fabricate successful oracle results or recorded transcripts.
- Preserve existing public schemas. Record the discovered `HealthResponse` documentation/runtime mismatch for its owner; the Studio initially consumes the existing runtime fields.
- Follow scoped branches and atomic commits. Do not merge or push without confirmation.

### Engines and synthesis

- Construct engine prompts from an explicit selection of requirements, interfaces, acceptance tests, and allowed deviations. Exclude original snippets and adapter code from initial and repair messages.
- Check purity with TypeScript syntax inspection, strict interface conformance—including declared constants—and the shared acceptance runner. Zero executed tests is a failure.
- Allow an initial generation plus two repairs. Preserve complete assistant responses in repair history; expose failures and actual model identity.
- Assemble entry files and engines on the server. Reject duplicate feature/module identities and prevent generated paths from overwriting server-owned files.
- Validate required files, allowed paths/imports, engine identity, engine imports, and TypeScript compatibility before publishing a bundle.
- After exhausted synthesis or refinement repairs, emit failure diagnostics and `done.ok=false`; do not present an invalid candidate as ready. Retain the previous working bundle during unsuccessful refinement.
- Require passing engine verification for fusion. Carry unverified-spec warnings into the Studio and exported README.

### Studio and refinement

- Implement typed POST-SSE parsing with chunk boundaries, LF/CRLF frames, heartbeats, schema validation, cancellation, and explicit handling of incomplete streams.
- Use Zustand orchestration: run selected feature pipelines concurrently; chain extraction into implementation only after successful extraction; isolate feature failures and ignore stale responses.
- Show real connection state, separate original/engine results, replay provenance, repair progress, and actionable errors. Never infer verification from a green card or a completed HTTP response.
- Provide the documented evidence tabs, keyboard-accessible drawer, responsive layout, and component isolation views.
- Pin generated apps to the contract dependency versions. Give Sandpack a real height, keep preview mounted across code-tab switches, and remount on bundle/revision changes.
- Refinement changes generated files only. Debounce runtime errors, allow one automatic fix per bundle chain, and retain a manual fix action afterward.
- Export a Vite project with the verified engines, generated UI, entry point, dependencies, and setup instructions.

## Verification and measurement

At each checkpoint, run relevant focused tests plus contracts build and workspace typecheck. Run the production build at integration milestones.

Required regression scenarios:

- Source/adapter sentinel text never enters engine prompts.
- Impure code, missing exports, incorrect signatures, empty tests, sandbox failures, and exhausted repairs cannot produce passing engines.
- Forbidden imports, unresolved files, modified engines, missing App, and unused engine imports fail validation.
- Malformed requests fail before SSE starts; aborted streams stop work; successful and unsuccessful streams terminate consistently.
- Interleaved feature streams, failed extraction, duplicate actions, stale events, and failed refinement leave coherent Studio state.
- Replay and development fixtures remain visibly distinguished from live execution.
- Refinement preserves engine bytes and increments revision only for an accepted replacement.
- ZIP output builds, and desktop/mobile keyboard interactions remain usable.

For live runs, record elapsed time, repairs, test counts, validation failures, model, and mode. Measure warm harvest, engine generation, synthesis, and refinement against the documented targets: two-feature harvest under 120 seconds, engine under 45 seconds, synthesis under 75 seconds, refinement under 45 seconds. Report actual timings; exceeding a target triggers optimization or an explicit replay demo choice, never fabricated results.

## Completion assumptions

- No fixed deadline; acceptance gates control progress.
- Full Studio, refinement, automatic repair, evidence inspection, code view, and export are included.
- Native decompilation, dossier migration, authentication, and hosting changes remain outside this plan.
- Bedrock access, upstream delivery, real recordings, and internet-dependent Sandpack execution are explicit integration dependencies.
- Update onboarding status and the team journal with completed gates and measured results. Replace temporary seeds with reviewed real recordings before final demo acceptance.
