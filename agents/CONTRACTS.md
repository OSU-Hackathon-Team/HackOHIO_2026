# Shared Contracts — single source of truth

Copy this file's code blocks verbatim into `packages/contracts/src/`. If a doc anywhere else
disagrees with this file, **this file wins**. Changes need a PR touching both this file and the
package, approved by all three engineers.

Pipeline types: `RawEvidence` (Step 1 → 2) → `FeatureSpec` (Step 2 → 3) → `FeatureBlueprint` + `SynthesisBundle` (Step 3 → UI).

What changed from the old plan, and why:
- There is a new **`FeatureSpec`** between REA and code. Requirements and tests are produced (and checked against the original code) by Step 2. Code is written only in Step 3.
- `clean_room_implementation` → `implementation`. It is an LLM implementation checked by tests, not a legal clean room. Don't claim one.
- `confidence_score`, `inventory_coverage`, `body_fingerprint` are **removed**. Nothing measured them. They are replaced by real numbers: REA tool calls with evidence IDs, tests passed, differential cases matched.
- Added `exports` so the synthesizer knows exactly what to import.
- Added `provenance.mode` (`live` / `replay`) so the UI can be honest.
- Streaming events are one discriminated union (`PipelineEvent`) with a `type` field (old docs had two incompatible `stage` lists).

---

## 1. Package setup — `packages/contracts/package.json`

```json
{
  "name": "@splice/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.1.0" }
}
```

There is no build step. The backend (`tsx`) and frontend (Vite) both import the TS source directly.

`packages/contracts/src/index.ts`:

```ts
export * from "./pantry";
export * from "./evidence";
export * from "./spec";
export * from "./blueprint";
export * from "./events";
export * from "./synthesis";
```

---

## 2. `src/pantry.ts` — what the user can pick

```ts
import { z } from "zod";

export const ArtifactType = z.enum([
  "electron_asar",     // packaged Electron app archive (primary, live)
  "electron_dir",      // unpacked Electron app directory
  "javascript_bundle", // single JS bundle file
  "dotnet_assembly",   // stretch
  "native_pe",         // stretch, replay-only
  "native_elf",        // stretch, replay-only
  "web_app",           // stretch
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const Category = z.enum([
  "graph", "scheduling", "calculator", "parser", "search", "state_engine", "utility",
]);
export type Category = z.infer<typeof Category>;

export const ReaSeed = z.object({
  kind: z.enum(["module", "symbol"]),
  value: z.string(),               // e.g. "src/graph/wikilinks.js" or "parseWikiLinks"
});
export type ReaSeed = z.infer<typeof ReaSeed>;

export const PantryFeature = z.object({
  feature_id: z.string().regex(/^[a-z0-9]+\.[a-z0-9_]+$/), // "<app_id>.<feature>", e.g. "inkwell.wikilink_graph"
  title: z.string(),                // "Wiki-link graph & backlinks"
  query: z.string(),                // natural-language description given to the harvester
  category: Category,
  seeds: z.array(ReaSeed).min(1),   // where REA starts tracing
  symbols: z.array(z.string()).min(1), // functions that must be reconstructed
});
export type PantryFeature = z.infer<typeof PantryFeature>;

export const PantryApp = z.object({
  app_id: z.string().regex(/^[a-z0-9]+$/), // "inkwell"
  display_name: z.string(),         // "Inkwell Notes"
  icon: z.string(),                 // lucide-react icon name, e.g. "BookOpen"
  description: z.string(),
  artifact_type: ArtifactType,
  target_path: z.string(),          // repo-relative, e.g. "targets/build/inkwell/app.asar"
  live_supported: z.boolean(),      // false → replay only
  features: z.array(PantryFeature).min(1),
});
export type PantryApp = z.infer<typeof PantryApp>;

export const Pantry = z.object({ apps: z.array(PantryApp) });
export type Pantry = z.infer<typeof Pantry>;
```

