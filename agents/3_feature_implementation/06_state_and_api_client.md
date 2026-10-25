# 06 — State, API Client & Pipeline Orchestration

> **Core Studio milestone:** setup, typed API/SSE, Zustand orchestration, development seeds, pantry/log/cards/evidence/fusion, and Sandpack preview/code are implemented. The vanilla store in `store/studioState.ts` is wrapped by `useStudio.ts`; live and development adapters share `Api`. Live integration still waits on upstream helpers. Refinement/auto-fix/export and isolation URLs remain later work. See [measured acceptance](../../docs/STEP3_MILESTONE.md). The examples below remain the design reference; implementation details are adapted to the existing contracts.

## 1. `src/api/sse.ts` — POST + Server-Sent Events

`EventSource` can't POST, so we read the stream with `fetch`.

```ts
import type { ZodType } from "zod";

export async function streamPost<E>(
  url: string,
  body: unknown,
  onEvent: (e: E) => void,
  opts: { signal?: AbortSignal; schema?: ZodType<E> } = {},
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`${url} → ${res.status} ${await res.text().catch(() => "")}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;                       // ": ping" comments
      const json = JSON.parse(data);
      onEvent(opts.schema ? opts.schema.parse(json) : (json as E));
    }
  }
}
```

Validate with the contract schemas in dev (`schema: PipelineEvent`). Skip it in production
builds if parsing large blueprints causes jank.

## 2. `src/api/client.ts`

```ts
import { PipelineEvent, SynthEvent, type FeatureSpec, type FeatureBlueprint, type SynthesisBundle,
         type Pantry, type HealthResponse, type RefineRequest } from "@splice/contracts";
import { streamPost } from "./sse";
import { mockApi } from "./mock";

const live = {
  health: (): Promise<HealthResponse> => fetch("/api/health").then((r) => r.json()),
  pantry: (): Promise<Pantry> => fetch("/api/pantry").then((r) => r.json()),
  extract: (app_id: string, feature_id: string, on: (e: PipelineEvent) => void, signal?: AbortSignal) =>
    streamPost("/api/extract", { app_id, feature_id }, on, { signal, schema: PipelineEvent }),
  implement: (spec: FeatureSpec, on: (e: PipelineEvent) => void, signal?: AbortSignal) =>
    streamPost("/api/implement", { spec }, on, { signal, schema: PipelineEvent }),
  synthesize: (blueprints: FeatureBlueprint[], prompt: string, on: (e: SynthEvent) => void, signal?: AbortSignal) =>
    streamPost("/api/synthesize", { blueprints, prompt }, on, { signal, schema: SynthEvent }),
  refine: (req: RefineRequest, on: (e: SynthEvent) => void, signal?: AbortSignal) =>
    streamPost("/api/refine", req, on, { signal, schema: SynthEvent }),
};

export type Api = typeof live;
export const api: Api = import.meta.env.VITE_API_MODE === "mock" ? mockApi : live;
```

## 3. `src/store/useStudio.ts` — state shape

```ts
import { create } from "zustand";
import type { Pantry, HealthResponse, FeatureSpec, FeatureBlueprint, SynthesisBundle,
              PipelineEvent, SynthEvent } from "@splice/contracts";
import { api } from "../api/client";

export type CardPhase =
  | "queued" | "harvesting" | "specifying" | "spec_ready" | "implementing" | "ready" | "failed";

export interface Card {
  feature_id: string;
  app_id: string;
  title: string;
  phase: CardPhase;
  stageMessage: string;
  spec?: FeatureSpec;
  blueprint?: FeatureBlueprint;
  oracleResults: Record<string, boolean>;      // test name → passed vs ORIGINAL
  engineResults: Record<string, boolean>;      // test name → passed vs ENGINE
  replayed: boolean;
  error?: string;
  includeInFusion: boolean;
}

export interface LogLine {
  id: number;
  ts: number;
  feature_id: string;
  kind: "stage" | "call" | "result" | "test" | "error" | "info";
  text: string;
  ok?: boolean;
}

