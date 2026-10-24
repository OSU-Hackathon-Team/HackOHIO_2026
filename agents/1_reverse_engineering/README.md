# Step 1 — Reverse Engineering (Owner: Engineer 1)

> **Engine update:** Follow [the architecture](../../DecompPileline.md) and
> [implementation plan](../../DECOMP_IMPLEMENTATION_PLAN.md) for native and subsystem work.
> Import/index once, export immutable evidence, and schedule bounded behavioral tasks across
> 16+ reasoning workers. The fixed REA collector and timings below apply to the Electron demo.
> Native analysis is a primary engine path; the old replay-only stretch policy is demo-specific.

**Input:** a pantry feature (`app_id`, `feature_id`, seeds, symbols) from `targets/manifest.json`.
**Output:** a `RawEvidence` object (see `../CONTRACTS.md` §3) that contains the real tool calls
REA made, the source REA located, and REA's limitations.

Step 1 does **not** call Claude in the main path. The collector follows a fixed sequence of REA
calls per target type, which keeps it fast, deterministic and debuggable. Letting Claude drive
REA is an optional stretch mode (`04_evidence_collector.md` §6).

## Docs in this folder (read in order)

| # | File | What you build | Done by |
|---|---|---|---|
| 01 | `01_environment_and_rea_verification.md` | Node/REA install, catalog dump, the facts you must verify at H0 | H1 |
| 02 | `02_demo_targets.md` | Two real Electron apps (Inkwell, Recall), the build script, `manifest.json` | H3 |
| 03 | `03_mcp_bridge.md` | `reaClient.ts`: long-lived stdio MCP client, timeouts, result normalization | H4 |
| 04 | `04_evidence_collector.md` | `collector.ts`: analyze → trace → read source → `RawEvidence` | H8 (CP1) |
| 05 | `05_record_and_replay.md` | Recording evidence and transcripts; replay loader | H12 |
| 06 | `06_backend_server_shell.md` | `server.ts`, `sse.ts`, `/api/health`, `/api/pantry`, config | H6 |
| 07 | `07_testing_and_acceptance.md` | CLI scripts and the acceptance gate | continuous |
| 08 | `08_stretch_native_targets.md` | Optional .NET / native target, replay only | only if ahead at H16 |

## Files you own

```
packages/backend/src/
├── config.ts                    # env parsing (06)
├── server.ts                    # Express app (06)
├── http/sse.ts                  # SSE writer used by every streaming route (06)
├── routes/health.ts             # (06)
├── routes/pantry.ts             # (06)
├── rea/reaClient.ts             # (03)
├── rea/reaArgs.ts               # per-tool argument builders, VERIFIED against tools.json (03)
├── rea/normalize.ts             # turns MCP results into ToolCallRecord pieces (03)
├── rea/asarReader.ts            # reads located files out of the .asar (04)
├── evidence/collector.ts        # (04)
├── evidence/recorder.ts         # (05) also exports the transcript recorder every route uses
├── evidence/replay.ts           # (05) evidence loader + transcript replayer
└── scripts/
    ├── reaCatalog.ts            # (01)
    ├── testBridge.ts            # (07)
    ├── testCollector.ts         # (07)
    └── recordAll.ts             # (05)
scripts/build-targets.mjs        # (02)
targets/**                       # (02)
```

## Interfaces you provide to Engineer 2

```ts
// evidence/collector.ts
export interface CollectorHooks {
  onStage(stage: "connecting" | "analyzing" | "tracing" | "reading_source", message: string): void;
  onToolCall(seq: number, tool: string, argsPreview: string): void;
  onToolResult(rec: ToolCallRecord): void;
  signal?: AbortSignal;
}
export async function collectEvidence(app: PantryApp, feature: PantryFeature, hooks: CollectorHooks): Promise<RawEvidence>;

// evidence/replay.ts
export async function loadRecordedEvidence(featureId: string): Promise<RawEvidence | null>;

// evidence/recorder.ts + evidence/replay.ts  (Eng 2 and Eng 3 use these in their routes)
export function createTranscript(kind: "extract" | "implement" | "synthesize", key: string): Transcript;
export async function replayTranscript(kind: string, key: string, sse: SseWriter, opts?: { speed?: number }): Promise<boolean>;

// http/sse.ts (every streaming route uses this)
export function openSse(req: Request, res: Response): SseWriter;   // send(event), comment(text), close(), signal
```

Step 1 owns the backend **process** (server, config, SSE, record/replay). Steps 2 and 3 each add
their own routes to it. Mount points are in `06_backend_server_shell.md`.

Eng 2 can start before any of this works by using `fixtures/evidence/_seed/*.json`. You write
those seed files at H2 by hand from the target source (02), and delete them at CP2.