---

## 3. `src/evidence.ts` — output of Step 1 (Eng 1 → Eng 2)

```ts
import { z } from "zod";
import { ArtifactType } from "./pantry";

export const ToolCallRecord = z.object({
  seq: z.number().int(),                   // 1-based order within the run
  tool: z.string(),                        // real REA tool name
  args: z.record(z.string(), z.unknown()), // exactly what was sent
  ok: z.boolean(),
  duration_ms: z.number(),
  evidence_id: z.string().nullable(),      // structuredContent.evidence_id
  summary: z.string(),                     // ≤ 300 chars, human readable, shown in the terminal
  limitations: z.array(z.string()),        // copied from REA's Evidence
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const SourceSnippet = z.object({
  location: z.string(),                    // "app.asar:src/graph/wikilinks.js" or "Calc.dll!0x140023B80"
  symbol: z.string().nullable(),
  language: z.enum(["javascript", "typescript", "csharp", "c", "asm", "text"]),
  code: z.string(),                        // full module or function text (bridge caps at 40k chars)
  full_module: z.boolean(),                // true → can be executed for differential testing
});
export type SourceSnippet = z.infer<typeof SourceSnippet>;

export const TargetInfo = z.object({
  path: z.string(),                        // repo-relative
  artifact_type: ArtifactType,
  sha256: z.string(),                      // of the target file, computed by us
});
export type TargetInfo = z.infer<typeof TargetInfo>;

export const RawEvidence = z.object({
  app_id: z.string(),
  feature_id: z.string(),
  target: TargetInfo,
  rea_package_version: z.string(),         // "6.7.0"
  mode: z.enum(["live", "replay"]),
  tool_calls: z.array(ToolCallRecord),
  snippets: z.array(SourceSnippet).min(1),
  related_paths: z.array(z.string()),      // modules REA linked to the seed (imports/callers)
  limitations: z.array(z.string()),        // union of tool limitations, de-duplicated
  unknowns: z.array(z.string()),           // things REA said it could not resolve
  collected_at: z.string(),                // ISO timestamp
});
export type RawEvidence = z.infer<typeof RawEvidence>;
```

---

## 4. `src/spec.ts` — output of Step 2 (Eng 2 → Eng 3)

A `FeatureSpec` says **what** the feature must do, never **how**. It contains no implementation
code. The only code in it is type declarations, tests, and the adapter that lets the tests run
against the *original* module.

