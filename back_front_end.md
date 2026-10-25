# Backend → Frontend Wiring Audit

**Repository**: `/Users/kgozon/HackOHIO_2026`
**Branch**: `feat/robustness-failure-audit-verification`

---

## Overview
This document traces every backend route used by the Splice workflow, maps it to the corresponding frontend API call, the UI component that consumes the data, and evaluates the connectivity status.

## Route Mapping Table

| # | Backend Route (method + path) | Handler (file / function) | Request Schema | Response / SSE Schema | Frontend API Function | Frontend Caller (store / component) | UI Component (renders) | Data Source Type | Connection Status |
|---|------------------------------|---------------------------|----------------|-----------------------|-----------------------|--------------------------------------|------------------------|------------------|-------------------|
| 1 | `GET /api/health` | `packages/backend/src/routes/step1/health.ts` (`healthHandler`) | `{}` (none) | `{ ok: boolean, version: string }` | `liveApi.health()` | `studioState.checkHealth` (init) | N/A (status indicator) | real backend | **Connected** |
| 2 | `GET /api/pantry` | `packages/backend/src/routes/step1/pantry.ts` (`pantryHandler`) | `{}` | `PantryManifest` | `liveApi.pantry()` | `studioState.loadPantry` | N/A (stores manifest) | real backend | **Connected** |
| 3 | `GET /api/evidence/:feature_id` | `packages/backend/src/routes/step1/evidence.ts` (`getEvidenceHandler`) | `{ feature_id: string }` | `RawEvidence` | **none** (no frontend call) | — | — | real backend | **Disconnected** |
| 4 | `POST /api/evidence/collect` | `packages/backend/src/routes/step1/collectEvidence.ts` (`collectEvidenceHandler`) | `{ targetId: string, options?: ... }` | `{ jobId: string }` | **none** (no direct call) | — | — | real backend | **Disconnected** |
| 5 | `POST /api/extract` (SSE) | `packages/backend/src/routes/step2/extract.ts` (`extractHandler`) | `ExtractRequest` | `PipelineEvent` stream | `liveApi.extract()` (`streamPost`) | `studioState.harvest` | Card UI (harvest panel) | real backend (replay & live) | **Connected** |
| 6 | `GET /api/specs` | `packages/backend/src/routes/step2/specs.ts` (`listSpecsHandler`) | `{}` | `FeatureSpec[]` | **none** (frontend never requests) | — | — | real backend | **Disconnected** |
| 7 | `POST /api/implement` (SSE) | `packages/backend/src/routes/step3/implement.ts` (`implementHandler`) | `ImplementRequest` | `PipelineEvent` stream | `liveApi.implement()` (`streamPost`) | `studioState.fuse` | Card UI (implementation panel) | real backend | **Connected** |
| 8 | `GET /api/blueprints` | `packages/backend/src/routes/step3/blueprints.ts` (`blueprintsHandler`) | `{}` | `Blueprint[]` | `liveApi.blueprints()` | `studioState.loadBlueprints` (on refine) | Blueprint picker UI | real backend | **Connected** |
| 9 | `POST /api/synthesize` (SSE) | `packages/backend/src/routes/step3/synthesize.ts` (`synthesizeHandler`) | `SynthesizeRequest` | `PipelineEvent` stream | `liveApi.synthesize()` (`streamPost`) | `studioState.synthesize` | Preview / sandbox UI | real backend | **Connected** |
|10| `POST /api/refine` (SSE) | `packages/backend/src/routes/step3/refine.ts` (`refineHandler`) | `RefineRequest` | `PipelineEvent` stream | `liveApi.refine()` (`streamPost`) | `studioState.refine` | Refine dialog UI | real backend | **Connected** |
|11| `POST /api/native-specs` | `packages/backend/src/routes/native/nativeSpecs.ts` (`createNativeSpecHandler`) | `NativeSpecCreateRequest` | `NativeSpec` | `liveApi.nativeSpec()` | **none** (UI never invokes) | — | real backend | **Disconnected** |
|12| `GET /api/native-specs` | `packages/backend/src/routes/native/nativeSpecs.ts` (`listNativeSpecsHandler`) | `{}` | `NativeSpec[]` | **none** (frontend never calls) | — | — | real backend | **Disconnected** |
|13| `GET /api/native-specs/:artifact` | `packages/backend/src/routes/native/nativeSpecDetail.ts` (`nativeSpecDetailHandler`) | `{ artifact: string }` | `NativeSpec` | **none** (frontend uses pre‑loaded manifest) | — | — | real backend | **Disconnected** |
|14| `POST /api/native-specs/adapt` | `packages/backend/src/routes/native/adaptNativeSpec.ts` (`adaptHandler`) | `AdaptNativeSpecRequest` | `FeatureSpec` | `liveApi.adaptNativeSpec()` | `AppLibrary` (Native Spec tab) | Native Spec view panel | real backend | **Connected** |

## Wiring Gaps Summary
| Gap # | Description | Impact | Suggested Action |
|-------|-------------|--------|------------------|
| G1 | `GET /api/evidence/:feature_id` has no frontend consumer. Evidence is only reachable via `/api/extract` which internally loads the same data. Keeping the endpoint unused adds maintenance overhead. | Low – dead endpoint. | Document as deprecated or remove in future cleanup.
| G2 | `POST /api/evidence/collect` is never called directly. Collection is triggered by the extract step, making this endpoint redundant. | Low – dead endpoint. | Consider deprecating.
| G3 | `GET /api/specs` is not used; specs are retrieved as part of the extract SSE payload. | Low – dead endpoint. | Deprecate or repurpose.
| G4 | `POST /api/native-specs` (create) is defined but UI never invokes it; only adaptation is used. | Medium – potential future feature missing UI integration. | Either add UI button to generate native spec or remove endpoint if not needed.
| G5 | `GET /api/native-specs` and `GET /api/native-specs/:artifact` are unused because native specs are pre‑loaded from the target manifest. | Low – dead endpoints. | Document as legacy or remove.

## Conclusions
* All core pipeline stages (evidence extraction, implementation generation, blueprint retrieval, synthesis, refinement) are fully wired between backend and frontend.
* The majority of disconnected routes are legacy or helper endpoints that are superseded by SSE‑driven flows.
* No missing SSE terminal‑event handling was observed; every `type === "done"` case is processed in `studioState`.
* No hidden promises or workers remain pending after successful test runs.
* The repository passes all type‑checking, build, and test suites.

**Next steps** (outside the scope of this audit) could include cleaning up the dead endpoints or adding UI hooks for the native‑spec creation flow.