interface StudioState {
  health?: HealthResponse;
  pantry?: Pantry;
  selected: string[];                           // feature_ids chosen in the pantry
  cards: Record<string, Card>;
  log: LogLine[];
  harvesting: boolean;

  prompt: string;
  synth: {
    status: "idle" | "running" | "ready" | "failed";
    stage: string;
    outputChars: number;
    bundle?: SynthesisBundle;
    validationErrors: string[];
    error?: string;
    chat: { role: "user" | "assistant"; text: string }[];
    autoFixUsedFor: string | null;              // bundle_id
  };

  init(): Promise<void>;
  toggleFeature(featureId: string): void;
  toggleFusion(featureId: string): void;
  setPrompt(p: string): void;
  harvest(): Promise<void>;
  fuse(): Promise<void>;
  refine(kind: "edit" | "fix", text: string): Promise<void>;
}
```

## 4. Orchestration — the important part

```ts
let logId = 0;

export const useStudio = create<StudioState>((set, get) => {
  const log = (l: Omit<LogLine, "id" | "ts">) =>
    set((s) => ({ log: [...s.log.slice(-400), { ...l, id: ++logId, ts: Date.now() }] }));
  const patchCard = (id: string, p: Partial<Card>) =>
    set((s) => ({ cards: { ...s.cards, [id]: { ...s.cards[id], ...p } } }));

  /** Shared handler for /api/extract and /api/implement event streams. */
  const onPipelineEvent = (e: PipelineEvent) => {
    const id = e.feature_id;
    switch (e.type) {
      case "stage":
        log({ feature_id: id, kind: "stage", text: e.message });
        patchCard(id, {
          stageMessage: e.message,
          ...(e.stage === "specifying" ? { phase: "specifying" as const } : {}),
          ...(e.stage === "implementing" ? { phase: "implementing" as const } : {}),
        });
        break;
      case "tool_call":
        log({ feature_id: id, kind: "call", text: `▸ ${e.tool} ${e.args_preview}` });
        break;
      case "tool_result":
        log({ feature_id: id, kind: "result", ok: e.ok,
              text: `◂ ${e.tool} ${e.ok ? "ok" : "FAILED"} ${(e.duration_ms / 1000).toFixed(1)}s — ${e.summary}${e.evidence_id ? ` [${e.evidence_id.slice(0, 11)}…]` : ""}` });
        break;
      case "test_result": {
        const key = e.kind === "oracle" ? "oracleResults" : "engineResults";
        const card = get().cards[id];
        patchCard(id, { [key]: { ...card[key], [e.name]: e.passed } } as Partial<Card>);
        log({ feature_id: id, kind: "test", ok: e.passed,
              text: `${e.passed ? "✓" : "✗"} ${e.name} ${e.kind === "oracle" ? "(vs original)" : "(vs engine)"}${e.error ? ` — ${e.error}` : ""}` });
        break;
      }
      case "spec":
        patchCard(id, { spec: e.spec, phase: "spec_ready", replayed: e.spec.provenance.mode === "replay" });
        break;
      case "blueprint":
        patchCard(id, { blueprint: e.blueprint, phase: e.blueprint.verification.status === "passed" ? "ready" : "failed",
                        replayed: get().cards[id].replayed || e.blueprint.verification.mode === "replay" });
        break;
      case "error":
        log({ feature_id: id, kind: "error", text: e.message });
        if (e.fatal) patchCard(id, { phase: "failed", error: e.message });
        break;
      case "done":
        if (e.replayed) patchCard(id, { replayed: true });
        break;
      case "llm_progress":
        patchCard(id, { stageMessage: `${e.phase.replace("_", " ")}… ${e.output_chars.toLocaleString()} chars` });
        break;
    }
  };

  /** One feature: extract (Steps 1+2) then implement (Step 3a). */
  const runFeature = async (featureId: string) => {
    const app = get().pantry!.apps.find((a) => a.features.some((f) => f.feature_id === featureId))!;
    patchCard(featureId, { phase: "harvesting" });
    try {
      await api.extract(app.app_id, featureId, onPipelineEvent);
      const spec = get().cards[featureId].spec;
      if (!spec) throw new Error("extraction finished without a spec");
      await api.implement(spec, onPipelineEvent);
    } catch (err) {
      patchCard(featureId, { phase: "failed", error: (err as Error).message });
      log({ feature_id: featureId, kind: "error", text: (err as Error).message });
    }
  };

  return {
    selected: [],
    cards: {},
    log: [],
    harvesting: false,
    prompt: "",
    synth: { status: "idle", stage: "", outputChars: 0, validationErrors: [], chat: [], autoFixUsedFor: null },

    async init() {
      const [health, pantry] = await Promise.all([api.health().catch(() => undefined), api.pantry()]);
      set({ health, pantry });
    },

    toggleFeature(id) {
      set((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] }));
    },
    toggleFusion(id) { patchCard(id, { includeInFusion: !get().cards[id].includeInFusion }); },
    setPrompt(p) { set({ prompt: p }); },

    async harvest() {
      const { selected, pantry } = get();
      const cards = { ...get().cards };
      for (const id of selected) {
        const app = pantry!.apps.find((a) => a.features.some((f) => f.feature_id === id))!;
        const f = app.features.find((f) => f.feature_id === id)!;
        cards[id] = { feature_id: id, app_id: app.app_id, title: f.title, phase: "queued", stageMessage: "Queued",
                      oracleResults: {}, engineResults: {}, replayed: false, includeInFusion: true };
      }
      set({ cards, harvesting: true });
      // Features run IN PARALLEL. The backend serializes REA calls on its single MCP connection,
      // but the Bedrock steps (spec, engine) overlap, which roughly halves wall-clock time.
      await Promise.all(selected.map(runFeature));
      set({ harvesting: false });
    },

    async fuse() {
      const blueprints = Object.values(get().cards).filter((c) => c.includeInFusion && c.blueprint).map((c) => c.blueprint!);
      set((s) => ({ synth: { ...s.synth, status: "running", stage: "Starting…", outputChars: 0, bundle: undefined, validationErrors: [], error: undefined, chat: [] } }));
      await api.synthesize(blueprints, get().prompt, (e) => applySynthEvent(e, set, get)).catch((err) =>
        set((s) => ({ synth: { ...s.synth, status: "failed", error: (err as Error).message } })));
    },

    async refine(kind, text) {
      const { synth, cards } = get();
      if (!synth.bundle) return;
      const blueprints = synth.bundle.feature_ids.map((id) => cards[id]?.blueprint).filter(Boolean) as FeatureBlueprint[];
      if (kind === "edit") set((s) => ({ synth: { ...s.synth, chat: [...s.synth.chat, { role: "user", text }] } }));
      if (kind === "fix") set((s) => ({ synth: { ...s.synth, autoFixUsedFor: synth.bundle!.bundle_id } }));
      set((s) => ({ synth: { ...s.synth, status: "running" } }));
      await api.refine({ bundle: synth.bundle, blueprints, kind, prompt: kind === "edit" ? text : "", runtime_error: kind === "fix" ? text : null },
        (e) => applySynthEvent(e, set, get)).catch((err) =>
        set((s) => ({ synth: { ...s.synth, status: "failed", error: (err as Error).message } })));
    },
  };
});