```ts
import { z } from "zod";
import { Category, ArtifactType } from "./pantry";
import { ToolCallRecord, SourceSnippet, TargetInfo } from "./evidence";

export const Requirement = z.object({
  id: z.string().regex(/^REQ-\d+$/),       // "REQ-4"
  kind: z.enum(["behavior", "invariant", "edge_case", "error"]),
  statement: z.string(),                   // "A grade below 3 resets repetitions to 0 and the interval to 1 day"
  source_refs: z.array(z.string()).min(1), // "src/scheduler/sm2.js:L18-L24" — must point into RawEvidence.snippets
});
export type Requirement = z.infer<typeof Requirement>;

export const IoField = z.object({
  name: z.string(),
  type: z.string(),                        // TS type text, e.g. "CardState"
  description: z.string(),
});
export type IoField = z.infer<typeof IoField>;

export const ExportSig = z.object({
  name: z.string(),                        // "reviewCard"
  kind: z.enum(["function", "type", "const"]),
  signature: z.string(),                   // "(state: CardState, grade: number, today: string) => ReviewResult"
  description: z.string(),
});
export type ExportSig = z.infer<typeof ExportSig>;

export const InterfaceSpec = z.object({
  module_name: z.string().regex(/^[a-z][A-Za-z0-9]*$/), // engine file becomes /engines/<module_name>.ts
  exports: z.array(ExportSig).min(1),
  /** Ambient TS declarations the implementation must satisfy, e.g.
   *  `export interface CardState {...}` and `export declare function reviewCard(...): ReviewResult;` */
  types_code: z.string(),
});
export type InterfaceSpec = z.infer<typeof InterfaceSpec>;

export const TestCaseResult = z.object({
  name: z.string(),
  kind: z.enum(["oracle", "acceptance"]),  // oracle = run vs original via adapter; acceptance = run vs new engine
  passed: z.boolean(),
  error: z.string().nullable(),
  duration_ms: z.number(),
});
export type TestCaseResult = z.infer<typeof TestCaseResult>;

export const OracleCheck = z.object({
  status: z.enum(["passed", "failed", "not_executable"]), // not_executable: native/replay targets
  adapter_code: z.string().nullable(),     // JS: implements the interface by calling the ORIGINAL module
  tests: z.array(TestCaseResult),
  passed: z.number().int(),
  total: z.number().int(),
});
export type OracleCheck = z.infer<typeof OracleCheck>;

export const RequirementCoverage = z.object({
  requirement_id: z.string(),
  test_names: z.array(z.string()),         // COMPUTED by parsing "REQ-n" out of test names, never LLM-claimed
});

export const SpecProvenance = z.object({
  mode: z.enum(["live", "replay"]),        // replay → UI shows REPLAY badge
  target: TargetInfo,
  rea_package_version: z.string(),
  tool_calls: z.array(ToolCallRecord),
  snippets: z.array(SourceSnippet),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  collected_at: z.string(),
  specified_at: z.string(),
  model: z.string(),
});
export type SpecProvenance = z.infer<typeof SpecProvenance>;

export const FeatureSpec = z.object({
  schema_version: z.literal(1),
  feature_id: z.string(),
  app_id: z.string(),
  source_app: z.string(),                  // "Recall Flashcards"
  source_icon: z.string(),                 // lucide icon name
  artifact_type: ArtifactType,
  consumer_title: z.string(),
  consumer_description: z.string(),
  category: Category,
  requirements: z.array(Requirement).min(1),
  interface: InterfaceSpec,
  inputs: z.array(IoField),
  outputs: z.array(IoField),
  /** Uses sandbox globals test()/assert and the interface's exports as globals.
   *  Every test name starts with the requirement IDs it covers: test("REQ-4 REQ-5: lapse ...", ...) */
  acceptance_tests: z.string(),
  coverage: z.array(RequirementCoverage),  // computed
  allowed_deviations: z.array(z.string()), // "clock is injected as `today` instead of Date.now()"
  stripped_glue: z.array(z.string()),      // platform code deliberately left out: "ipcMain.handle('card:answer')", "fs deck storage"
  oracle: OracleCheck,
  status: z.enum(["verified", "unverified"]), // verified ⇔ oracle passed && every requirement covered && no open issues
  open_issues: z.array(z.string()),        // why it's unverified (shown on the card); empty when verified
  repair_attempts: z.number().int(),
  provenance: SpecProvenance,
});
export type FeatureSpec = z.infer<typeof FeatureSpec>;
```

---

## 5. `src/blueprint.ts` — output of Step 3a (engine), consumed by synthesis + UI

```ts
import { z } from "zod";
import { FeatureSpec, TestCaseResult } from "./spec";

export const EngineImplementation = z.object({
  module_name: z.string(),                 // === spec.interface.module_name
  portable_code: z.string(),               // pure TS, zero imports, deterministic
  notes: z.array(z.string()),              // implementer's notes (shown in evidence drawer)
});
export type EngineImplementation = z.infer<typeof EngineImplementation>;

export const EngineVerification = z.object({
  status: z.enum(["passed", "failed"]),
  tests: z.array(TestCaseResult),          // kind "acceptance"
  passed: z.number().int(),
  total: z.number().int(),
  purity_violations: z.array(z.string()),  // must be empty for "passed"
  type_errors: z.array(z.string()),        // conformance to spec.interface.types_code; must be empty
  repair_attempts: z.number().int(),
  duration_ms: z.number(),
  implemented_at: z.string(),
  model: z.string(),
  mode: z.enum(["live", "replay"]),
});
export type EngineVerification = z.infer<typeof EngineVerification>;

export const FeatureBlueprint = z.object({
  schema_version: z.literal(1),
  feature_id: z.string(),
  spec: FeatureSpec,
  implementation: EngineImplementation,
  verification: EngineVerification,
});
export type FeatureBlueprint = z.infer<typeof FeatureBlueprint>;
```

