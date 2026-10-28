# E2E Audit Report for Native → Studio Workflow

## 1. Ports and Configuration

| Service | Port | Config File / Location |
|---|---|---|
| Frontend (Vite dev server) | **5175** | `playwright.config.ts` (`webServer.command` uses `npm run dev:frontend` which starts Vite on 5175) |
| Backend (Express/Koa) | **3001** | `packages/backend/src/server.ts` (reads `process.env.PORT ?? 3001`) |
| Additional services (if any) | N/A | No other ports required for the native E2E test |

## 2. Running Processes during Audit

- **Backend**: PID `14111` (Node process listening on `:::3001`).
- **Frontend**: Started automatically by Playwright; no pre‑existing process on `5175`.
- No other services (databases, Docker containers) are needed for this test.

## 3. E2E Execution Command

```bash
REA_MODE=replay CI=1 npm run test:studio
```
- `REA_MODE=replay` forces the backend to emit real `test_result` SSE events instead of the default `mock` mode.
- `CI=1` ensures Playwright installs the required Edge browser.

## 4. Test Outcome

- All **4** Playwright studio tests passed.
- The **native target** scenario succeeded: the success banner appeared, the "Fuse" button became enabled, and the SSE `test_result` event was received.
- No failures were observed.

## 5. Backend ↔ Frontend Integration Details (Native Flow)

| Step | Backend Endpoint | Method | Route | Request Schema | Response Schema | SSE? | Implementing File (Backend) | Caller File (Frontend) | Real / Mock / Fixture | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| Target Discovery | `GET /api/native/targets/:id` | GET | `/api/native/targets/:id` | `{ id: string }` | `{ target: TargetSpec }` | No | `packages/backend/src/routes/native/targets.ts` | `packages/frontend/src/api/client.ts` (`getNativeTarget`) | Fixture (pre‑populated JSON) | **VERIFIED** |
| Spec Generation (adapter) | `POST /api/native/specs/:id/adapt` | POST | `/api/native/specs/:id/adapt` | `{ specId: string, adapterConfig: object }` | `{ featureSpec: FeatureSpec }` | No | `packages/backend/src/routes/native/adapt.ts` | `packages/frontend/src/api/client.ts` (`adaptNativeSpec`) | Fixture‑backed (static example spec) | **VERIFIED** |
| FeatureSpec Retrieval | `GET /api/feature-specs/:id` | GET | `/api/feature-specs/:id` | `{ id: string }` | `{ featureSpec: FeatureSpec }` | No | `packages/backend/src/routes/featureSpec.ts` | `packages/frontend/src/api/client.ts` (`getFeatureSpec`) | Real (generated from fixture spec) | **VERIFIED** |
| Implementation Generation | `POST /api/implementations` | POST | `/api/implementations` | `{ featureSpecId: string, options?: object }` | `{ implementationId: string, artefacts: ... }` | No | `packages/backend/src/routes/implementation.ts` | `packages/frontend/src/api/client.ts` (`createImplementation`) | Real (uses template engine) | **VERIFIED** |
| Blueprint Creation | `GET /api/implementations/:id/blueprint` | GET | `/api/implementations/:id/blueprint` | `{ id: string }` | `{ blueprint: Blueprint }` | No | `packages/backend/src/routes/blueprint.ts` | `packages/frontend/src/api/client.ts` (`getBlueprint`) | Real | **VERIFIED** |
| Synthesis (Sandpack) | `POST /api/synthesis` | POST | `/api/synthesis` | `{ blueprintId: string }` | `{ sandpackUrl: string }` | No | `packages/backend/src/routes/synthesis.ts` | `packages/frontend/src/api/client.ts` (`runSynthesis`) | Real (returns a temporary Sandpack URL) | **VERIFIED** |
| SSE Completion Event | `GET /api/events/sse` | GET | `/api/events/sse` | N/A | SSE stream (`test_result`, `pipeline_done`, …) | Yes | `packages/backend/src/sse.ts` | `packages/frontend/src/ide/AppLibrary.tsx` (listens via `EventSource`) | Real (emitted when REA_MODE=`replay`/`live`) | **VERIFIED** |

**Notes**:
- The native spec endpoints are currently **fixture‑backed**; they return static JSON files located under `packages/backend/fixtures/native/`. No live decompilation is performed.
- All UI callers exist and are exercised by the Playwright test suite.
- No endpoints are mocked at runtime; the only “mock” behavior originates from the fixture data.

## 6. Remaining Limitations

- **Live native analysis** (Ghidra pipeline) is not part of this audit and remains untouched.
- The `GET /api/native/specs` list endpoint is implemented but **not yet used** by the Studio UI (partial integration).
- Fixture data means the workflow does **not** validate a real native binary; this is acceptable for the current demo claim (reconstruction from a known spec).

## 7. Recommendations (Ranked)

| Rank | Recommendation |
|---|---|
| **BLOCKING** | Wire the native spec list endpoint into the Studio UI if future features require browsing multiple native specs. |
| **IMPORTANT** | Replace fixture‑backed native spec generation with a real decompilation backend when Ghidra integration becomes stable. |
| **NICE‑TO‑HAVE** | Add integration tests that verify the exact JSON schema of each request/response against the Zod validators already present.

---
*Audit performed on branch `feat/robustness-failure-audit-verification` (repo root `/Users/kgozon/HackOHIO_2026`). No changes were pushed to `dev`.*