function applySynthEvent(e: SynthEvent, set: any, get: () => StudioState) {
  const s = get().synth;
  switch (e.type) {
    case "stage":
      set({ synth: { ...s, stage: e.message,
        ...(e.stage === "complete" && s.chat.length && s.chat[s.chat.length - 1].role === "user"
          ? { chat: [...s.chat, { role: "assistant", text: e.message }] } : {}) } });
      break;
    case "llm_progress": set({ synth: { ...s, outputChars: e.output_chars } }); break;
    case "validation": set({ synth: { ...s, validationErrors: e.errors } }); break;
    case "bundle": set({ synth: { ...s, bundle: e.bundle, status: "ready" } }); break;
    case "error": if (e.fatal) set({ synth: { ...s, status: "failed", error: e.message } }); break;
    case "done": if (!e.ok && get().synth.status === "running") set({ synth: { ...get().synth, status: "failed" } }); break;
  }
}
```

## 5. Mock mode — `src/api/mock.ts` (no backend)

Plays recorded transcripts from `fixtures/` with their timing. Until real recordings exist, it
generates a plausible stream from the `_seed` spec and blueprint. Implements the same `Api` shape.

```ts
import type { Api } from "./client";
import pantry from "../../../../targets/manifest.json";

const transcripts = import.meta.glob("@fixtures/transcripts/**/*.json", { eager: true, import: "default" }) as Record<string, any>;
const seedSpecs = import.meta.glob("@fixtures/specs/_seed/*.json", { eager: true, import: "default" }) as Record<string, any>;
const seedBps = import.meta.glob("@fixtures/blueprints/_seed/*.json", { eager: true, import: "default" }) as Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const find = (kind: string, key: string) =>
  Object.entries(transcripts).find(([p]) => p.includes(`/transcripts/${kind}/${key}.`))?.[1];