---

## 6. `src/events.ts` — streaming protocol for `/api/extract` and `/api/implement`

Wire format: Server-Sent Events over a **POST** response, read with `fetch`. (`EventSource`
only does GET, so it can't be used.)

```
event: <type>\n
data: <single-line JSON of the event>\n
\n
```
The server also sends a comment line `: ping\n\n` every 15s.

```ts
import { z } from "zod";
import { FeatureSpec } from "./spec";
import { FeatureBlueprint } from "./blueprint";

export const PipelineStage = z.enum([
  // Step 1 (Eng 1)
  "queued", "connecting", "analyzing", "tracing", "reading_source",
  // Step 2 (Eng 2)
  "specifying", "checking_oracle", "repairing_spec",
  // Step 3a (Eng 3)
  "implementing", "testing", "repairing_engine",
  // terminal
  "complete", "failed",
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

const base = { run_id: z.string(), feature_id: z.string(), ts: z.number() };

export const PipelineEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), ...base, stage: PipelineStage, message: z.string() }),
  z.object({ type: z.literal("tool_call"), ...base, seq: z.number(), tool: z.string(), args_preview: z.string() }),
  z.object({ type: z.literal("tool_result"), ...base, seq: z.number(), tool: z.string(), ok: z.boolean(),
             duration_ms: z.number(), summary: z.string(), evidence_id: z.string().nullable() }),
  z.object({ type: z.literal("llm_progress"), ...base,
             phase: z.enum(["specifying", "repairing_spec", "implementing", "repairing_engine"]),
             output_chars: z.number() }),
  z.object({ type: z.literal("test_result"), ...base, name: z.string(), kind: z.enum(["oracle", "acceptance"]),
             passed: z.boolean(), error: z.string().nullable() }),
  z.object({ type: z.literal("spec"), ...base, spec: FeatureSpec }),
  z.object({ type: z.literal("blueprint"), ...base, blueprint: FeatureBlueprint }),
  z.object({ type: z.literal("error"), ...base, message: z.string(), fatal: z.boolean() }),
  z.object({ type: z.literal("done"), ...base, ok: z.boolean(), replayed: z.boolean() }),
]);
export type PipelineEvent = z.infer<typeof PipelineEvent>;

export const ExtractRequest = z.object({
  app_id: z.string(),
  feature_id: z.string(),
  force_mode: z.enum(["live", "replay"]).optional(), // dev override only
});
export type ExtractRequest = z.infer<typeof ExtractRequest>;

export const ImplementRequest = z.object({
  spec: FeatureSpec,
  force_mode: z.enum(["live", "replay"]).optional(),
});
export type ImplementRequest = z.infer<typeof ImplementRequest>;
```

---

## 7. `src/synthesis.ts` — Step 3b contracts (fused app)

```ts
import { z } from "zod";
import { FeatureBlueprint } from "./blueprint";

/** Paths the LLM is allowed to write. Engines and entry files are written by the server only. */
export const GENERATED_PATH = /^\/(App\.tsx|components\/[A-Za-z0-9_-]+\.tsx|lib\/[A-Za-z0-9_-]+\.ts|data\/seed\.ts)$/;

/** npm packages generated code may import (plus relative imports). Versions pinned server-side. */
export const ALLOWED_DEPENDENCIES = {
  "react": "18.3.1",
  "react-dom": "18.3.1",
  "lucide-react": "0.344.0",
  "canvas-confetti": "1.9.3",
} as const;

export const SynthesizeRequest = z.object({
  blueprints: z.array(FeatureBlueprint).min(1).max(4),
  prompt: z.string().min(3).max(2000),
});
export type SynthesizeRequest = z.infer<typeof SynthesizeRequest>;

export const SynthesisBundle = z.object({
  bundle_id: z.string(),
  app_title: z.string(),
  app_description: z.string(),
  files: z.record(z.string(), z.string()),   // full Sandpack file map, including engines
  dependencies: z.record(z.string(), z.string()),
  engine_paths: z.array(z.string()),         // ["/engines/sm2Scheduler.ts", ...] — read-only in the UI
  generated_paths: z.array(z.string()),
  feature_ids: z.array(z.string()),
  warnings: z.array(z.string()),
  mode: z.enum(["live", "replay"]),
  revision: z.number().int(),                // 0 = first synthesis, +1 per refine
});
export type SynthesisBundle = z.infer<typeof SynthesisBundle>;

export const RefineRequest = z.object({
  bundle: SynthesisBundle,
  blueprints: z.array(FeatureBlueprint),
  kind: z.enum(["edit", "fix"]),
  prompt: z.string().max(2000),              // user instruction (edit) or "" (fix)
  runtime_error: z.string().nullable(),      // Sandpack error text for kind "fix"
});
export type RefineRequest = z.infer<typeof RefineRequest>;

export const SynthStage = z.enum(["designing", "generating", "validating", "fixing", "complete", "failed"]);

const base = { run_id: z.string(), ts: z.number() };
export const SynthEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), ...base, stage: SynthStage, message: z.string() }),
  z.object({ type: z.literal("llm_progress"), ...base, output_chars: z.number() }),
  z.object({ type: z.literal("validation"), ...base, ok: z.boolean(), errors: z.array(z.string()) }),
  z.object({ type: z.literal("bundle"), ...base, bundle: SynthesisBundle }),
  z.object({ type: z.literal("error"), ...base, message: z.string(), fatal: z.boolean() }),
  z.object({ type: z.literal("done"), ...base, ok: z.boolean() }),
]);
export type SynthEvent = z.infer<typeof SynthEvent>;

export const HealthResponse = z.object({
  ok: z.boolean(),
  rea: z.object({ connected: z.boolean(), version: z.string().nullable(), tool_count: z.number() }),
  rea_mode: z.enum(["live", "replay", "auto"]),
  llm_mode: z.enum(["live", "replay"]),
  model: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
```

---

## 8. HTTP API summary

| Method | Path | Body | Response | Owner |
|---|---|---|---|---|
| GET | `/api/health` | – | `HealthResponse` | Eng 1 |
| GET | `/api/pantry` | – | `Pantry` | Eng 1 |
| POST | `/api/extract` | `ExtractRequest` | SSE `PipelineEvent` stream: Step 1 events, then Step 2 events, ending with a `spec` event | Eng 2 (calls Eng 1's collector) |
| GET | `/api/specs` | – | `FeatureSpec[]` from `fixtures/specs` | Eng 2 |
| POST | `/api/implement` | `ImplementRequest` | SSE `PipelineEvent` stream ending with a `blueprint` event | Eng 3 |
| GET | `/api/blueprints` | – | `FeatureBlueprint[]` from `fixtures/blueprints` | Eng 3 |
| POST | `/api/synthesize` | `SynthesizeRequest` | SSE `SynthEvent` stream | Eng 3 |
| POST | `/api/refine` | `RefineRequest` | SSE `SynthEvent` stream | Eng 3 |

The frontend chains `/api/extract` → `/api/implement` for each selected feature, so a card goes
**Harvesting → Spec verified → Engine passing** in front of the judges.

The backend runs on `http://localhost:3001`; Vite proxies `/api` to it.

---

## 9. Reference fixtures (hand-written seeds, used until live recordings exist)

These seeds let Eng 2 and Eng 3 start before Step 1 works. They live in `fixtures/specs/_seed/` and
`fixtures/blueprints/_seed/`, have `provenance.mode: "replay"`, and are deleted at CP2. The
original module they describe is `targets/src/recall/src/scheduler/sm2.js` (see
`1_reverse_engineering/02_demo_targets.md`).

### 9.1 `FeatureSpec` for `recall.sm2_scheduler`

`requirements`:

| id | kind | statement | source_refs |
|---|---|---|---|
| REQ-1 | behavior | A successful review (grade ≥ 3) of a new card (0 repetitions) sets the interval to 1 day and repetitions to 1 | `src/scheduler/sm2.js:L21-L23` |
| REQ-2 | behavior | A second consecutive successful review sets the interval to 6 days | `src/scheduler/sm2.js:L21-L23` |
| REQ-3 | behavior | Later successful reviews multiply the previous interval by the *previous* ease factor and round to the nearest day | `src/scheduler/sm2.js:L21-L23` |
| REQ-4 | behavior | A failed review (grade < 3) resets repetitions to 0, sets the interval to 1 day and increments lapses | `src/scheduler/sm2.js:L24-L28` |
| REQ-5 | invariant | The new ease is `ease + (0.1 − (5−q)(0.08 + (5−q)·0.02))`, rounded to 2 decimals, never below 1.3 | `src/scheduler/sm2.js:L9-L12` |
| REQ-6 | behavior | The due date is the review date plus the interval in days | `src/scheduler/sm2.js:L30` |
| REQ-7 | behavior | A card becomes a leech once it has 8 or more lapses | `src/scheduler/sm2.js:L31` |
| REQ-8 | error | Grades that are not integers from 0 to 5 throw a `RangeError` | `src/scheduler/sm2.js:L4-L8` |

`interface.types_code`:

```ts
export interface CardState {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  lapses: number;
}
export interface ReviewResult extends CardState {
  dueDate: string; // YYYY-MM-DD
  isLeech: boolean;
}
export declare function reviewCard(state: CardState, grade: number, today: string): ReviewResult;
export declare function nextEaseFactor(ease: number, grade: number): number;
```

`acceptance_tests` (globals: `test`, `assert`, plus every export of the module under test):

```ts
const NEW_CARD = { repetitions: 0, intervalDays: 0, easeFactor: 2.5, lapses: 0 };

test("REQ-1 REQ-6: first successful review is due tomorrow", () => {
  const r = reviewCard(NEW_CARD, 5, "2026-10-24");
  assert.equal(r.repetitions, 1);
  assert.equal(r.intervalDays, 1);
  assert.equal(r.dueDate, "2026-10-25");
});

test("REQ-2 REQ-6: second successful review is due in 6 days", () => {
  const r = reviewCard({ repetitions: 1, intervalDays: 1, easeFactor: 2.6, lapses: 0 }, 4, "2026-10-24");
  assert.equal(r.intervalDays, 6);
  assert.equal(r.dueDate, "2026-10-30");
});

test("REQ-3: later reviews use the previous ease factor", () => {
  const r = reviewCard({ repetitions: 2, intervalDays: 6, easeFactor: 2.5, lapses: 0 }, 3, "2026-10-24");
  assert.equal(r.intervalDays, 15);
  assert.equal(r.repetitions, 3);
});

test("REQ-4 REQ-5: a lapse resets the card and lowers ease", () => {
  const r = reviewCard({ repetitions: 3, intervalDays: 15, easeFactor: 2.2, lapses: 1 }, 2, "2026-10-24");
  assert.equal(r.repetitions, 0);
  assert.equal(r.intervalDays, 1);
  assert.equal(r.lapses, 2);
  assert.equal(r.easeFactor, 1.88);
});

test("REQ-5: ease never drops below 1.3", () => {
  assert.equal(nextEaseFactor(1.3, 0), 1.3);
  assert.equal(nextEaseFactor(2.5, 5), 2.6);
});

test("REQ-7: eighth lapse marks a leech", () => {
  const r = reviewCard({ repetitions: 2, intervalDays: 6, easeFactor: 1.5, lapses: 7 }, 1, "2026-10-24");
  assert.equal(r.lapses, 8);
  assert.equal(r.isLeech, true);
});

test("REQ-8: invalid grades are rejected", () => {
  assert.throws(() => reviewCard(NEW_CARD, 6, "2026-10-24"));
  assert.throws(() => reviewCard(NEW_CARD, 2.5, "2026-10-24"));
});
```

`oracle.adapter_code`. This is plain JS run in the sandbox, where `original(path)` loads a module
from the evidence snippets:

```js
const { scheduleReview, updateEase } = original("src/scheduler/sm2.js");
const DAY_MS = 86400000;

function reviewCard(state, grade, today) {
  const now = Date.parse(today + "T00:00:00Z");
  const r = scheduleReview(
    { reps: state.repetitions, interval: state.intervalDays, ease: state.easeFactor, lapses: state.lapses, due: now },
    grade,
    now,
  );
  return {
    repetitions: r.reps,
    intervalDays: r.interval,
    easeFactor: r.ease,
    lapses: r.lapses,
    dueDate: new Date(r.due).toISOString().slice(0, 10),
    isLeech: r.leech,
  };
}

function nextEaseFactor(ease, grade) {
  return updateEase(ease, grade);
}

module.exports = { reviewCard, nextEaseFactor };
```

`status`: `"verified"`, `open_issues`: `[]`, `coverage`: computed from test names (every REQ covered).

`stripped_glue`: `["Electron IPC handlers in src/main.js (card:answer, stats:streak)", "JSON deck persistence in src/db/deckStore.js"]`

`allowed_deviations`: `["The clock is injected as today (YYYY-MM-DD) instead of epoch milliseconds", "Field names are renamed for readability (reps → repetitions, interval → intervalDays, ease → easeFactor, leech → isLeech)"]`

### 9.2 `FeatureBlueprint.implementation.portable_code` for the same feature (Step 3 output)

```ts
export interface CardState {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  lapses: number;
}

export interface ReviewResult extends CardState {
  dueDate: string;
  isLeech: boolean;
}

const MIN_EASE = 1.3;
const LEECH_THRESHOLD = 8;

function assertGrade(grade: number): number {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) {
    throw new RangeError("grade must be an integer from 0 to 5");
  }
  return grade;
}

export function nextEaseFactor(ease: number, grade: number): number {
  const q = assertGrade(grade);
  const next = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  return Math.max(MIN_EASE, Math.round(next * 100) / 100);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function reviewCard(state: CardState, grade: number, today: string): ReviewResult {
  const q = assertGrade(grade);
  let { repetitions, intervalDays, lapses } = state;
  if (q >= 3) {
    intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 6 : Math.round(intervalDays * state.easeFactor);
    repetitions += 1;
  } else {
    repetitions = 0;
    intervalDays = 1;
    lapses += 1;
  }
  return {
    repetitions,
    intervalDays,
    easeFactor: nextEaseFactor(state.easeFactor, q),
    lapses,
    dueDate: addDays(today, intervalDays),
    isLeech: lapses >= LEECH_THRESHOLD,
  };
}
```

> Note: `nextEaseFactor` in the original (`updateEase`) does not validate the grade. REQ-8 only
> covers `reviewCard`, so the oracle passes. A test calling `nextEaseFactor(2.5, 9)` and expecting
> a throw would **fail against the original**. That is exactly the kind of invented requirement
> the oracle check exists to catch.
