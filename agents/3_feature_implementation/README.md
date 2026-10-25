# Step 3 — Feature Implementation (Owner: Engineer 3)

**Input:** `FeatureSpec`s from Step 2: requirements, a TypeScript interface, and acceptance tests
already proven against the original app.
**Output:**
1. **Engines.** One pure TypeScript module per feature that passes the spec's acceptance tests
   → `FeatureBlueprint` (`POST /api/implement`).
2. **The fused app.** A React UI generated around the **unchanged** engines, validated and run
   live in Sandpack → `SynthesisBundle` (`POST /api/synthesize`, `POST /api/refine`).
3. **The Studio.** The whole frontend the judges see.

**Key property for the pitch:** Step 3 **never sees the original source code.** The engine is
written from the spec alone (requirements, interface, tests). Step 2 proved those tests against
the original, so passing them means the engine matches the original's observed behaviour without
copying its code.

```
FeatureSpec ──▶ implement engine (Bedrock) ──▶ purity scan ─▶ type conformance (tsc) ─▶ acceptance tests (sandbox)
                      ▲                                                                          │
                      └──────────── repair ≤ 2 (failures fed back) ◀────────────── fail ─────────┘
                                                                                     pass ▼
                                                                          FeatureBlueprint (card: "Engine 7/7")
Blueprints + prompt ──▶ synthesize UI (Bedrock) ──▶ server injects engines + entry files ──▶ validator (paths, imports, tsc)
                                                                                    fix ≤ 2 ◀── errors │ ok ▼
                                                                                                SynthesisBundle ──▶ Sandpack
Sandpack runtime error ──▶ /api/refine kind "fix" (auto, once) ;  user chat ──▶ /api/refine kind "edit"
```

## Docs in this folder (read in order)

| # | File | What you build | Done by |
|---|---|---|---|
| 01 | `01_engine_implementation.md` | `/api/implement`, engine prompt, purity scan, conformance check, repair, `/api/blueprints` | H8 (CP1) |
| 02 | `02_ui_synthesis.md` | `/api/synthesize`, synthesis prompt, server-side engine injection | H12 |
| 03 | `03_bundle_validator.md` | Virtual-filesystem `tsc` type-check, import and path rules (shared with 01) | H12 |
| 04 | `04_refine_and_autofix.md` | `/api/refine` (edit + fix) and the auto-fix loop | H16 |
| 05 | `05_frontend_setup.md` | Vite + React + Tailwind + Sandpack scaffold, proxy, folder layout | H1 |
| 06 | `06_state_and_api_client.md` | zustand store, POST-SSE client, pipeline orchestration, mock mode | H6 |
| 07 | `07_components.md` | Layout, Pantry, Terminal, FeatureCard, EvidenceDrawer, FusionPanel | H12 |
| 08 | `08_sandpack_studio.md` | Live preview, code view, runtime-error capture, export ZIP | H14 |
| 09 | `09_demo_runbook.md` | Pre-flight, the 3-minute script, fallbacks, judge Q&A (whole team) | H20 |

## Scope control (Eng 3 has the most surface area)

**Must have (CP2):** implement route, synthesize route, validator, Pantry, Terminal,
FeatureCard (front + back), Sandpack preview, Fuse button.
**Should have (H18):** refine chat, auto-fix, EvidenceDrawer with the "original vs engine" test
table, REPLAY badges.
**Nice to have:** export ZIP, code tab file explorer polish, animations.

Reuse, don't rebuild: `structuredCall` / `continueWith` (Eng 2, `llm/llm.ts`), `runTests`
(Eng 2, `sandbox/`), `openSse` / `createTranscript` / `replayTranscript` (Eng 1).

## Files you own

```
packages/backend/src/
├── engine/prompt.ts            # (01)
├── engine/purity.ts            # (01)
├── engine/implement.ts         # (01) FeatureSpec → FeatureBlueprint
├── engine/store.ts             # (01)
├── synthesis/prompt.ts         # (02)
├── synthesis/assemble.ts       # (02) engines + entry files + generated files → bundle
├── synthesis/synthesize.ts     # (02)
├── synthesis/refine.ts         # (04)
├── typecheck/virtualTsc.ts     # (03)
├── synthesis/validateBundle.ts # (03)
├── routes/step3/index.ts       # (01, 02, 04)
└── scripts/testImplement.ts, testSynthesis.ts
packages/frontend/**            # (05–08)
```

## Step 3 acceptance gate

- [ ] `npm run test:implement` → all 4 golden specs produce engines with N/N acceptance tests passing, 0 purity violations, 0 type errors
- [ ] `npm run test:synthesis` → the 2 demo recipes produce bundles that pass the validator with 0 errors, engines byte-identical
- [ ] Bundles boot in Sandpack with no runtime error on first load (3 runs in a row per recipe)
- [ ] Studio works end-to-end live: select 2 features → Harvest → cards reach "Engine N/N" → Fuse → app runs → one refine works
- [ ] `VITE_API_MODE=mock npm run dev` works with **no backend running**
- [ ] REPLAY badges appear on everything that came from replay
- [ ] Usable at 390 px wide (cards stack, studio below)