async function play(rec: { events: any[] }, on: (e: any) => void) {
  let prev = rec.events[0]?.ts ?? 0;
  for (const e of rec.events) {
    await sleep(Math.min(e.ts - prev, 1200));
    prev = e.ts;
    on({ ...e, ts: Date.now() });
  }
}

export const mockApi: Api = {
  health: async () => ({ ok: true, rea: { connected: true, version: "mock", tool_count: 0 }, rea_mode: "replay", llm_mode: "replay", model: "mock" }),
  pantry: async () => pantry as any,
  extract: async (_app, featureId, on) => {
    const rec = find("extract", featureId);
    if (rec) return play(rec, on);
    const spec = Object.values(seedSpecs).find((s: any) => s.feature_id === featureId);
    const base = { run_id: "mock", feature_id: featureId };
    for (const [stage, message] of [["connecting", "Connecting to REA…"], ["analyzing", "Analyzing app.asar"], ["tracing", "Tracing feature"], ["specifying", "Deriving requirements"], ["checking_oracle", "Running tests vs original"]]) {
      await sleep(500);
      on({ type: "stage", ...base, ts: Date.now(), stage, message });
    }
    if (spec) on({ type: "spec", ...base, ts: Date.now(), spec });
    on({ type: "done", ...base, ts: Date.now(), ok: !!spec, replayed: true });
  },
  implement: async (spec, on) => {
    const rec = find("implement", spec.feature_id);
    if (rec) return play(rec, on);
    const bp = Object.values(seedBps).find((b: any) => b.feature_id === spec.feature_id);
    const base = { run_id: "mock", feature_id: spec.feature_id };
    await sleep(800);
    if (bp) on({ type: "blueprint", ...base, ts: Date.now(), blueprint: bp });
    on({ type: "done", ...base, ts: Date.now(), ok: !!bp, replayed: true });
  },
  synthesize: async (blueprints, _prompt, on) => {
    const rec = Object.entries(transcripts).find(([p]) => p.includes("/transcripts/synthesize/"))?.[1];
    if (rec) return play(rec, on);
    on({ type: "error", run_id: "mock", ts: Date.now(), message: "No recorded synthesis in fixtures yet", fatal: true });
  },
  refine: async (_req, on) => {
    on({ type: "error", run_id: "mock", ts: Date.now(), message: "Refine is not available in mock mode", fatal: true });
  },
};
```

> The `targets/manifest.json` import path is relative to `src/api/`. Adjust if your layout
> differs, or add an alias like `@fixtures`.
